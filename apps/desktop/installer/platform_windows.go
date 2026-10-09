package main

import (
	"debug/pe"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")

func processAlive(pid int) bool {
	handle, err := syscall.OpenProcess(0x1000, false, uint32(pid))
	if err != nil {
		return err != syscall.Errno(87)
	}
	defer syscall.CloseHandle(handle)
	var code uint32
	if err := syscall.GetExitCodeProcess(handle, &code); err != nil {
		return true
	}
	return code == 259
}
func checkSpace(path string, needed uint64) error {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	var free uint64
	ok, _, err := kernel32.NewProc("GetDiskFreeSpaceExW").Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&free)), 0, 0)
	if ok == 0 {
		return err
	}
	if free < needed {
		return errors.New("insufficient disk space")
	}
	return nil
}

// NSIS/portable launchers may be 32-bit wrappers around the signed x64 application payload.
// Payload architecture is bound by the trusted manifest and the compiled distribution marker.
func validateExecutable(path string, r Request) error {
	file, err := pe.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	if r.Arch != "x64" || (file.Machine != pe.IMAGE_FILE_MACHINE_AMD64 && file.Machine != pe.IMAGE_FILE_MACHINE_I386) {
		return errors.New("executable architecture mismatch")
	}

	return validateVersionResource(path, r)
}
func validateBundle(path string, r Request) error { return errors.New("macOS bundle on Windows") }
func copyBundle(source, target string) error      { return errors.New("macOS bundle on Windows") }
func launchApplication(target string) error {
	command := exec.Command(target)
	command.Env = os.Environ()
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}

// ShellExecute invokes the visible installer and lets Windows handle UAC without a shell script.
func launchInstaller(target, directory string) error {
	operation, _ := syscall.UTF16PtrFromString("open")
	file, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	cwd, _ := syscall.UTF16PtrFromString(directory)
	result, _, _ := syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(operation)), uintptr(unsafe.Pointer(file)), 0, uintptr(unsafe.Pointer(cwd)), 1)
	if result <= 32 {
		return fmt.Errorf("installer could not be opened (Windows code %d); installation may have been cancelled", result)
	}
	return nil
}

// Version resources identify the product as well as the architecture of its outer wrapper.
func validateVersionResource(path string, r Request) error {
	versionDLL := syscall.NewLazyDLL("version.dll")
	file, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	size, _, _ := versionDLL.NewProc("GetFileVersionInfoSizeW").Call(uintptr(unsafe.Pointer(file)), 0)
	if size == 0 || size > 1024*1024 {
		return errors.New("missing or oversized executable version resource")
	}
	data := make([]byte, int(size))
	ok, _, _ := versionDLL.NewProc("GetFileVersionInfoW").Call(uintptr(unsafe.Pointer(file)), 0, size, uintptr(unsafe.Pointer(&data[0])))
	if ok == 0 {
		return errors.New("cannot read executable version resource")
	}
	query := func(key string) (unsafe.Pointer, uint32, error) {
		name, _ := syscall.UTF16PtrFromString(key)
		var pointer unsafe.Pointer
		var length uint32
		ok, _, _ := versionDLL.NewProc("VerQueryValueW").Call(uintptr(unsafe.Pointer(&data[0])), uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&pointer)), uintptr(unsafe.Pointer(&length)))
		if ok == 0 || pointer == nil {
			return nil, 0, errors.New("incomplete executable version resource")
		}
		return pointer, length, nil
	}
	pointer, length, err := query(`\`)
	if err != nil || length < 52 {
		return errors.New("invalid fixed executable version")
	}
	fixed := unsafe.Slice((*uint32)(pointer), 13)
	if fixed[0] != 0xFEEF04BD {
		return errors.New("invalid executable version signature")
	}
	expected := strings.Split(r.Version, ".")
	if len(expected) != 3 {
		return errors.New("invalid requested version")
	}
	actual := []uint32{fixed[4] >> 16, fixed[4] & 65535, fixed[5] >> 16}
	for index, part := range expected {
		value, err := strconv.ParseUint(part, 10, 16)
		if err != nil || uint32(value) != actual[index] {
			return errors.New("executable product version mismatch")
		}
	}
	translations, translationSize, err := query(`\VarFileInfo\Translation`)
	if err != nil || translationSize < 4 || translationSize > 1024 {
		return errors.New("missing executable product identity")
	}
	languages := unsafe.Slice((*uint16)(translations), int(translationSize)/2)
	for index := 0; index+1 < len(languages); index += 2 {
		key := fmt.Sprintf(`\StringFileInfo\%04x%04x\ProductName`, languages[index], languages[index+1])
		value, length, err := query(key)
		if err != nil || length > 4096 {
			continue
		}
		name := syscall.UTF16ToString(unsafe.Slice((*uint16)(value), int(length)))
		if name == "NediaMatrix" {
			return nil
		}
	}
	return errors.New("executable product name mismatch")
}

func preserveQuarantine(source, current, staged string) error { return nil }
