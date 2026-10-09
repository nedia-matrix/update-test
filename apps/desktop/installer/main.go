// A fixed, standalone program shipped with the application. No downloaded code is executed.
package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

type Request struct {
	ID             string `json:"id"`
	ParentPID      int    `json:"parentPid"`
	Platform       string `json:"platform"`
	Arch           string `json:"arch"`
	Distribution   string `json:"distribution"`
	CurrentVersion string `json:"currentVersion"`
	Version        string `json:"version"`
	AppID          string `json:"appId"`
	Package        string `json:"package"`
	Target         string `json:"target"`
	Size           int64  `json:"size"`
	SHA256         string `json:"sha256"`
}
type Journal struct {
	Request      Request `json:"request"`
	Stage        string  `json:"stage"`
	Error        string  `json:"error,omitempty"`
	Backup       string  `json:"backup"`
	Staged       string  `json:"staged"`
	StagedDigest string  `json:"stagedDigest,omitempty"`
}
type Installer struct {
	directory string
	journal   Journal
	launch    func(string) error
}

func (i *Installer) save(stage string) error {
	i.journal.Stage = stage
	data, err := json.MarshalIndent(i.journal, "", "  ")
	if err != nil {
		return err
	}
	return durableWrite(filepath.Join(i.directory, "journal.json"), data)
}
func durableWrite(path string, data []byte) error {
	temporary := path + ".tmp"
	f, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(temporary, path); err != nil {
		return err
	}
	// Directory sync is unavailable on Windows. The file itself was flushed above.
	if runtime.GOOS != "windows" {
		d, err := os.Open(filepath.Dir(path))
		if err != nil {
			return err
		}
		defer d.Close()
		return d.Sync()
	}
	return nil
}
func regular(path string) error {
	st, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return errors.New("expected a regular file")
	}
	return nil
}
func verify(path string, size int64, digest string) error {
	if err := regular(path); err != nil {
		return err
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return err
	}
	if n != size || hex.EncodeToString(h.Sum(nil)) != digest {
		return errors.New("package size or SHA-256 mismatch")
	}
	return nil
}
func exists(path string) bool { _, err := os.Lstat(path); return err == nil }
func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel)
}
func canonical(path string) error {
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	if filepath.Clean(real) != path || !filepath.IsAbs(path) {
		return errors.New("path is not canonical")
	}
	return nil
}
func load(requestFile string, recovery bool) (*Installer, error) {
	if err := canonical(requestFile); err != nil {
		return nil, err
	}
	if err := regular(requestFile); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(requestFile)
	if err != nil || len(data) > 16384 {
		return nil, errors.New("invalid request size")
	}
	var r Request
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, err
	}
	if len(r.ID) != 36 || strings.ContainsAny(r.ID, `/\`) || r.ParentPID < 1 || r.AppID != "com.nediamatrix.desktop" || r.Size <= 0 || len(r.SHA256) != 64 {
		return nil, errors.New("invalid request identity")
	}
	if err := canonical(r.Package); err != nil {
		return nil, err
	}
	if recovery {
		if err := canonical(filepath.Dir(r.Target)); err != nil {
			return nil, err
		}
	} else if err := canonical(r.Target); err != nil {
		return nil, err
	}
	directory := filepath.Dir(requestFile)
	if filepath.Base(directory) != r.ID || filepath.Base(requestFile) != "request.json" || within(r.Target, directory) || within(r.Target, r.Package) {
		return nil, errors.New("unsafe request location")
	}
	if (runtime.GOOS == "darwin" && (r.Platform != "darwin" || r.Distribution != "app-zip" || !strings.HasSuffix(r.Target, ".app"))) ||
		(runtime.GOOS == "windows" && (r.Platform != "win32" || (r.Distribution != "portable" && r.Distribution != "nsis") || !strings.HasSuffix(strings.ToLower(r.Target), ".exe"))) {
		return nil, errors.New("unsupported target")
	}
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		return nil, errors.New("unsupported operating system")
	}
	staged := r.Target + ".nedia-stage-" + r.ID
	if runtime.GOOS == "windows" {
		staged += ".exe"
	}
	if r.Distribution == "nsis" {
		staged = filepath.Join(directory, "setup.exe")
	}
	return &Installer{directory: directory, journal: Journal{Request: r, Backup: r.Target + ".nedia-backup-" + r.ID, Staged: staged}}, nil
}
func copyFile(source, destination string, mode os.FileMode) error {
	src, err := os.Open(source)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	_, err = io.Copy(dst, src)
	if err == nil {
		err = dst.Sync()
	}
	closeErr := dst.Close()
	if err != nil {
		return err
	}
	return closeErr
}

// Validate all names and link destinations BEFORE extraction; never extract through a symlink.
func extractApp(source, destination string, budget uint64) error {
	z, err := zip.OpenReader(source)
	if err != nil {
		return err
	}
	defer z.Close()
	var links []*zip.File
	names := map[string]bool{}
	var total uint64
	for _, f := range z.File {
		name := f.Name
		if strings.Contains(name, "\\") || strings.HasPrefix(name, "/") || strings.ContainsRune(name, 0) || strings.Contains(name, ":") {
			return errors.New("unsafe ZIP path")
		}
		clean := strings.TrimSuffix(name, "/")
		if clean != filepath.ToSlash(filepath.Clean(clean)) || (clean != "NediaMatrix.app" && !strings.HasPrefix(clean, "NediaMatrix.app/")) {
			return errors.New("ZIP must contain only NediaMatrix.app")
		}
		key := strings.ToLower(clean)
		if names[key] {
			return errors.New("duplicate ZIP path")
		}
		names[key] = true
		if f.UncompressedSize64 > budget-total {
			return errors.New("expanded ZIP exceeds space limit")
		}
		total += f.UncompressedSize64
		mode := f.Mode()
		if !mode.IsRegular() && !mode.IsDir() && mode&os.ModeSymlink == 0 {
			return errors.New("unsupported ZIP entry")
		}
		if mode&os.ModeSymlink != 0 {
			links = append(links, f)
		}
	}
	for _, link := range links {
		prefix := strings.ToLower(strings.TrimSuffix(link.Name, "/")) + "/"
		for name := range names {
			if strings.HasPrefix(name, prefix) {
				return errors.New("ZIP entry traverses symlink")
			}
		}
	}
	if err := os.Mkdir(destination, 0700); err != nil {
		return err
	}
	for _, f := range z.File {
		if f.Mode()&os.ModeSymlink != 0 {
			continue
		}
		path := filepath.Join(destination, filepath.FromSlash(f.Name))
		if !within(destination, path) {
			return errors.New("ZIP escaped staging")
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(path, 0755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			return err
		}
		reader, err := f.Open()
		if err != nil {
			return err
		}
		writer, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, f.Mode().Perm()&0777)
		if err != nil {
			reader.Close()
			return err
		}
		_, err = io.Copy(writer, reader)
		reader.Close()
		closeErr := writer.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	for _, f := range links {
		if f.UncompressedSize64 > 4096 {
			return errors.New("symlink too large")
		}
		reader, err := f.Open()
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(reader, 4097))
		reader.Close()
		if err != nil {
			return err
		}
		link := filepath.Join(destination, filepath.FromSlash(f.Name))
		target := string(data)
		bundle := filepath.Join(destination, "NediaMatrix.app")
		if filepath.IsAbs(target) || !within(bundle, filepath.Join(filepath.Dir(link), target)) {
			return errors.New("symlink escapes bundle")
		}
		if err := os.MkdirAll(filepath.Dir(link), 0755); err != nil {
			return err
		}
		if err := os.Symlink(target, link); err != nil {
			return err
		}
	}
	// Resolve chains to reject indirect escapes, broken links and cycles.
	for _, f := range links {
		real, err := filepath.EvalSymlinks(filepath.Join(destination, filepath.FromSlash(f.Name)))
		if err != nil || !within(filepath.Join(destination, "NediaMatrix.app"), real) {
			return errors.New("invalid bundle symlink chain")
		}
	}
	return nil
}
func (i *Installer) prepare() error {
	r := i.journal.Request
	if exists(i.journal.Staged) || exists(i.journal.Backup) || exists(filepath.Join(i.directory, "journal.json")) {
		return errors.New("installation already exists")
	}
	if err := verify(r.Package, r.Size, r.SHA256); err != nil {
		return err
	}
	if r.Distribution == "app-zip" {
		current := r
		current.Version = r.CurrentVersion
		if err := validateBundle(r.Target, current); err != nil {
			return err
		}
	} else {
		current := r
		current.Version = r.CurrentVersion
		if err := validateExecutable(r.Target, current); err != nil {
			return err
		}
	}
	if err := checkSpace(i.directory, uint64(r.Size)*6+256*1024*1024); err != nil {
		return err
	}
	if r.Distribution != "nsis" {
		if err := checkSpace(filepath.Dir(r.Target), uint64(r.Size)*6+256*1024*1024); err != nil {
			return err
		}
	}
	if err := i.save("preparing"); err != nil {
		return err
	}
	if r.Distribution == "app-zip" {
		extraction := filepath.Join(i.directory, "extracted")
		if err := extractApp(r.Package, extraction, uint64(r.Size)*5); err != nil {
			return err
		}
		bundle := filepath.Join(extraction, "NediaMatrix.app")
		if err := validateBundle(bundle, r); err != nil {
			return err
		}
		// Cache may be on a different volume: copy using the OS bundle-preserving tool.
		if err := copyBundle(bundle, i.journal.Staged); err != nil {
			return err
		}
		if err := validateBundle(i.journal.Staged, r); err != nil {
			return err
		}
		if err := preserveQuarantine(r.Package, r.Target, i.journal.Staged); err != nil {
			return err
		}
	} else {
		if err := validateExecutable(r.Package, r); err != nil {
			return err
		}
		if err := copyFile(r.Package, i.journal.Staged, 0700); err != nil {
			return err
		}
		if err := verify(i.journal.Staged, r.Size, r.SHA256); err != nil {
			return err
		}
	}
	if r.Distribution == "app-zip" {
		digest, err := treeDigest(i.journal.Staged)
		if err != nil {
			return err
		}
		i.journal.StagedDigest = digest
	}
	if err := verify(r.Package, r.Size, r.SHA256); err != nil {
		return err
	}
	return i.save("waiting-exit")
}
func marker(directory, name, id string) bool {
	data, err := os.ReadFile(filepath.Join(directory, name))
	return err == nil && string(data) == id
}
func (i *Installer) wait() error {
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if marker(i.directory, "cancel", i.journal.Request.ID) {
			return errors.New("installation cancelled")
		}
		if marker(i.directory, "commit", i.journal.Request.ID) && !processAlive(i.journal.Request.ParentPID) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("exit confirmation timed out; application was not replaced")
}
func retryRename(source, target string) error {
	var err error
	for n := 0; n < 100; n++ {
		err = os.Rename(source, target)
		if err == nil {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return err
}
func (i *Installer) install() error {
	r := i.journal.Request
	if err := canonical(r.Target); err != nil {
		return err
	}
	if err := canonical(filepath.Dir(i.journal.Staged)); err != nil {
		return err
	}
	if r.Distribution != "app-zip" {
		if err := verify(i.journal.Staged, r.Size, r.SHA256); err != nil {
			return err
		}
	} else {
		if err := validateBundle(i.journal.Staged, r); err != nil {
			return err
		}
		digest, err := treeDigest(i.journal.Staged)
		if err != nil || digest != i.journal.StagedDigest {
			return errors.New("staged bundle changed after verification")
		}
	}
	if r.Distribution == "nsis" {
		if err := i.save("installer-starting"); err != nil {
			return err
		}
		// An exit code is NOT proof of successful installation. Confirmation comes from the new application.
		if err := launchInstaller(i.journal.Staged, i.directory); err != nil {
			return err
		}
		return i.confirmStartup(30 * time.Minute)
	}
	if err := i.save("backup-pending"); err != nil {
		return err
	}
	if err := retryRename(r.Target, i.journal.Backup); err != nil {
		return err
	}
	if err := i.save("replace-pending"); err != nil {
		return err
	}
	if err := retryRename(i.journal.Staged, r.Target); err != nil {
		return err
	}
	if err := i.save("launch-pending"); err != nil {
		return err
	}
	// Once launch is attempted, automatic rollback is forbidden: migrations may have run.
	if err := i.save("launching"); err != nil {
		return err
	}
	launch := launchApplication
	if i.launch != nil {
		launch = i.launch
	}
	if err := launch(r.Target); err != nil {
		return err
	}
	return i.confirmStartup(2 * time.Minute)
}
func (i *Installer) confirmStartup(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if marker(i.directory, "success", i.journal.Request.ID) {
			return i.save("completed")
		}
		time.Sleep(250 * time.Millisecond)
	}
	return errors.New("new application startup was not confirmed; keep backup and logs; automatic data downgrade is forbidden")
}

func (i *Installer) fail(cause error) {
	stage := i.journal.Stage
	i.journal.Error = cause.Error()
	// Before launch only: restore a missing target from its backup. Never remove the only usable copy.
	if stage == "replace-pending" || stage == "launch-pending" || stage == "backup-pending" {
		if err := i.restore(); err != nil {
			i.journal.Error += "; restoration failed: " + err.Error()
		}
	}
	_ = i.save("failed:" + stage)
	_ = durableWrite(filepath.Join(i.directory, "error"), []byte(i.journal.Error))
}

func treeDigest(root string) (string, error) {
	var names []string
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		names = append(names, path)
		return nil
	}); err != nil {
		return "", err
	}
	sort.Strings(names)
	h := sha256.New()
	for _, path := range names {
		info, err := os.Lstat(path)
		if err != nil {
			return "", err
		}
		rel, _ := filepath.Rel(root, path)
		fmt.Fprintf(h, "%q:%o:%d:", rel, info.Mode(), info.Size())
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return "", err
			}
			fmt.Fprintf(h, "%q", target)
		} else if info.Mode().IsRegular() {
			f, err := os.Open(path)
			if err != nil {
				return "", err
			}
			_, err = io.Copy(h, f)
			f.Close()
			if err != nil {
				return "", err
			}
		} else if !info.IsDir() {
			return "", errors.New("unsupported staged file")
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func (i *Installer) restore() error {
	if !exists(i.journal.Backup) {
		return nil
	}
	r := i.journal.Request
	if r.Distribution == "app-zip" {
		old := r
		old.Version = r.CurrentVersion
		if err := validateBundle(i.journal.Backup, old); err != nil {
			return err
		}
	} else if err := func() error {
		current := r
		current.Version = r.CurrentVersion
		return validateExecutable(i.journal.Backup, current)
	}(); err != nil {
		return err
	}
	if exists(r.Target) {
		if exists(i.journal.Staged) {
			return errors.New("both staged and target exist; preserve all files for manual recovery")
		}
		if err := retryRename(r.Target, i.journal.Staged); err != nil {
			return err
		}
	}
	return retryRename(i.journal.Backup, r.Target)
}
func (i *Installer) recover() error {
	data, err := os.ReadFile(filepath.Join(i.directory, "journal.json"))
	if err != nil || len(data) > 32768 {
		return errors.New("invalid recovery journal")
	}
	var journal Journal
	if err := json.Unmarshal(data, &journal); err != nil {
		return err
	}
	if journal.Request != i.journal.Request || journal.Staged != i.journal.Staged || journal.Backup != i.journal.Backup {
		return errors.New("recovery identity mismatch")
	}
	i.journal = journal
	switch journal.Stage {
	case "backup-pending", "replace-pending", "launch-pending":
		if marker(i.directory, "migration-started", journal.Request.ID) {
			return errors.New("data migration may have started; rollback forbidden")
		}
		if err := i.restore(); err != nil {
			return err
		}
		return i.save("recovered-before-launch")
	default:
		return errors.New("this stage does not permit automatic rollback; preserve backup and repair manually")
	}
}
func main() {
	recovery := len(os.Args) == 3 && os.Args[1] == "--recover"
	if len(os.Args) != 2 && !recovery {
		fmt.Fprintln(os.Stderr, "usage: nedia-update-helper [--recover] <request.json>")
		os.Exit(2)
	}
	i, err := load(os.Args[len(os.Args)-1], recovery)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if recovery {
		if processAlive(i.journal.Request.ParentPID) {
			fmt.Fprintln(os.Stderr, "exit the original application before recovery")
			os.Exit(1)
		}
		if err = i.recover(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err = i.prepare(); err == nil {
		err = durableWrite(filepath.Join(i.directory, "ready"), []byte(i.journal.Request.ID))
	}
	if err == nil {
		err = i.wait()
	}
	if err == nil {
		err = i.install()
	}
	if err != nil {
		i.fail(err)
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
