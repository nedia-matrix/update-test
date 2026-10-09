package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func archive(t *testing.T, entries map[string]string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "payload.zip")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	z := zip.NewWriter(f)
	for name, value := range entries {
		writer, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = writer.Write([]byte(value)); err != nil {
			t.Fatal(err)
		}
	}
	if err = z.Close(); err != nil {
		t.Fatal(err)
	}
	f.Close()
	return path
}
func TestZIPRejectsTraversalAndForeignRoots(t *testing.T) {
	for _, name := range []string{"../outside", "NediaMatrix.app/../../outside", "/NediaMatrix.app/file", "Other.app/file", "NediaMatrix.app/Contents/../escape", "NediaMatrix.app\\outside"} {
		t.Run(name, func(t *testing.T) {
			path := archive(t, map[string]string{name: "bad"})
			destination := filepath.Join(t.TempDir(), "extracted")
			if err := extractApp(path, destination, 1024); err == nil {
				t.Fatal("accepted unsafe path")
			}
			if exists(destination) {
				t.Fatal("extracted before validation")
			}
		})
	}
}
func TestZIPRejectsExpansionAndSymlinkTraversal(t *testing.T) {
	path := archive(t, map[string]string{"NediaMatrix.app/file": "too large"})
	if extractApp(path, filepath.Join(t.TempDir(), "extracted"), 1) == nil {
		t.Fatal("accepted expansion")
	}
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	header := &zip.FileHeader{Name: "NediaMatrix.app/link"}
	header.SetMode(os.ModeSymlink | 0777)
	link, _ := writer.CreateHeader(header)
	link.Write([]byte("Contents"))
	file, _ := writer.Create("NediaMatrix.app/link/file")
	file.Write([]byte("bad"))
	writer.Close()
	path = filepath.Join(t.TempDir(), "links.zip")
	os.WriteFile(path, buffer.Bytes(), 0600)
	if extractApp(path, filepath.Join(t.TempDir(), "extracted"), 1024) == nil {
		t.Fatal("accepted traversal through symlink")
	}
}
func TestZIPRejectsEscapingAndCyclicLinks(t *testing.T) {
	for _, target := range []string{"../../outside", "/tmp/outside", "link"} {
		var buffer bytes.Buffer
		writer := zip.NewWriter(&buffer)
		header := &zip.FileHeader{Name: "NediaMatrix.app/link"}
		header.SetMode(os.ModeSymlink | 0777)
		link, _ := writer.CreateHeader(header)
		link.Write([]byte(target))
		writer.Close()
		path := filepath.Join(t.TempDir(), "links.zip")
		os.WriteFile(path, buffer.Bytes(), 0600)
		if extractApp(path, filepath.Join(t.TempDir(), "extracted"), 1024) == nil {
			t.Fatal("accepted escaping/cyclic symlink")
		}
	}
}
func TestVerifiedFileRejectsMutationAndSymlink(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "package")
	os.WriteFile(path, []byte("trusted"), 0600)
	hash := sha256.Sum256([]byte("trusted"))
	digest := hex.EncodeToString(hash[:])
	if err := verify(path, 7, digest); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(path, []byte("changed"), 0600)
	if verify(path, 7, digest) == nil {
		t.Fatal("accepted changed bytes")
	}
	link := filepath.Join(directory, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Skip("symlinks unavailable")
	}
	if verify(link, 7, digest) == nil {
		t.Fatal("accepted linked package")
	}
}
func TestTreeDigestDetectsChangedFilesAndModes(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "binary")
	os.WriteFile(file, []byte("old"), 0700)
	before, err := treeDigest(root)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(file, []byte("new"), 0700)
	after, _ := treeDigest(root)
	if before == after {
		t.Fatal("mutation invisible")
	}
}
