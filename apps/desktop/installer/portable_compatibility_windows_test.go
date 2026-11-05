package main

import (
	"os"
	"testing"
)

// The build verifier supplies its generated EXE; validate with the production helper,
// including the Windows version APIs that a PE parser alone cannot exercise.
func TestPortableCompatibilityPayload(t *testing.T) {
	file := os.Getenv("NEDIA_VERIFY_PORTABLE_EXE")
	if file == "" {
		t.Skip("requires generated portable compatibility payload")
	}
	version := os.Getenv("NEDIA_VERIFY_PORTABLE_VERSION")
	if version == "" {
		version = "0.8.5"
	}
	request := Request{Arch: "x64", Version: version}
	if err := validateExecutable(file, request); err != nil {
		t.Fatal(err)
	}
	if err := validatePortableBackup(file); err != nil {
		t.Fatal(err)
	}
	request.Version = "0.0.0"
	if version == request.Version {
		request.Version = "0.0.1"
	}
	if err := validateExecutable(file, request); err == nil {
		t.Fatal("accepted wrong product version")
	}
	oldName := applicationName
	applicationName = "OtherProduct"
	defer func() { applicationName = oldName }()
	if err := validatePortableBackup(file); err == nil {
		t.Fatal("accepted wrong product name")
	}
}
