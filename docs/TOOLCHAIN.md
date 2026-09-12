# Toolchain setup

Getting Go code into a Vela enclave needs three things beyond a normal Go setup.
None of them are documented by Vela and each fails in a way that does not point at
the cause, so they are recorded here.

Verify everything with:

```bash
cd vela-app && ./build.sh doctor
```

A healthy setup prints four lines with no `MISSING`:

```
system go:  go version go1.27.0 windows/amd64
pinned go:  go version go1.24.13 windows/amd64
tinygo:     tinygo version 0.39.0 windows/amd64
wasm-opt:   wasm-opt version 132
```

There are two equivalent entry points: a `Makefile`, matching the convention in
Vela's own repos and what CI will use, and `build.sh`, which mirrors it for
machines without `make` (Git for Windows does not ship one). Both take the same
targets: `doctor`, `test`, `vet`, `fmt`, `build`, `production_build`, `clean`.

## 1. TinyGo, pinned to 0.39.0

Vela's CI builds guest WASM with TinyGo 0.39.0. Match it — the guest ABI and
runtime behaviour are tied to the TinyGo version.

Installed at `~/tinygo`, on PATH as `~/tinygo/bin`.

## 2. A second Go toolchain at 1.24

**TinyGo 0.39.0 supports Go 1.19 through 1.25 only.** A newer system Go fails with:

```
requires go version 1.19 through 1.25, got go1.27
```

Note `tinygo version` happily reports the unsupported Go version without
complaint — only the build rejects it.

Rather than downgrading the system Go, install a second toolchain:

```bash
go install golang.org/dl/go1.24.13@latest
go1.24.13 download          # unpacks to ~/sdk/go1.24.13
```

Then put it **first** on PATH when invoking TinyGo. The Makefile does this via
`GO_BIN`. 1.24 also matches what Vela's own CI uses.

## 3. wasm-opt, from Binaryen

TinyGo shells out to `wasm-opt` for every wasm target, and the Windows release
zip does not bundle it:

```
error: could not find wasm-opt, set the WASMOPT environment variable to override
```

Install Binaryen and put its `bin` on PATH (installed here at `~/binaryen`), or
set `WASMOPT` to the binary.

## Gotcha: do not install TinyGo into its own cache directory

On Windows, TinyGo's cache directory is `%LOCALAPPDATA%\tinygo`. Installing the
distribution to that same path makes its install tree and its merged-GOROOT cache
collide, producing a pile of misleading errors:

```
package internal/task is not in std (...\tinygo\goroot-<hash>\src\internal\task)
package reflect is not in std (...)
```

Nothing is wrong with the Go installation — TinyGo is mixing its own `src/` with
the merged GOROOT it generates. Install anywhere else (`~/tinygo` here) and the
cache directory stays free.

## What is verified to work

The whole `app` package compiles to WASM under this toolchain, including `sort`,
`encoding/json` and `math/bits`. `sort` matters: map iteration must be ordered for
determinism, and TinyGo supports it.

## Testing without any of this

The engine's logic is plain Go and needs neither TinyGo nor an enclave:

```bash
cd vela-app && go test ./...
```

Only building the deployable `.wasm` needs the toolchain above, and only running
the full local stack needs Docker.
