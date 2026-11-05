//go:build !windows

package main

import "errors"

// The portable product is Windows-only. POSIX permits writing mapped images,
// so the Windows deletion protocol must never be emulated with a PID check.
func removeInactiveDirectory(string) error { return errors.New("cleanup requires Windows file guards") }
