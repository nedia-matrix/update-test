package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func sleepingExecutable(t *testing.T) []byte {
	t.Helper()
	root := t.TempDir()
	source := filepath.Join(root, "fixture.go")
	program := `package main
import("os";"time")
func main(){os.WriteFile(os.Args[1],[]byte("ready"),0600);time.Sleep(60*time.Second)}`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(root, "fixture.exe")
	if out, err := exec.Command("go", "build", "-o", executable, source).CombinedOutput(); err != nil {
		t.Fatalf("build fixture: %v %s", err, out)
	}
	data, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func ownedFixtureDirectory(t *testing.T, executable []byte) string {
	t.Helper()
	directory, err := os.MkdirTemp(t.TempDir(), "nedia-portable-")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(directory, "runtime"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(directory, "runtime/update-helper"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"NediaMatrix.exe", "runtime/node.exe", "runtime/update-helper/nedia-update-helper.exe"} {
		if err := os.WriteFile(filepath.Join(directory, name), executable, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(directory, "runtime/sidecar.mjs"), []byte("keep runtime resources"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := markPortableDirectory(directory); err != nil {
		t.Fatal(err)
	}
	return directory
}

func startSleepingProcess(t *testing.T, executable string) *exec.Cmd {
	t.Helper()
	ready := filepath.Join(t.TempDir(), "ready")
	command := exec.Command(executable, ready)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = command.Process.Kill(); _ = command.Wait() })
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			return command
		}
		if time.Now().After(deadline) {
			t.Fatal("fixture did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestCleanupEnumeratesGuardedDirectories(t *testing.T) {
	directory := ownedFixtureDirectory(t, []byte("fixture"))
	entries, err := lockPortableTree(directory)
	if err != nil {
		t.Fatalf("inactive tree must be enumerable while DELETE guards are held: %v", err)
	}
	defer closeCleanupEntries(entries)
	expected := map[string]bool{
		".": false, cleanupMarker: false, "NediaMatrix.exe": false,
		"runtime": false, filepath.FromSlash("runtime/node.exe"): false,
		filepath.FromSlash("runtime/sidecar.mjs"):                           false,
		filepath.FromSlash("runtime/update-helper"):                         false,
		filepath.FromSlash("runtime/update-helper/nedia-update-helper.exe"): false,
	}
	for _, entry := range entries {
		name, err := filepath.Rel(directory, entry.path)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := expected[name]; !ok {
			t.Fatalf("unexpected guarded entry: %s", name)
		}
		expected[name] = true
	}
	if len(entries) != len(expected) {
		t.Fatalf("guarded %d entries, expected %d", len(entries), len(expected))
	}
	for name, seen := range expected {
		if !seen {
			t.Fatalf("missing guarded entry: %s", name)
		}
	}
}

func TestCleanupReleasesGuardsAfterPreflightFailure(t *testing.T) {
	directory := ownedFixtureDirectory(t, []byte("fixture"))
	path := filepath.Join(directory, "runtime", "zz-busy.txt")
	if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	busy, err := os.Open(path) // Go opens without SHARE_DELETE.
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	if err := removeInactiveDirectory(directory); err == nil {
		t.Fatal("collected resources with an open file")
	}
	for _, name := range []string{cleanupMarker, "NediaMatrix.exe", "runtime/node.exe", "runtime/zz-busy.txt"} {
		if _, err := os.Stat(filepath.Join(directory, name)); err != nil {
			t.Fatalf("partially removed busy resources: %v", err)
		}
	}
	if err := busy.Close(); err != nil {
		t.Fatal(err)
	}
	if err := removeInactiveDirectory(directory); err != nil {
		t.Fatalf("preflight left a guard locked: %v", err)
	}
}

func TestCleanupProtectsLiveGUIAndOrphanSidecar(t *testing.T) {
	directory := ownedFixtureDirectory(t, sleepingExecutable(t))
	gui := startSleepingProcess(t, filepath.Join(directory, "NediaMatrix.exe"))
	sidecar := startSleepingProcess(t, filepath.Join(directory, "runtime/node.exe"))
	helper := startSleepingProcess(t, filepath.Join(directory, "runtime/update-helper/nedia-update-helper.exe"))
	assertIntact := func() {
		t.Helper()
		if err := removeInactiveDirectory(directory); err == nil {
			t.Fatal("collected an active image")
		}
		for _, name := range []string{cleanupMarker, "NediaMatrix.exe", "runtime/node.exe", "runtime/sidecar.mjs", "runtime/update-helper/nedia-update-helper.exe"} {
			if _, err := os.Stat(filepath.Join(directory, name)); err != nil {
				t.Fatalf("partially deleted active resources: %s: %v", name, err)
			}
		}
	}
	assertIntact()
	_ = gui.Process.Kill()
	_ = gui.Wait()
	assertIntact() // The window is gone, but the business process is still alive.
	_ = sidecar.Process.Kill()
	_ = sidecar.Wait()
	assertIntact() // Update confirmation can outlive both application processes.
	_ = helper.Process.Kill()
	_ = helper.Wait()
	if err := removeInactiveDirectory(directory); err != nil {
		t.Fatalf("inactive collection failed: %v", err)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("inactive directory remains: %v", err)
	}
}

func TestCleanupGuardsBlockExecutionAndConcurrentCollectors(t *testing.T) {
	directory := ownedFixtureDirectory(t, sleepingExecutable(t))
	entries, err := lockPortableTree(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer closeCleanupEntries(entries)
	command := exec.Command(filepath.Join(directory, "NediaMatrix.exe"), filepath.Join(t.TempDir(), "ready"))
	if err := command.Start(); err == nil {
		command.Process.Kill()
		command.Wait()
		t.Fatal("a guarded image could still start")
	}
	if err := removeInactiveDirectory(directory); err == nil {
		t.Fatal("concurrent collector bypassed root guard")
	}
	closeCleanupEntries(entries)
	if err := removeInactiveDirectory(directory); err != nil {
		t.Fatal(err)
	}
}

func TestCleanupRefusesDirectoryJunction(t *testing.T) {
	directory := ownedFixtureDirectory(t, []byte("fixture"))
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "keep.txt")
	if err := os.WriteFile(sentinel, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "runtime/external")
	if out, err := exec.Command("cmd.exe", "/c", "mklink", "/J", link, outside).CombinedOutput(); err != nil {
		t.Skipf("junctions unavailable: %v %s", err, out)
	}
	defer os.Remove(link)
	if err := removeInactiveDirectory(directory); err == nil {
		t.Fatal("cleanup followed a junction")
	}
	data, err := os.ReadFile(sentinel)
	if err != nil || string(data) != "outside" {
		t.Fatal("cleanup changed outside data")
	}
	if _, err := os.Stat(filepath.Join(directory, "NediaMatrix.exe")); err != nil {
		t.Fatal("unsafe tree partially deleted")
	}
}
