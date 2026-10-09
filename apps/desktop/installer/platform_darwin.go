package main

import (
	"debug/macho"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
func checkSpace(path string, needed uint64) error {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return err
	}
	if uint64(st.Bavail)*uint64(st.Bsize) < needed {
		return errors.New("insufficient disk space")
	}
	if st.Flags&1 != 0 {
		return errors.New("read-only application volume; install manually")
	}
	return nil
}
func plist(path, key string) (string, error) {
	out, err := exec.Command("/usr/bin/plutil", "-extract", key, "raw", "-o", "-", path).Output()
	return strings.TrimSpace(string(out)), err
}
func validateBundle(path string, r Request) error {
	info := filepath.Join(path, "Contents", "Info.plist")
	id, err := plist(info, "CFBundleIdentifier")
	if err != nil || id != r.AppID {
		return errors.New("bundle identifier mismatch")
	}
	version, err := plist(info, "CFBundleShortVersionString")
	if err != nil || version != r.Version {
		return errors.New("bundle version mismatch")
	}
	executable, err := plist(info, "CFBundleExecutable")
	if err != nil || executable == "" || filepath.Base(executable) != executable {
		return errors.New("invalid bundle executable")
	}
	binary := filepath.Join(path, "Contents", "MacOS", executable)
	if err := regular(binary); err != nil {
		return err
	}
	binaryInfo, err := os.Stat(binary)
	if err != nil || binaryInfo.Mode().Perm()&0111 == 0 {
		return errors.New("bundle executable has no execute permission")
	}
	file, err := macho.Open(binary)
	if err != nil {
		return err
	}
	defer file.Close()
	expected := macho.CpuArm64
	if r.Arch == "x64" {
		expected = macho.CpuAmd64
	} else if r.Arch != "arm64" {
		return errors.New("unsupported architecture")
	}
	if file.Cpu != expected {
		return errors.New("bundle architecture mismatch")
	}
	return nil
}
func copyBundle(source, target string) error {
	return exec.Command("/usr/bin/ditto", source, target).Run()
}
func validateExecutable(path string, r Request) error { return errors.New("Windows payload on macOS") }
func launchApplication(target string) error           { return exec.Command("/usr/bin/open", "-n", target).Run() }
func launchInstaller(target, directory string) error  { return errors.New("NSIS on macOS") }

// Preserve an existing system quarantine attribute; never remove it or bypass Gatekeeper.
func preserveQuarantine(source, current, staged string) error {
	for _, path := range []string{source, current} {
		data, err := exec.Command("/usr/bin/xattr", "-p", "com.apple.quarantine", path).CombinedOutput()
		if err != nil {
			if strings.Contains(string(data), "No such xattr") {
				continue
			}
			return errors.New("cannot inspect quarantine attribute; install manually")
		}
		value := strings.TrimSuffix(string(data), "\n")
		return exec.Command("/usr/bin/xattr", "-w", "com.apple.quarantine", value, staged).Run()
	}
	return nil
}
