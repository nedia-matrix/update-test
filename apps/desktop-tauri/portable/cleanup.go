package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const cleanupMarker = ".nedia-portable-runtime.json"
const cleanupFormat = "nedia-portable-runtime/1"

type portableDirectory struct {
	Format    string `json:"format"`
	Directory string `json:"directory"`
}

func markerMatches(data []byte, directory string) bool {
	var marker portableDirectory
	name := filepath.Base(directory)
	return len(data) <= 1024 && json.Unmarshal(data, &marker) == nil &&
		marker.Format == cleanupFormat && marker.Directory == name &&
		strings.HasPrefix(name, "nedia-portable-") && len(name) > len("nedia-portable-")
}

func markPortableDirectory(directory string) error {
	data, err := json.Marshal(portableDirectory{Format: cleanupFormat, Directory: filepath.Base(directory)})
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(directory, cleanupMarker), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	return errors.Join(writeErr, file.Close())
}

func readPortableMarker(directory string) ([]byte, error) {
	path := filepath.Join(directory, cleanupMarker)
	st, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > 1024 {
		return nil, errors.New("invalid portable cleanup marker")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(st, opened) {
		return nil, errors.New("portable cleanup marker changed")
	}
	return io.ReadAll(io.LimitReader(file, 1025))
}

// No migration for old, unmarked prototype directories. No PID or age-based takeover.
func collectPortableDirectories(parent string, remove func(string) error) {
	parent, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return
	}
	entries, err := os.ReadDir(parent)
	if err != nil {
		return
	}
	attempts := 0
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "nedia-portable-") {
			continue
		}
		directory := filepath.Join(parent, entry.Name())
		marker, err := readPortableMarker(directory)
		if err != nil || !markerMatches(marker, directory) {
			continue
		}
		_ = remove(directory)
		attempts++
		if attempts >= 20 {
			return
		}
	}
}
