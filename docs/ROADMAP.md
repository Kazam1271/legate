# Legate: Roadmap

Maps directly to the Horizen Builder Fund milestone structure (M1 / M2 / M3).
See HORIZEN_RESEARCH.md (parent folder, not in this repo) for full grant context.

_Status as of 2026-09-13._

## Prerequisites

- [x] Install Docker, Go, Node and TinyGo on the dev machine (see TOOLCHAIN.md).
- [x] Run Vela's local stack from `vela-starterkit`. Legate itself now runs end to
      end on it, so the emulated-TEE environment is confirmed working.
- [ ] Get Vela early access confirmed (form submitted 2026-09-11; awaiting reply).
- [ ] Confirm with Horizen DevRel: is Vela really live on Base Sepolia (per
      horizenlabs.io/vela) or local-only (per docs.horizen.io)? This changes
      whether M1 can target a real network or only local dev.

## M1 — "Prove the hard part"

Target: a working demonstration that the core privacy mechanism actually works,
not just a mockup.

- [x] `vela-app`: Go/WASM engine that accepts encrypted intents from ≥2 distinct
      strategies, enforces per-strategy mandates, and nets them. Runs in Vela's
      executor on the local stack.
- [x] `contracts`: `LegateTrigger` executes the combined order and reports the fill
      back into the enclave, tested against a fixed-price router since no venue is
      live. Custody stays with Vela's `ProcessorEndpoint` rather than a bespoke
      contract (ARCHITECTURE.md §3.3).
- [x] Depositors can exit: redeem, withdraw and claim, run live.
- [x] **Privacy shown on the local stack, not just claimed.** `e2e-local.mjs`
      checks that the chain sees only the netted order while each manager
      decrypts their own full fill, that every request is the same size, and that
      a refused intent looks identical to an accepted one on chain.
- [x] Fix the issue that let one strategy block batching (ARCHITECTURE.md §3.4).
      Fixed 2026-09-13: `close_batch` names its pair, and managers can cancel
      queued intents.
- [ ] Attested per-strategy NAV published and independently verifiable. Not
      started.
- [ ] Deploy on a public testnet (blocked on the DevRel question above).
- [ ] Deliverable: public repo, demo video, and a live testnet run link. The repo
      is not yet pushed anywhere.

## M2 — Security audit

- [ ] Get quotes from 2–3 Foundation-approved auditors once contracts + engine are
      feature-complete.
- [ ] Scope: `LegateTrigger`, the Vela WASM engine itself (an unusual audit
      surface — this code would normally be invisible server-side logic in a
      non-confidential system), and a PureFi integration if one is built by then.
- [ ] Payment structure per Horizen: 50% on signed auditor agreement, 50% on
      passing result.

## M3 — Real mainnet usage

Thresholds TBD (Horizen's form asks us to propose these and "stand behind them" —
draft here, refine once M1 numbers exist):

- [ ] ≥ N active strategies with external depositors (draft target: 5)
- [ ] ≥ $Y TVL (draft target: TBD after M1 — depends on Horizen mainnet liquidity)
- [ ] ≥ Z unique depositors
- [ ] Protocol fee revenue > $0 (needs fees, which are not built yet)

## Explicitly deferred past M1

- Private deposit/withdrawal routing (see THREAT_MODEL.md §4.2)
- Multi-pool / risk-tiered strategy grouping
- ZEN staking integration details (fee-share mechanics)
- Token launch (none planned yet — see application answer)
