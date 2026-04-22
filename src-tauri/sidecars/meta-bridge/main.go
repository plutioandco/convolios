// meta-bridge — Convolios on-device Meta bridge sidecar.
//
// This process runs locally on the user's Mac (spawned by the Tauri parent)
// and connects to Instagram / Facebook Messenger from the user's home IP.
// Credentials never leave the device. All IPC with the parent happens over
// a single Unix domain socket speaking newline-delimited JSON-RPC 2.0.
//
// Licensing: once the messagix integration is wired in, this binary links
// against AGPL-3.0-licensed code (github.com/mautrix/meta). The whole
// sidecar is therefore distributed under AGPL-3.0. The Convolios parent
// app remains proprietary: communication happens exclusively through a
// clearly-defined IPC boundary (this JSON-RPC socket), which the FSF's own
// AGPL FAQ treats as a separate-program boundary.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

func main() {
	socketPath := flag.String("socket", "", "Unix socket path to listen on (required)")
	flag.Parse()

	if *socketPath == "" {
		fatal("--socket is required")
	}

	// Best-effort cleanup of any stale socket file at the requested path
	// before we bind. Tauri passes us a fresh, UUID-suffixed path so this
	// should always be a no-op in practice, but it makes local repro nicer.
	_ = os.Remove(*socketPath)

	listener, err := net.Listen("unix", *socketPath)
	if err != nil {
		fatal("listen: %v", err)
	}
	defer listener.Close()
	defer os.Remove(*socketPath)

	// Restrict the socket to the current user. Unix file mode gives us
	// kernel-enforced process isolation — only the Convolios parent (same
	// uid) can connect to us.
	if err := os.Chmod(*socketPath, 0o600); err != nil {
		fatal("chmod socket: %v", err)
	}

	// Signal readiness on stdout. The Rust parent reads stdout until it
	// sees "ready\n" and only then dials the socket. Anything before this
	// line is treated as diagnostic noise.
	fmt.Println("ready")

	bridge := NewBridge()
	srv := NewServer(bridge)

	// Graceful shutdown on SIGINT/SIGTERM. Tauri normally kills us via
	// SIGKILL on app quit (kill_on_drop on the tokio Child), but being a
	// good citizen under `lldb`/`kill` is free.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigs
		cancel()
		listener.Close()
	}()

	var wg sync.WaitGroup
	for {
		conn, err := listener.Accept()
		if err != nil {
			// Accept fails on listener close during shutdown. Any other
			// error on a fresh socket is fatal.
			if ctx.Err() != nil {
				break
			}
			fatal("accept: %v", err)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			srv.Serve(ctx, conn)
		}()
	}
	wg.Wait()
	bridge.Shutdown()
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

// logf writes a prefixed line to stderr. Stderr is streamed to the Rust
// parent's log, so every diagnostic ends up in Convolios's own log files.
func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[meta-bridge] "+format+"\n", args...)
}

// writeJSON writes a single JSON value followed by a newline. All outbound
// frames — responses and notifications — go through this helper so the
// framing is consistent.
func writeJSON(w writerWithLock, value any) error {
	bytes, err := json.Marshal(value)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	bytes = append(bytes, '\n')
	_, err = w.w.Write(bytes)
	return err
}
