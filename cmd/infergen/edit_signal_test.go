//go:build unix

package main

import (
	"syscall"
	"testing"
)

// The command stops cleanly on the signals a terminal or a service manager
// sends. The test process receives them itself, which the command's handler
// catches while it runs.
func TestEditStopsOnSignals(t *testing.T) {
	for _, signal := range []syscall.Signal{syscall.SIGINT, syscall.SIGTERM} {
		t.Run(signal.String(), func(t *testing.T) {
			editFixture(t)
			run := startEdit(t, refuseOpen(t), "--rules", "bonus.go")
			if err := syscall.Kill(syscall.Getpid(), signal); err != nil {
				t.Fatal(err)
			}
			if err := <-run.done; err != nil {
				t.Fatalf("edit returned %v after %v", err, signal)
			}
			run.done <- nil
		})
	}
}
