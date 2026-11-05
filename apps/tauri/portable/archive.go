package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const trailerMagic = "NEDIA-PORTABLE01"
const trailerSize = len(trailerMagic) + 8 + sha256.Size
const expandedLimit uint64 = 4 << 30

// A private SectionReader excludes the PE stub and binds the complete ZIP to its digest.
// The signed update manifest authenticates the entire outer executable, including this trailer.
func payload(file *os.File) (*zip.Reader, error) {
	st, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if st.Size() < int64(trailerSize) {
		return nil, errors.New("missing portable trailer")
	}
	trailer := make([]byte, trailerSize)
	if _, err = file.ReadAt(trailer, st.Size()-int64(trailerSize)); err != nil {
		return nil, err
	}
	if string(trailer[:len(trailerMagic)]) != trailerMagic {
		return nil, errors.New("invalid portable trailer")
	}
	size := binary.LittleEndian.Uint64(trailer[len(trailerMagic):])
	if size == 0 || size > uint64(st.Size()-int64(trailerSize)) {
		return nil, errors.New("invalid payload size")
	}
	section := io.NewSectionReader(file, st.Size()-int64(trailerSize)-int64(size), int64(size))
	digest := sha256.New()
	if _, err = io.Copy(digest, section); err != nil {
		return nil, err
	}
	if !bytes.Equal(digest.Sum(nil), trailer[len(trailerMagic)+8:]) {
		return nil, errors.New("portable payload hash mismatch")
	}
	return zip.NewReader(io.NewSectionReader(file, st.Size()-int64(trailerSize)-int64(size), int64(size)), int64(size))
}

// Apply Windows name rules on every host so build-time tests reject aliases as well.
func safeName(name string) bool {
	if name == "" || strings.ContainsAny(name, "\\:\x00<>\"|?*") || path.IsAbs(name) || path.Clean(name) != name {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "." || part == ".." || strings.TrimRight(part, ". ") != part {
			return false
		}
		for _, c := range part {
			if c < 32 {
				return false
			}
		}
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		base = strings.NewReplacer("¹", "1", "²", "2", "³", "3").Replace(base)
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || base == "CONIN$" || base == "CONOUT$" {
			return false
		}
		if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '0' && base[3] <= '9' {
			return false
		}
	}
	return true
}

func validateArchive(z *zip.Reader) error {
	if len(z.File) > 100000 {
		return errors.New("too many portable files")
	}
	names := map[string]bool{}
	var total uint64
	for _, f := range z.File {
		name := strings.TrimSuffix(f.Name, "/")
		if !safeName(name) || (!f.Mode().IsRegular() && !f.Mode().IsDir()) {
			return fmt.Errorf("unsafe portable entry: %q", f.Name)
		}
		key := strings.ToLower(name)
		if key == cleanupMarker || strings.HasPrefix(key, cleanupMarker+"/") {
			return errors.New("portable archive contains reserved cleanup marker")
		}
		if _, ok := names[key]; ok {
			return errors.New("duplicate portable entry")
		}
		names[key] = f.FileInfo().IsDir()
		if f.UncompressedSize64 > expandedLimit-total {
			return errors.New("portable payload exceeds expanded limit")
		}
		total += f.UncompressedSize64
	}
	for name := range names {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if directory, ok := names[parent]; ok && !directory {
				return errors.New("portable file used as directory")
			}
		}
	}
	for _, required := range []string{"NediaMatrix.exe", "runtime/node.exe", "runtime/sidecar.mjs", "runtime/native/win32-x64/runtime-lock.node", "runtime/update-helper/nedia-update-helper.exe"} {
		if directory, ok := names[strings.ToLower(required)]; !ok || directory {
			return fmt.Errorf("missing portable runtime file: %s", required)
		}
	}
	return nil
}

// destination is a new private directory; never reuse or delete another running payload.
func extract(z *zip.Reader, destination string) error {
	if err := validateArchive(z); err != nil {
		return err
	}
	for _, f := range z.File {
		target := filepath.Join(destination, filepath.FromSlash(f.Name))
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0700); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		if err := extractFile(f, target); err != nil {
			return err
		}
	}
	return nil
}
func extractFile(f *zip.File, target string) error {
	reader, err := f.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	writer, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(writer, io.LimitReader(reader, int64(f.UncompressedSize64)+1))
	closeErr := writer.Close()
	if copyErr != nil {
		return copyErr
	}
	if n != int64(f.UncompressedSize64) {
		return errors.New("portable entry size mismatch")
	}
	return closeErr
}
