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
- Go, compiled to WASM with **TinyGo** (Vela pins v0.39.0), runs inside the Vela
  enclave. Legate is *one* app handling many strategies as data, not one app per
  strategy.
  > **Corrected 2026-09-12.** This was previously justified by "Vela allows a single
  > WASM app per environment". That is out of date: v0.2.0 derives a fresh
  > `applicationId` per deploy and ships `multi_app_isolation_test.go`, so multiple
  > apps are supported. One app for all strategies remains the right choice anyway —
  > netting across strategies requires them to share state, which separate apps
  > could not do.
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

### 3.3 Trigger contract (`contracts/`)

_Implemented in `contracts/contracts/LegateTrigger.sol`._

Two properties worth recording, both consequences of how the venue is called:

- **The residual is all-or-nothing.** A buy asks the router for an exact output
  and a sell supplies an exact input, so the order either fills within the
  enclave's bound or the swap reverts. Asking for an exact output on a buy is
  also what stops a favourable price handing the pool more base than the batch
  has owners for. The partial-fill handling in settlement therefore exists for
  venues that can fill partially, such as an order book like ZENDEX, rather than
  for a constant-product router.
- **A failed swap is a safe outcome, not a lost one.** The endpoint catches the
  revert, the base class sweeps every token back, and the trigger still returns a
  payload marking the leg failed. The enclave then settles the internally crossed
  volume and leaves only the residual unfilled. Returning nothing on failure
  would strand the batch, because the enclave holds it open until told what
  happened.

> **Revised 2026-09-12** after reading the Vela v0.2.0 sources. The original plan —
> a bespoke custody contract that verifies enclave attestations itself — would
> re-implement what `ProcessorEndpoint` already does. Vela ships a purpose-built
> mechanism for exactly this, the **trigger-contract flow**, and we should use it.

- Solidity, on Horizen L3, extending Vela's `AbstractTrigger`. We override two
  hooks (`_execute`, `_getTrustProcessPayload`); the base class supplies the
  `onlyProcessorEndpoint` guard and the non-overridable sweep.
- **Custody stays with `ProcessorEndpoint`**, which already verifies the TEE
  signature on every state update. The enclave still never custodies funds.
- The round trip per execution:
  1. the engine returns a `Withdrawal` to the trigger — funds move in (unshield),
  2. it emits one `AppEvent` with ABI-encoded order parameters,
  3. `trigger.execute()` performs the swap from the pool's own address,
  4. `trigger.withdraw()` sweeps the proceeds back (reshield),
  5. `getTrustProcessPayload()` returns the fill, which re-enters the enclave as a
     `TRUSTPROCESS` request handled by the `trusted_request` export.
- This is what lets the enclave act on a public venue without revealing whom it is
  acting for. If `_execute` reverts, the full amount is swept back and depositors
  are made whole.
- Deposits/withdrawals gate through PureFi (`verifier.validatePayload`) before the
  contract accepts funds.
- Emits public events: pooled NAV, per-strategy NAV (attested by the enclave, not
  computed on-chain), fee accrual. Never emits per-trade, per-strategy execution
  detail.

### 3.5 Netting and settlement

_Implemented in `vela-app/app/netting.go` and `settle.go`._

Netting is what produces the privacy. Intents are denominated in base units on
both sides, so opposing flow cancels directly:

```
crossed  = min(total_buy, total_sell)     matched inside the enclave, never on chain
residual = |total_buy - total_sell|       the single public order
```

Crossed volume does not merely hide — it never reaches the market, so it incurs
no slippage, no fee and leaves no footprint. Two guards keep the guarantee real:
`MinContributors` (the k-anonymity guard, since with one contributor the residual
*is* that strategy's order) and `MinResidual` (a very small public order is
uneconomic and unusually identifying).

**The clearing price is the price the market actually gave**, and everyone
settles at it, including those who crossed internally. This is forced, not
chosen. With clearing price P, the net quote the pool must find is
`filledBase × P`, while the quote it actually paid or received is `filledQuote`,
so `P = filledQuote / filledBase` is the only value at which the books balance.

Settling everyone at one price is also a privacy property in its own right. If
crossed and market-executed participants got different prices, each could tell
from their own fill which group they were in, and thereby learn something about
the rest of the batch.

Consequences worth knowing:

- **A failed market leg still settles the cross.** Internal matching has no
  external dependency, so if the on-chain call reverts, crossed participants are
  filled anyway at the reference price and only the residual goes unfilled.
- **Partial fills fall on the larger side**, pro-rata. The smaller side is
  always fully satisfied, because it is entirely absorbed by the cross.
- **Rounding is conserved exactly.** Proportional shares round down, and the
  remainder is handed out one unit at a time in a fixed order. No unit is ever
  created or destroyed; the tests assert this directly.
- **Limit prices are checked against the reference price before execution, but
  the realised price can differ.** The trigger contract's on-chain slippage bound
  is the actual protection. The enclave additionally flags a breach on
  settlement, since by then the trade has already happened and refusing it would
  only strand the batch.

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

## 5. Dependencies on Horizen infra

_Re-checked 2026-09-12 against the Vela v0.2.0 sources and starter-kit docs, which
are considerably newer than the published docs site._

Still blocking:

- **Vela on a real network.** `docs.horizen.io` says local-only; `horizenlabs.io/vela`
  advertises early access on Base Sepolia. Still unresolved — ask DevRel. This
  decides whether M1 can target a network or only local dev.
- **A live Horizen execution venue with real liquidity.** ZENDEX and DarkSwap are
  both still "coming soon".

No longer blocking (previously listed as blockers):

- ~~Vela ERC-20 support~~ — **shipped in v0.2.0.** There is a standalone
  `TokenAllowlist` contract injected into `ProcessorEndpoint`, `deposit` takes a
  token address (`0x0` = ETH), `Withdrawal` carries a `TokenAddress`, and the
  reference app has `erc20_fullstack_test.go` and `private_transfer_erc20_test.go`.
  USDC.e deposits are therefore possible now.
- ~~One WASM app per environment~~ — multi-app isolation is supported (see §3.2).

These gate what M1 can actually demonstrate. See ROADMAP.md.
