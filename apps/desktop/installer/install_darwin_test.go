package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func fixtureBundle(t *testing.T, path, version string) {
	t.Helper()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(path, "Contents", "MacOS"), 0755)
	info := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.nediamatrix.desktop</string><key>CFBundleShortVersionString</key><string>%s</string><key>CFBundleExecutable</key><string>NediaMatrix</string></dict></plist>`, version)
	os.WriteFile(filepath.Join(path, "Contents", "Info.plist"), []byte(info), 0600)
	if err := copyFile(binary, filepath.Join(path, "Contents", "MacOS", "NediaMatrix"), 0700); err != nil {
		t.Fatal(err)
	}
}
func fixtureInstaller(t *testing.T) *Installer {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "Current.app")
	fixtureBundle(t, target, "0.3.3")
	newer := filepath.Join(root, "new", "NediaMatrix.app")
	fixtureBundle(t, newer, "0.4.0")
	file := filepath.Join(root, "update.zip")
	output, _ := os.Create(file)
	zipper := zip.NewWriter(output)
	filepath.Walk(newer, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(filepath.Dir(newer), path)
		header, _ := zip.FileInfoHeader(info)
		header.Name = rel
		entry, err := zipper.CreateHeader(header)
		if err != nil {
			return err
		}
		source, _ := os.Open(path)
		defer source.Close()
		_, err = io.Copy(entry, source)
		return err
	})
	zipper.Close()
	output.Close()
	bytes, _ := os.ReadFile(file)
	hash := sha256.Sum256(bytes)
	id := "12345678-1234-1234-1234-123456789abc"
	directory := filepath.Join(root, id)
	os.Mkdir(directory, 0700)
	arch := "arm64"
	if runtime.GOARCH == "amd64" {
		arch = "x64"
	}
	request := Request{ID: id, ParentPID: os.Getpid(), Platform: "darwin", Arch: arch, Distribution: "app-zip", CurrentVersion: "0.3.3", Version: "0.4.0", AppID: "com.nediamatrix.desktop", Package: file, Target: target, Size: int64(len(bytes)), SHA256: hex.EncodeToString(hash[:])}
	data, _ := json.Marshal(request)
	requestFile := filepath.Join(directory, "request.json")
	os.WriteFile(requestFile, data, 0600)
	installer, err := load(requestFile, false)
	if err != nil {
		t.Fatal(err)
	}
	return installer
}
func TestPrepareNeverChangesCurrentBundle(t *testing.T) {
	i := fixtureInstaller(t)
	if err := i.prepare(); err != nil {
		t.Fatal(err)
	}
	current := i.journal.Request
	current.Version = current.CurrentVersion
	if err := validateBundle(current.Target, current); err != nil {
		t.Fatal("current bundle changed:", err)
	}
	if exists(i.journal.Backup) {
		t.Fatal("backup created before commit")
	}
	os.WriteFile(filepath.Join(i.directory, "cancel"), []byte(current.ID), 0600)
	if i.wait() == nil {
		t.Fatal("cancel ignored")
	}
}
func TestCommitAlsoRequiresParentExit(t *testing.T) {
	i := fixtureInstaller(t)
	sleeper := exec.Command("/bin/sleep", "0.3")
	if err := sleeper.Start(); err != nil {
		t.Fatal(err)
	}
	i.journal.Request.ParentPID = sleeper.Process.Pid
	os.WriteFile(filepath.Join(i.directory, "commit"), []byte(i.journal.Request.ID), 0600)
	done := make(chan error, 1)
	go func() { done <- i.wait() }()
	select {
	case err := <-done:
		t.Fatal("did not wait for live parent:", err)
	default:
	}
	sleeper.Wait()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
func TestStagingMutationStopsReplacement(t *testing.T) {
	i := fixtureInstaller(t)
	if err := i.prepare(); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(i.journal.Staged, "Contents", "injected"), []byte("bad"), 0600)
	if i.install() == nil {
		t.Fatal("modified staging installed")
	}
	current := i.journal.Request
	current.Version = current.CurrentVersion
	if err := validateBundle(current.Target, current); err != nil {
		t.Fatal(err)
	}
	if exists(i.journal.Backup) {
		t.Fatal("old bundle moved")
	}
}
func TestRecoveryRestoresPreLaunchAndRefusesPostLaunch(t *testing.T) {
	i := fixtureInstaller(t)
	if err := i.prepare(); err != nil {
		t.Fatal(err)
	}
	os.Rename(i.journal.Request.Target, i.journal.Backup)
	os.Rename(i.journal.Staged, i.journal.Request.Target)
	i.save("launch-pending")
	if err := i.recover(); err != nil {
		t.Fatal(err)
	}
	current := i.journal.Request
	current.Version = current.CurrentVersion
	if err := validateBundle(current.Target, current); err != nil {
		t.Fatal(err)
	}
	if !exists(i.journal.Staged) {
		t.Fatal("discarded newer bundle")
	}
	i.save("launching")
	if i.recover() == nil {
		t.Fatal("allowed rollback after possible migration")
	}
}

func TestReplacementConfirmsStartupAndPreservesOldBundle(t *testing.T) {
	i := fixtureInstaller(t)
	if err := i.prepare(); err != nil {
		t.Fatal(err)
	}
	i.launch = func(target string) error {
		if err := validateBundle(target, i.journal.Request); err != nil {
			return err
		}
		return durableWrite(filepath.Join(i.directory, "success"), []byte(i.journal.Request.ID))
	}
	if err := i.install(); err != nil {
		t.Fatal(err)
	}
	if i.journal.Stage != "completed" {
		t.Fatal("completion was not recorded")
	}
	old := i.journal.Request
	old.Version = old.CurrentVersion
	if err := validateBundle(i.journal.Backup, old); err != nil {
		t.Fatal("old backup missing:", err)
	}
}
