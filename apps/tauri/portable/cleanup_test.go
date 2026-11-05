package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCollectOnlyOwnedPortableDirectories(t *testing.T) {
	root := t.TempDir()
	valid := filepath.Join(root, "nedia-portable-valid")
	for _, name := range []string{"nedia-portable-valid", "nedia-portable-unmarked", "nedia-portable-bad", "nedia-portable-mismatch", "unrelated"} {
		directory := filepath.Join(root, name)
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
		if name == "nedia-portable-unmarked" {
			continue
		}
		if err := markPortableDirectory(directory); err != nil {
			t.Fatal(err)
		}
		if name == "nedia-portable-bad" {
			if err := os.WriteFile(filepath.Join(directory, cleanupMarker), []byte(strings.Repeat("x", 1025)), 0600); err != nil {
				t.Fatal(err)
			}
		}
		if name == "nedia-portable-mismatch" {
			if err := os.WriteFile(filepath.Join(directory, cleanupMarker), []byte(`{"format":"nedia-portable-runtime/1","directory":"elsewhere"}`), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	var visited []string
	collectPortableDirectories(root, func(directory string) error {
		visited = append(visited, directory)
		return errors.New("busy")
	})
	canonical, _ := filepath.EvalSymlinks(valid)
	if len(visited) != 1 || visited[0] != canonical {
		t.Fatalf("unowned directories considered: %v", visited)
	}
	if _, err := os.Stat(valid); err != nil {
		t.Fatal("busy directory removed")
	}
	if err := markPortableDirectory(valid); !os.IsExist(err) {
		t.Fatalf("overwrote existing marker: %v", err)
	}
}

func TestCollectRefusesMarkerAndDirectoryLinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	owned := filepath.Join(root, "nedia-portable-owned")
	if err := os.Mkdir(owned, 0700); err != nil {
		t.Fatal(err)
	}
	if err := markPortableDirectory(owned); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(owned, cleanupMarker))
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(outside, "marker.json")
	if err := os.WriteFile(target, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(owned, cleanupMarker)); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(owned, cleanupMarker)); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "nedia-portable-link")); err != nil {
		t.Fatal(err)
	}
	collectPortableDirectories(root, func(string) error { t.Fatal("followed a cleanup link"); return nil })
	if _, err := os.Stat(target); err != nil {
		t.Fatal("outside file changed")
	}
}
