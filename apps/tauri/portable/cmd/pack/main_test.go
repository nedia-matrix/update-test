package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPack(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.MkdirAll(filepath.Join(source, "runtime"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "runtime", "sidecar.mjs"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(root, "payload.zip")
	if err := pack(source, output); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.OpenReader(output)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	if len(archive.File) != 1 || archive.File[0].Name != "runtime/sidecar.mjs" {
		t.Fatal("payload path was not preserved")
	}
	if err := pack(source, output); err == nil {
		t.Fatal("overwrote existing ZIP")
	}
}
func TestPackRejectsSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks requires extra privileges on Windows")
	}
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/", filepath.Join(source, "alias")); err != nil {
		t.Fatal(err)
	}
	if err := pack(source, filepath.Join(root, "payload.zip")); err == nil {
		t.Fatal("accepted payload symlink")
	}
}
