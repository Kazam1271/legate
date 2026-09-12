#!/usr/bin/env bash
# Mirrors the Makefile targets for machines without make (e.g. Git Bash on
# Windows). Usage: ./build.sh [doctor|test|vet|fmt|build|production_build|clean]
set -euo pipefail

APP="legate_app"

# TinyGo 0.39.0 supports Go 1.19 through 1.25 only, so builds use a pinned 1.24
# toolchain rather than the system Go. See docs/TOOLCHAIN.md.
GO_BIN="${GO_BIN:-$HOME/sdk/go1.24.13/bin}"

cmd="${1:-test}"

case "$cmd" in
  doctor)
    echo "system go:  $(go version 2>/dev/null || echo MISSING)"
    if [ -x "$GO_BIN/go" ]; then
      echo "pinned go:  $("$GO_BIN/go" version)"
    else
      echo "pinned go:  MISSING at $GO_BIN — see docs/TOOLCHAIN.md"
    fi
    echo "tinygo:     $(tinygo version 2>/dev/null || echo MISSING)"
    echo "wasm-opt:   $(wasm-opt --version 2>/dev/null || echo 'MISSING — tinygo needs it for wasm targets')"
    ;;
  test)
    go test ./...
    ;;
  vet)
    go vet ./...
    ;;
  fmt)
    gofmt -w .
    ;;
  build)
    mkdir -p build
    PATH="$GO_BIN:$PATH" tinygo build -o "build/$APP.wasm" -target=wasi .
    ls -la "build/$APP.wasm"
    ;;
  production_build)
    mkdir -p production_build
    PATH="$GO_BIN:$PATH" tinygo build -o "production_build/$APP.wasm" -opt=s -no-debug -target=wasi .
    ls -la "production_build/$APP.wasm"
    ;;
  clean)
    rm -rf build production_build
    ;;
  *)
    echo "unknown target: $cmd" >&2
    echo "usage: ./build.sh [doctor|test|vet|fmt|build|production_build|clean]" >&2
    exit 1
    ;;
esac
