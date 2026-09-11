// Legate vault engine — runs inside a Vela confidential-compute enclave.
//
// Status: stub. Not yet implemented — see ../docs/ARCHITECTURE.md §3.2.
//
// Planned responsibilities:
//   - Decrypt incoming strategist intents (encrypted to this app's P-521 key).
//   - Enforce each strategy's registered mandate (allowed assets, max size,
//     drawdown stop) before accepting an intent into encrypted state.
//   - Net intents across strategies each execution epoch.
//   - Emit one combined order per asset, plus an attested per-strategy NAV
//     update, back to the on-chain custody contract.
package main

func main() {
	// TODO: wire up against vela-starterkit once local Vela environment
	// (Docker + emulated TEE) is confirmed working. See ../docs/ROADMAP.md.
}
