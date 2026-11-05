package main

import (
	"syscall"
	"unsafe"
)

func reportError(err error) {
	title, _ := syscall.UTF16PtrFromString("NediaMatrix")
	message, _ := syscall.UTF16PtrFromString("Portable startup failed: " + err.Error())
	syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
}
