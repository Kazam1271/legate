# Legate: Architecture

Status: **design draft, unimplemented**. This describes the target system, not what
exists yet. See [ROADMAP.md](ROADMAP.md) for what M1 actually proves.

## 1. Goals

- Strategists keep their model and live positions private from everyone, including
  Legate's operators.
- Depositors get a verifiable performance record per strategy, without seeing
  positions.
- The chain sees pooled, netted flow — not per-strategy trades — so no single
  counterparty can reconstruct one strategy's book from public data alone.
- Custody of funds lives in an auditable on-chain contract, not inside the enclave.
  The enclave decides *what* to trade; the contract is what actually *holds and
  moves* money.
- Every privacy claim maps to a specific mechanism, not "trust the enclave."

## 2. Components

```
                      ┌─────────────────────────┐
  Strategist  ──sign──▶  encrypted intent (P-521) │
  (off-chain)          └─────────────┬───────────┘
                                      │ submitted on-chain
                                      ▼
                        ┌───────────────────────────┐
                        │  ProcessorEndpoint (L3)    │   Horizen Chain
                        │  - receives intent tx      │
                        │  - queues for the enclave  │
                        └─────────────┬─────────────┘
                                      │ picked up by Processor Manager
                                      ▼
                    ┌───────────────────────────────────┐
                    │        Vela WASM Vault Engine       │   AWS Nitro Enclave
                    │  (Go, compiled to WASM, wasmtime)   │
                    │  - decrypts intent w/ TEE key       │
                    │  - checks mandate (asset/size/DD)   │
                    │  - updates encrypted per-strategy   │
                    │    position + per-depositor share   │
                    │    state (versioned LevelDB)        │
                    │  - nets intents across strategies   │
                    │    each execution epoch             │
                    │  - emits ONE combined order +        │
                    │    attested NAV update               │
                    └─────────────┬───────────────────────┘
                                  │ attested result + state root
                                  ▼
                  ┌───────────────────────────────────┐
                  │     Custody / Exit Contract         │   Horizen Chain
                  │  - holds all pooled depositor funds │
                  │  - executes the ONE combined order   │
                  │    against a Horizen venue            │
                  │    (ZENDEX / DarkSwap / AMM)          │
                  │  - verifies the enclave attestation   │
                  │    before acting on its instruction   │
                  │  - posts per-strategy NAV events       │
                  └─────────────┬───────────────────────┘
                                  │
                     ┌────────────┴────────────┐
                     ▼                          ▼
            Depositor deposits/          Auditor (via Vela
            withdraws (PureFi-gated)     Authority Service)
```

## 3. Components in detail

### 3.1 Strategist client (`sdk/`)
- TypeScript library. Holds two keys per Vela's model: a **secp256k1** key for
  on-chain tx signing, and a **P-521** key to encrypt intents to the enclave.
- An "intent" is: strategy ID, asset, direction, size (or size formula), max
  slippage, and a validity window. Not a raw order — the engine enforces the
  strategy's registered mandate (max position, allowed assets, drawdown stop)
  independently, so a compromised or buggy strategist client can't exceed mandate.
- Submits the encrypted intent as an L3 transaction to `ProcessorEndpoint`.

### 3.2 Vault engine (`vela-app/`)
- Go, compiled to WASM, runs inside the Vela enclave (`vela-nova`-style single WASM
  app per environment — this is why Legate is *one* app handling many strategies as
  data, not one app per strategy).
- State: per-strategy position + mandate, per-depositor share balance, encrypted,
  versioned (LevelDB per Vela's model), never readable in plaintext outside the
  enclave.
- On each execution epoch (target: every N minutes, TBD from gas/venue latency
  testing):
  1. Collect all valid queued intents.
  2. Net them against current positions and against each other (opposing intents on
     the same asset across strategies partially cancel before hitting the market).
  3. Emit **one** combined order per asset to the custody contract, not one order
     per strategy.
  4. Recompute and attest each strategy's NAV and each depositor's share value.
- Everything to the market is `total = Σ(strategy positions)` — never a
  strategy-by-strategy breakdown.

### 3.3 Custody contract (`contracts/`)
- Solidity, on Horizen L3.
- Holds all depositor funds. **The enclave never custodies funds directly** — it
  only instructs the contract, and the contract only acts on an attested
  instruction it can cryptographically verify came from the registered enclave.
- Executes the combined order against a Horizen execution venue.
- Deposits/withdrawals gate through PureFi (`verifier.validatePayload`) before the
  contract accepts funds.
- Emits public events: pooled NAV, per-strategy NAV (attested by the enclave, not
  computed on-chain), fee accrual. Never emits per-trade, per-strategy execution
  detail.

### 3.4 Auditing
- Vela's Authority Service can produce a deanonymization report (balances snapshot
  or transaction history) for an authorized auditor, generated inside the TEE and
  encrypted to the auditor's key. This is Legate's compliance path — not a public
  block explorer trail.

## 4. Open design questions (tracked, not yet answered)

- **Netting granularity.** Net per-asset globally, or net within pools of
  similar-risk strategies? Global netting hides more but couples unrelated
  strategies' execution timing.
- **Minimum strategies per pool before launch.** A pool with 1–2 dominant
  strategies leaks almost as much as a public vault (see THREAT_MODEL.md).
- **Execution venue selection.** ZENDEX and DarkSwap are both "coming soon" per
  Horizen's ecosystem page as of Sep 2026 — Legate may need to launch against a
  standard Horizen AMM first and add private venues as they ship.
- **Fee split mechanics.** Strategist / protocol / ZEN staking pool split, and
  whether strategists must stake ZEN to list (see HORIZEN_RESEARCH.md §9).
- **Bad-debt / drawdown handling.** What happens if a strategy blows through its
  mandate before the engine catches it (oracle lag, extreme volatility)?

## 5. Dependencies on Horizen infra (not yet available)

- Vela on Horizen testnet/mainnet (docs say local-only as of Sep 2026; ask DevRel).
- Vela ERC-20 support (not shipped as of Sep 2026 — needed for USDC.e deposits).
- A live Horizen execution venue with real liquidity.

These gate what M1 can actually demonstrate. See ROADMAP.md.
