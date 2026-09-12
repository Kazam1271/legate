APP := legate_app

# TinyGo 0.39.0 supports Go 1.19 through 1.25 only. The system Go is newer, so
# builds go through a pinned 1.24 toolchain that matches Vela's own CI. Override
# GO_BIN if yours lives elsewhere.
GO_BIN ?= $(HOME)/sdk/go1.24.13/bin

.PHONY: build production_build test vet fmt doctor clean

# Fast unit tests. These run under the system Go — no enclave, no TinyGo needed.
test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -w .

# Development WASM build.
build:
	@mkdir -p build
	PATH="$(GO_BIN):$$PATH" tinygo build -o build/$(APP).wasm -target=wasi .

# Optimised artifact for deployment.
production_build:
	@mkdir -p production_build
	PATH="$(GO_BIN):$$PATH" tinygo build -o production_build/$(APP).wasm -opt=s -no-debug -target=wasi .

# Verifies the toolchain, which has three non-obvious requirements.
doctor:
	@echo "system go:  $$(go version)"
	@echo "pinned go:  $$($(GO_BIN)/go version 2>/dev/null || echo 'MISSING - see docs/TOOLCHAIN.md')"
	@echo "tinygo:     $$(tinygo version 2>/dev/null || echo 'MISSING')"
	@echo "wasm-opt:   $$(wasm-opt --version 2>/dev/null || echo 'MISSING - required by tinygo for wasm targets')"

clean:
	rm -rf build production_build
