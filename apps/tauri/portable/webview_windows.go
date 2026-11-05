package main

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

const webViewRegistryKey = `SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`

func readWebViewVersion(hive syscall.Handle, view uint32) (string, error) {
	path, _ := syscall.UTF16PtrFromString(webViewRegistryKey)
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(hive, path, 0, syscall.KEY_QUERY_VALUE|view, &key); err != nil {
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) || errors.Is(err, syscall.ERROR_PATH_NOT_FOUND) {
			return "", nil
		}
		return "", err
	}
	defer syscall.RegCloseKey(key)
	name, _ := syscall.UTF16PtrFromString("pv")
	value := make([]uint16, 2048)
	size := uint32(len(value) * 2)
	var kind uint32
	err := syscall.RegQueryValueEx(key, name, nil, &kind, (*byte)(unsafe.Pointer(&value[0])), &size)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if kind != syscall.REG_SZ || size%2 != 0 || size > uint32(len(value)*2) {
		return "", errors.New("invalid WebView2 version registry value")
	}
	return syscall.UTF16ToString(value[:size/2]), nil
}

func webViewInstalled() (bool, error) {
	var failure error
	for _, hive := range []syscall.Handle{syscall.HKEY_LOCAL_MACHINE, syscall.HKEY_CURRENT_USER} {
		for _, view := range []uint32{syscall.KEY_WOW64_32KEY, syscall.KEY_WOW64_64KEY} {
			version, err := readWebViewVersion(hive, view)
			if err != nil {
				failure = err
				continue
			}
			if validWebViewVersion(version) {
				return true, nil
			}
		}
	}
	return false, failure
}

func checkStartupRequirements() error {
	return requireWebView(webViewInstalled, func() bool {
		title, _ := syscall.UTF16PtrFromString("NediaMatrix")
		message, _ := syscall.UTF16PtrFromString("此电脑缺少 Microsoft Edge WebView2 Runtime，NediaMatrix 尚未启动。\n\n是否打开微软官方下载页？请选择 Evergreen Runtime，安装完成后重新打开 NediaMatrix。")
		// Yes/No, question icon, default No. Opening the page requires a user choice.
		result, _, _ := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x04|0x20|0x100)
		return result == 6
	}, func(url string) error {
		verb, _ := syscall.UTF16PtrFromString("open")
		target, _ := syscall.UTF16PtrFromString(url)
		result, _, _ := syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(target)), 0, 0, 1)
		if result <= 32 {
			return fmt.Errorf("ShellExecuteW error %d", result)
		}
		return nil
	})
}
