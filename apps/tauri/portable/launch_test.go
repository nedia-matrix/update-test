package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Real child processes prove that the wrapper exits/unlocks while its extracted GUI lives.
// The fixture never opens a business directory, browser or network connection.
func TestLauncherReleasesOriginalExecutable(t *testing.T) {
	root := t.TempDir()
	fixtureSource := filepath.Join(root, "fixture.go")
	fixture := `package main
import("encoding/json";"os";"time")
func main(){cwd,_:=os.Getwd();data,_:=json.Marshal(map[string]any{"cwd":cwd,"file":os.Getenv("PORTABLE_EXECUTABLE_FILE"),"dir":os.Getenv("PORTABLE_EXECUTABLE_DIR"),"pid":os.Getpid(),"args":os.Args[1:]});os.WriteFile(os.Args[1],data,0600);time.Sleep(60*time.Second)}`
	if err := os.WriteFile(fixtureSource, []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	gui := filepath.Join(root, "fixture.exe")
	if out, err := exec.Command("go", "build", "-o", gui, fixtureSource).CombinedOutput(); err != nil {
		t.Fatalf("fixture build: %v %s", err, out)
	}
	wrapper := filepath.Join(root, "portable.exe")
	if out, err := exec.Command("go", "test", "-c", "-o", wrapper, ".").CombinedOutput(); err != nil {
		t.Fatalf("launcher build: %v %s", err, out)
	}
	guiBytes, err := os.ReadFile(gui)
	if err != nil {
		t.Fatal(err)
	}
	entries := requiredEntries()
	entries[0].data = string(guiBytes)
	archive := wrapped(archiveBytes(t, entries))
	file, err := os.OpenFile(wrapper, os.O_APPEND|os.O_WRONLY, 0700)
	if err != nil {
		t.Fatal(err)
	}
	// wrapped's fake stub is harmless: ZIP is addressed relative to the final trailer.
	_, err = file.Write(archive)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	result := filepath.Join(root, "startup.json")
	command := exec.Command(wrapper, "-test.run=^TestPortableLauncherHelper$", "--", result, "forwarded argument")
	command.Env = append(os.Environ(), "NEDIA_PORTABLE_TEST_LAUNCHER=1", "TEMP="+root, "TMP="+root, "TMPDIR="+root)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(20 * time.Second):
		command.Process.Kill()
		t.Fatal("launcher did not release original executable")
	}
	var startup struct {
		File string
		Dir  string
		Cwd  string
		PID  int
		Args []string
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		data, err := os.ReadFile(result)
		if err == nil && json.Unmarshal(data, &startup) == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("GUI startup was not observed")
		}
		time.Sleep(50 * time.Millisecond)
	}
	process, err := os.FindProcess(startup.PID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { process.Kill(); process.Wait(); os.RemoveAll(startup.Cwd) }()
	marker, err := os.ReadFile(filepath.Join(startup.Cwd, cleanupMarker))
	if err != nil || !markerMatches(marker, startup.Cwd) {
		t.Fatalf("successful launch did not publish resource ownership: %v", err)
	}
	canonical, _ := filepath.EvalSymlinks(wrapper)
	if startup.File != canonical || startup.Dir != filepath.Dir(canonical) {
		t.Fatalf("original launcher location lost: %+v", startup)
	}
	if len(startup.Args) != 2 || startup.Args[1] != "forwarded argument" {
		t.Fatalf("arguments lost: %+v", startup)
	}
	if err := os.Rename(wrapper, wrapper+".backup"); err != nil {
		t.Fatalf("original launcher still locked: %v", err)
	}
	if err := os.WriteFile(wrapper, []byte("replacement"), 0700); err != nil {
		t.Fatal(err)
	}
}

// This injection exists only in the test binary. Production never accepts an
// environment variable that disables its WebView2 requirement.
func TestPortableLauncherHelper(t *testing.T) {
	if os.Getenv("NEDIA_PORTABLE_TEST_LAUNCHER") != "1" {
		return
	}
	executable, err := os.Executable()
	if err == nil {
		executable, err = filepath.EvalSymlinks(executable)
	}
	if err != nil {
		t.Fatal(err)
	}
	for i, arg := range os.Args {
		if arg == "--" {
			if err := launchWithPreflight(executable, os.Args[i+1:], func() error { return nil }); err != nil {
				t.Fatal(err)
			}
			return
		}
	}
	t.Fatal("missing fixture arguments")
}
