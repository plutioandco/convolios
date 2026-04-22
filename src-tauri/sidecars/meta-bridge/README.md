# meta-bridge

The on-device Meta (Instagram + Facebook Messenger) bridge sidecar for
Convolios.

- Runs locally on the user's Mac, spawned by the Tauri parent process.
- Connects to Instagram / Messenger from the user's home IP and saved
  session — **not** from a Convolios server.
- Credentials never leave the device. The Tauri parent stores cookies +
  device tokens in the macOS Keychain and hands them back to this sidecar
  on resume.
- IPC with the parent is a single Unix domain socket speaking
  newline-delimited JSON-RPC 2.0. See `rpc.go` for the protocol and
  `bridge.go` for the method list.

## Build

```
go build -o meta-bridge .
```

A debug build is fine for development. For shipped builds, Tauri's sidecar
bundler invokes `go build -ldflags="-s -w"` through the build hook to
produce a stripped binary.

## Run standalone (for protocol debugging)

```
./meta-bridge --socket /tmp/meta-bridge.sock --mock
```

`--mock` makes the bridge accept any non-empty credentials and emit a
synthetic inbound message every 45 s. Use this to exercise the full Rust →
frontend → Supabase pipeline before wiring up messagix.

The special username `challenge@me` triggers the 2FA path in mock mode.
The accepted 2FA code is `123456`.

## Plugging in messagix

The real Meta integration goes at the marked `TODO(messagix)` blocks in
`bridge.go`. Steps:

1. Add the dependency:
   ```
   go get go.mau.fi/meta
   ```
2. Implement the four marked blocks: `Login`, `Challenge`, `Resume`,
   `runEventLoop`, `SendMessage`. Each block's comment describes the
   exact messagix call to make.
3. Rebuild. The protocol between the sidecar and the parent does not
   change — the frontend and Rust code are already wired for real events.

## Licensing

The skeleton in this folder is MIT-licensed (see repository root). The
moment `go.mau.fi/meta` is added as a dependency, the built binary is
covered by AGPL-3.0 and its full source must be published. The Convolios
parent app remains proprietary: the IPC boundary (this JSON-RPC socket)
is treated as a separate-program boundary by the FSF's own AGPL FAQ.

In practice: when you're ready to ship the real bridge, move this folder
to a dedicated public repo (e.g. `plutioandco/convolios-meta-bridge`),
vendor it as a `git submodule` or Tauri `externalBin` build dependency,
and flip the license header.
