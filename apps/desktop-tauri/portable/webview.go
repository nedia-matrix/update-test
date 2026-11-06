package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

var errStartupExplained = errors.New("WebView2 Runtime is required; install it and reopen NediaMatrix")

const webViewDownloadURL = "https://developer.microsoft.com/microsoft-edge/webview2/#download-section"

func validWebViewVersion(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) != 4 {
		return false
	}
	var nonzero bool
	for _, part := range parts {
		if part == "" || strings.Trim(part, "0123456789") != "" {
			return false
		}
		n, err := strconv.ParseUint(part, 10, 32)
		if err != nil {
			return false
		}
		nonzero = nonzero || n != 0
	}
	return nonzero
}

func requireWebView(check func() (bool, error), ask func() bool, open func(string) error) error {
	installed, err := check()
	if err != nil {
		return fmt.Errorf("无法检查 WebView2 Runtime，请检查系统权限后重试: %w", err)
	}
	if installed {
		return nil
	}
	if ask() {
		if err := open(webViewDownloadURL); err != nil {
			return fmt.Errorf("无法打开微软 WebView2 下载页，请访问 %s 并安装 Evergreen Runtime 后重新启动: %w", webViewDownloadURL, err)
		}
	}
	return errStartupExplained
}
