package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"syscall"
	"unsafe"
)

type cleanupEntry struct {
	file *os.File
	path string
}

func closeCleanupEntries(entries []cleanupEntry) {
	for i := len(entries) - 1; i >= 0; i-- {
		_ = entries[i].file.Close()
	}
}

func cleanupPathInfo(path string) (os.FileInfo, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	// Capture a complete file identity before taking the guard. Lstat/DirEntry
	// metadata may defer identity lookup until SameFile, reopening by path with
	// incompatible sharing. This handle permits the guards' DELETE access and
	// never follows a directory junction or other reparse point.
	handle, err := syscall.CreateFile(name, 0x80, // FILE_READ_ATTRIBUTES
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil, syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_OPEN_REPARSE_POINT|syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(handle), path)
	info, statErr := file.Stat()
	return info, errors.Join(statErr, file.Close())
}

func openCleanupEntry(path string, before os.FileInfo) (*os.File, error) {
	if !before.IsDir() && !before.Mode().IsRegular() {
		return nil, errors.New("portable tree contains a link or special file")
	}
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	// An exclusive writer cannot open an active Windows executable image. Once
	// acquired, it also prevents a new process from mapping that image. Hold ALL
	// files before deleting anything: failed preflight must not partially remove
	// resources from a live GUI, orphan sidecar, or update helper.
	access := uint32(syscall.GENERIC_READ | syscall.GENERIC_WRITE | 0x10000) // DELETE
	share := uint32(0)
	flags := uint32(syscall.FILE_FLAG_OPEN_REPARSE_POINT)
	if before.IsDir() {
		access = 0x1 | 0x80 | 0x10000 // FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | DELETE
		share = syscall.FILE_SHARE_READ | syscall.FILE_SHARE_WRITE
		flags |= syscall.FILE_FLAG_BACKUP_SEMANTICS
	}
	handle, err := syscall.CreateFile(name, access, share, nil, syscall.OPEN_EXISTING, flags, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(handle), path)
	var info syscall.ByHandleFileInformation
	err = syscall.GetFileInformationByHandle(handle, &info)
	after, statErr := file.Stat()
	if err != nil || statErr != nil || info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || !os.SameFile(before, after) {
		file.Close()
		return nil, errors.New("portable tree changed or contains a reparse point")
	}
	return file, nil
}

func lockPortableTree(directory string) ([]cleanupEntry, error) {
	entries := []cleanupEntry{}
	var lock func(string) error
	lock = func(path string) error {
		if len(entries) >= 8192 {
			return errors.New("portable cleanup file budget exceeded")
		}
		info, err := cleanupPathInfo(path)
		if err != nil {
			return err
		}
		file, err := openCleanupEntry(path, info)
		if err != nil {
			return fmt.Errorf("portable resources busy or unsafe: %s: %w", path, err)
		}
		entries = append(entries, cleanupEntry{file: file, path: path})
		if info.IsDir() {
			// WalkDir/os.ReadDir would reopen this directory without SHARE_DELETE,
			// conflicting with our own DELETE guard. Enumerate the guarded handle.
			children, err := file.ReadDir(-1)
			if err != nil {
				return err
			}
			sort.Slice(children, func(i, j int) bool { return children[i].Name() < children[j].Name() })
			for _, child := range children {
				if err := lock(filepath.Join(path, child.Name())); err != nil {
					return err
				}
			}
		}
		return nil
	}
	err := lock(directory)
	if err != nil {
		closeCleanupEntries(entries)
		return nil, err
	}
	return entries, nil
}

var setFileInformation = syscall.NewLazyDLL("kernel32.dll").NewProc("SetFileInformationByHandle")

func deleteCleanupEntry(entry cleanupEntry) error {
	deleting := byte(1)
	// FILE_DISPOSITION_INFO marks this exact guarded object for deletion on
	// close. Do not release a guard and then reopen the pathname for removal.
	result, _, err := setFileInformation.Call(entry.file.Fd(), 4, uintptr(unsafe.Pointer(&deleting)), 1)
	if result == 0 {
		return fmt.Errorf("cannot dispose portable resource: %w", err)
	}
	return entry.file.Close()
}

func removeInactiveDirectory(directory string) error {
	entries, err := lockPortableTree(directory)
	if err != nil {
		return err
	}
	defer closeCleanupEntries(entries)
	marker := -1
	for i, entry := range entries {
		if entry.path == filepath.Join(directory, cleanupMarker) {
			marker = i
			break
		}
	}
	if marker < 0 {
		return errors.New("missing portable cleanup marker")
	}
	data, err := io.ReadAll(io.LimitReader(entries[marker].file, 1025))
	if err != nil || !markerMatches(data, directory) {
		return errors.New("invalid guarded portable cleanup marker")
	}
	// Entries are depth-first. Delete children before parents, retaining ownership
	// evidence until resources are gone so interrupted cleanup can be retried.
	for i := len(entries) - 1; i > 0; i-- {
		if i == marker {
			continue
		}
		if err := deleteCleanupEntry(entries[i]); err != nil {
			return err
		}
	}
	if err := deleteCleanupEntry(entries[marker]); err != nil {
		return err
	}
	return deleteCleanupEntry(entries[0])
}
