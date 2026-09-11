# Legate: Roadmap

Maps directly to the Horizen Builder Fund milestone structure (M1 / M2 / M3).
See HORIZEN_RESEARCH.md (parent folder, not in this repo) for full grant context.

## Prerequisites (blocking, not yet done)

- [ ] Install Docker, Go, Node on the dev machine.
- [ ] Get Vela early access confirmed (form submitted 2026-09-11; awaiting reply).
- [ ] Run Vela's starter kit locally (`vela-starterkit`) against the hello-world
      example to confirm the local emulated-TEE environment actually works.
- [ ] Confirm with Horizen DevRel: is Vela really live on Base Sepolia (per
      horizenlabs.io/vela) or local-only (per docs.horizen.io)? This changes
      whether M1 can target a real network or only local dev.

## M1 — "Prove the hard part"

Target: a working demonstration that the core privacy mechanism actually works,
not just a mockup.

- [ ] `vela-app`: Go/WASM engine that accepts encrypted intents from ≥2 distinct
      strategies, enforces per-strategy mandates, and nets them.
- [ ] `contracts`: minimal custody contract on Horizen testnet that accepts a
      combined order instruction and executes it (against a testnet DEX or a
      mock router if no venue is live yet).
- [ ] Attested per-strategy NAV published and independently verifiable.
- [ ] **Privacy proof, not just a claim:** a public test/demo showing an observer
      watching only on-chain data cannot determine which strategy generated which
      trade in the combined order.
- [ ] Deliverable: repo + demo video + live testnet run link.

## M2 — Security audit

- [ ] Get quotes from 2–3 Foundry-approved auditors once contracts + engine are
      feature-complete.
- [ ] Scope: custody contract, entrypoint/exit contract, PureFi integration, and
      the Vela WASM engine itself (unusual audit surface — this code would
      normally be invisible server-side logic in a non-confidential system).
- [ ] Payment structure per Horizen: 50% on signed auditor agreement, 50% on
      passing result.

## M3 — Real mainnet usage

Thresholds TBD (Horizen's form asks us to propose these and "stand behind them" —
draft here, refine once M1 numbers exist):

- [ ] ≥ N active strategies with external depositors (draft target: 5)
- [ ] ≥ $Y TVL (draft target: TBD after M1 — depends on Horizen mainnet liquidity)
- [ ] ≥ Z unique depositors
- [ ] Protocol fee revenue > $0

## Explicitly deferred past M1

- Private deposit/withdrawal routing (see THREAT_MODEL.md §4.2)
- Multi-pool / risk-tiered strategy grouping
- ZEN staking integration details (fee-share mechanics)
- Token launch (none planned yet — see application answer)
