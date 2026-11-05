package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWebViewVersions(t *testing.T) {
	for _, value := range []string{"1.0.0.0", "130.0.2849.56"} {
		if !validWebViewVersion(value) {
			t.Fatalf("installed version rejected: %q", value)
		}
	}
	for _, value := range []string{"", "0.0.0.0", "1.2", "130.0.1.2 beta", "-1.0.0.0", "+1.0.0.0", "1.0.0.4294967296", "1.0.0. 1"} {
		if validWebViewVersion(value) {
			t.Fatalf("invalid version accepted: %q", value)
		}
	}
}

func TestWebViewRequirement(t *testing.T) {
	for _, scenario := range []string{"installed", "missing-cancel", "missing-open", "query-error", "browser-error"} {
		t.Run(scenario, func(t *testing.T) {
			asked, opened := false, false
			err := requireWebView(func() (bool, error) {
				if scenario == "query-error" {
					return false, errors.New("denied")
				}
				return scenario == "installed", nil
			}, func() bool {
				asked = true
				return scenario != "missing-cancel"
			}, func(url string) error {
				opened = true
				if url != webViewDownloadURL {
					t.Fatalf("unexpected download page: %s", url)
				}
				if scenario == "browser-error" {
					return errors.New("no browser")
				}
				return nil
			})
			if scenario == "installed" {
				if err != nil || asked || opened {
					t.Fatalf("installed runtime prompted or failed: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("missing/unknown runtime allowed startup")
			}
			if scenario == "query-error" && (asked || opened) {
				t.Fatal("registry failure opened a browser")
			}
			if scenario == "missing-cancel" && (!asked || opened) {
				t.Fatal("cancel was not respected")
			}
			if scenario == "missing-open" && (!asked || !opened || !errors.Is(err, errStartupExplained)) {
				t.Fatalf("download prompt lost: %v", err)
			}
			if scenario == "browser-error" && errors.Is(err, errStartupExplained) {
				t.Fatal("browser launch failure was hidden")
			}
		})
	}
}

func TestMissingWebViewStopsBeforeExtraction(t *testing.T) {
	root := t.TempDir()
	for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(key, root)
	}
	wrapper := filepath.Join(root, "portable.exe")
	if err := os.WriteFile(wrapper, wrapped(archiveBytes(t, requiredEntries())), 0700); err != nil {
		t.Fatal(err)
	}
	err := launchWithPreflight(wrapper, nil, func() error { return errStartupExplained })
	if !errors.Is(err, errStartupExplained) {
		t.Fatalf("preflight failure changed: %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 {
		t.Fatalf("created resources before dependency check: %v, %d entries", err, len(entries))
	}
}
