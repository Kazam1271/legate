module github.com/Kazam1271/legate/vela-app

// Pinned to 1.24 to match the Vela platform modules and TinyGo 0.39.0, which is
// what Vela's CI builds guest WASM with. A newer language version here risks
// code TinyGo cannot compile.
go 1.24.0

require github.com/HorizenOfficial/vela-common-go v0.2.0
