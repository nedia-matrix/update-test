package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func launch(executable string, args []string) error {
	return launchWithPreflight(executable, args, checkStartupRequirements)
}

func launchWithPreflight(executable string, args []string, preflight func() error) error {
	file, err := os.Open(executable)
	if err != nil {
		return err
	}
	defer file.Close()
	z, err := payload(file)
	if err != nil {
		return err
	}
	if err = validateArchive(z); err != nil {
		return err
	}
	if err = preflight(); err != nil {
		return err
	}
	// Collection is opportunistic. Busy, unknown or unreadable directories stay intact.
	collectPortableDirectories(os.TempDir(), removeInactiveDirectory)
	directory, err := os.MkdirTemp("", "nedia-portable-")
	if err != nil {
		return err
	}
	if err = extract(z, directory); err != nil {
		os.RemoveAll(directory)
		return err
	}
	command := exec.Command(filepath.Join(directory, "NediaMatrix.exe"), args...)
	command.Dir = directory
	// Match electron-builder's original launcher variables. Do not change APPDATA/userData.
	env := []string{}
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if strings.EqualFold(key, "PORTABLE_EXECUTABLE_FILE") || strings.EqualFold(key, "PORTABLE_EXECUTABLE_DIR") {
			continue
		}
		env = append(env, value)
	}
	command.Env = append(env, "PORTABLE_EXECUTABLE_FILE="+executable, "PORTABLE_EXECUTABLE_DIR="+filepath.Dir(executable))
	if err = command.Start(); err != nil {
		os.RemoveAll(directory)
		return err
	}
	// Publish ownership only after Windows has mapped the child's executable.
	// A concurrent collector can then prove activity from the image itself.
	if err := markPortableDirectory(directory); err != nil {
		fmt.Fprintln(os.Stderr, "Portable resources retained without a cleanup marker:", err)
	}
	// The original EXE must be unlocked for the legacy helper's rename/replacement.
	// Later launches collect this payload only after acquiring all file guards.
	return command.Process.Release()
}
func main() {
	executable, err := os.Executable()
	if err == nil {
		executable, err = filepath.EvalSymlinks(executable)
	}
	if err == nil {
		err = launch(executable, os.Args[1:])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		if !errors.Is(err, errStartupExplained) {
			reportError(err)
		}
		os.Exit(1)
	}
}
