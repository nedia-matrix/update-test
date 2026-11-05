package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

type entry struct {
	name string
	data string
	mode os.FileMode
}

func requiredEntries() []entry {
	return []entry{{"NediaMatrix.exe", "gui", 0700}, {"runtime/node.exe", "node", 0700}, {"runtime/sidecar.mjs", "sidecar", 0600}, {"runtime/native/win32-x64/runtime-lock.node", "lock", 0600}, {"runtime/update-helper/nedia-update-helper.exe", "helper", 0700}}
}
func archiveBytes(t *testing.T, entries []entry) []byte {
	t.Helper()
	var data bytes.Buffer
	writer := zip.NewWriter(&data)
	for _, e := range entries {
		header := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		header.SetMode(e.mode)
		out, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = out.Write([]byte(e.data)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}
func reader(t *testing.T, data []byte) *zip.Reader {
	t.Helper()
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	return z
}
func wrapped(data []byte) []byte {
	trailer := make([]byte, trailerSize)
	copy(trailer, trailerMagic)
	binary.LittleEndian.PutUint64(trailer[len(trailerMagic):], uint64(len(data)))
	digest := sha256.Sum256(data)
	copy(trailer[len(trailerMagic)+8:], digest[:])
	return append(append([]byte("PE-stub"), data...), trailer...)
}
func TestPayload(t *testing.T) {
	original := wrapped(archiveBytes(t, requiredEntries()))
	for _, kind := range []string{"valid", "corrupt", "truncated", "size", "magic"} {
		t.Run(kind, func(t *testing.T) {
			data := bytes.Clone(original)
			switch kind {
			case "corrupt":
				data[10] ^= 1
			case "truncated":
				data = data[:len(data)-1]
			case "size":
				binary.LittleEndian.PutUint64(data[len(data)-40:], ^uint64(0))
			case "magic":
				data[len(data)-trailerSize] = 0
			}
			file, err := os.CreateTemp(t.TempDir(), "payload")
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			if _, err := file.Write(data); err != nil {
				t.Fatal(err)
			}
			z, err := payload(file)
			if kind == "valid" {
				if err != nil {
					t.Fatal(err)
				}
				if err = validateArchive(z); err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("invalid payload accepted")
			}
		})
	}
}
func TestUnsafeNames(t *testing.T) {
	for _, name := range []string{"../outside", "/absolute", "a\\b", "C:/file", "runtime/../outside", "runtime/a:stream", "runtime/a.", "runtime/a ", "runtime/CON.txt", "runtime/LPT1", "runtime/a\x00b", "a//b", "a/./b", "runtime/COM¹.txt"} {
		t.Run(name, func(t *testing.T) {
			z := reader(t, archiveBytes(t, append(requiredEntries(), entry{name, "bad", 0600})))
			destination := t.TempDir()
			if err := extract(z, destination); err == nil {
				t.Fatal("unsafe name accepted")
			}
			files, _ := os.ReadDir(destination)
			if len(files) != 0 {
				t.Fatal("wrote files before preflight completed")
			}
		})
	}
}
func TestInvalidLayouts(t *testing.T) {
	for name, extra := range map[string]entry{
		"duplicate":              {"NediaMatrix.exe", "other", 0600},
		"case alias":             {"RUNTIME/NODE.EXE", "other", 0600},
		"symlink":                {"runtime/link", "../outside", os.ModeSymlink | 0700},
		"parent file":            {"runtime", "file", 0600},
		"cleanup marker":         {cleanupMarker, "forged", 0600},
		"cleanup marker alias":   {".NEDIA-PORTABLE-RUNTIME.JSON", "forged", 0600},
		"cleanup marker subtree": {cleanupMarker + "/nested", "forged", 0600},
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateArchive(reader(t, archiveBytes(t, append(requiredEntries(), extra)))); err == nil {
				t.Fatal("unsafe layout accepted")
			}
		})
	}
	if err := validateArchive(reader(t, archiveBytes(t, requiredEntries()[1:]))); err == nil {
		t.Fatal("missing executable accepted")
	}
	z := reader(t, archiveBytes(t, requiredEntries()))
	z.File[0].UncompressedSize64 = expandedLimit + 1
	if err := validateArchive(z); err == nil {
		t.Fatal("oversized entry accepted")
	}
}
func TestExtract(t *testing.T) {
	directory := t.TempDir()
	z := reader(t, archiveBytes(t, requiredEntries()))
	if err := extract(z, directory); err != nil {
		t.Fatal(err)
	}
	for _, e := range requiredEntries() {
		data, err := os.ReadFile(filepath.Join(directory, filepath.FromSlash(e.name)))
		if err != nil || string(data) != e.data {
			t.Fatalf("incorrect extracted file %s: %v", e.name, err)
		}
	}
	if err := extract(z, directory); err == nil {
		t.Fatal("overwrote existing payload")
	}
}

func TestRejectsChecksumFailure(t *testing.T) {
	z := reader(t, archiveBytes(t, requiredEntries()))
	z.File[0].CRC32 ^= 1
	if err := extract(z, t.TempDir()); err == nil {
		t.Fatal("accepted incorrect entry CRC")
	}
}
