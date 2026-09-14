# Legate: Architecture

Status: **implemented, except where marked.** Everything described here runs end
to end on a local Vela stack unless its section says otherwise. The original
design also called for published NAV attestations, a drawdown stop and a PureFi
gate. None of them is built; §6 lists every gap between the design and the code.
See [ROADMAP.md](ROADMAP.md) for milestone status.

## 1. Goals

- Strategists keep their model and live positions private from everyone, including
  Legate's operators. Authorised auditors are the deliberate exception (§3.6).
- Depositors get a verifiable performance record per strategy, without seeing
  positions. _Not yet met: nothing publishes NAV or performance (§6)._
- The chain sees pooled, netted flow — not per-strategy trades — so no single
  counterparty can reconstruct one strategy's book from public data alone.
- Custody of funds stays on chain, in Vela's `ProcessorEndpoint`, not inside the
  enclave. The enclave decides *what* to trade; the chain is what actually *holds
  and moves* money.
- Every privacy claim maps to a specific mechanism, not "trust the enclave."

## 2. Components

The system as built:

```
  Strategists, depositors, operator (off-chain)
                      │ encrypted to the enclave's P-521 key,
                      │ every request padded to the same size
                      ▼
  ┌──────────────────────────────────────┐
  │ ProcessorEndpoint (Vela)             │  chain
  │ - queues requests                    │
  │ - holds custody of all funds         │
  │ - applies only state updates the     │
  │   enclave has signed                 │
  └───────────────────┬──────────────────┘
                      │ relayed by Vela's Processor Manager
                      ▼
  ┌──────────────────────────────────────┐
  │ Legate WASM app (Vela enclave)       │  enclave
  │ - checks mandates and affordability  │
  │ - holds balances, shares and a       │
  │   custody mirror, all encrypted      │
  │ - on close_batch: nets the intents,  │
  │   emits one order, funds the trigger │
  └───────────────────┬──────────────────┘
                      │ signed update: order event + withdrawal
                      ▼
  ┌──────────────────────────────────────┐
  │ LegateTrigger                        │  chain
  │ - swaps the one order through a      │
  │   router, within the quote bound     │
  │ - sweeps tokens back to the endpoint │
  │ - reports the fill                   │
  └───────────────────┬──────────────────┘
                      │ TRUSTPROCESS request
                      ▼
  Legate WASM app settles every participant at one clearing
  price and sends each manager a private fill event.

  Auditors: Vela's Authority Service can request a report of
  strategy balances from the app (§3.6).
```

## 3. Components in detail

### 3.1 Client SDK (`sdk/`, `@legate/sdk`)

_Implemented, tested._ TypeScript, wrapping Vela's `@horizen/vela-common-ts`
client. `contracts/scripts/e2e-local.mjs` still exists as the lower-level
reference, built directly on `@horizen/vela-common-ts` before the SDK did.

- One client class (`LegateClient`) serves every role — strategy managers,
  depositors, the operator — since the enclave decides who may do what, not the
  client.
- Key handling is Vela's own: `@horizen/vela-common-ts` derives both keys the
  model requires — the **secp256k1** key that signs the on-chain transaction, and
  the **P-521** key used to encrypt requests to the enclave — from the connected
  signer, and `registerKey()` associates the P-521 key on first use.
- Commands are built, not written by hand (`commands.ts`), and validated locally
  before anything is sent: a buy without a limit price, a negative or
  out-of-range amount, an empty strategy ID, and similar mistakes are refused for
  free rather than costing a request fee. An intent is: strategy ID, base token,
  side, amount in base units, and a limit price, required for buys. There is no
  validity window and no size formula — the engine enforces the strategy's
  mandate itself, so a compromised or buggy client cannot exceed it.
- Every command is padded to a fixed size before encryption, and the enclave
  refuses any other length (THREAT_MODEL.md §4.4). `submit()` does this
  automatically; `padPayload()` is exposed directly for anything encrypting a
  command outside the client.
- A rejection by the rules is not thrown as an error: `submit()` returns
  `{status: 'rejected', reason}`, decrypted from the sender's own private
  receipt, distinct from `RequestFailedError` for a request the enclave refused
  publicly on chain.
- The Go structs and the TypeScript builders implement the same wire format
  independently, in different languages. A shared fixture
  (`sdk/test/fixtures/commands.json`) holds them to it: the SDK's test suite
  asserts the builders still produce exactly that JSON, and
  `vela-app/app/sdk_fixture_test.go` decodes it with unknown fields disallowed
  and checks every value, including one end-to-end run through the real
  handlers. A mismatch here would otherwise surface only against a live enclave,
  as a command that silently did something other than intended.

### 3.2 Vault engine (`vela-app/`)

_Implemented._

- Go, compiled to WASM with **TinyGo** (Vela pins v0.39.0), running inside the
  Vela enclave. Legate is *one* app handling many strategies as data, not one app
  per strategy.
  > **Corrected 2026-09-12.** This was previously justified by "Vela allows a single
  > WASM app per environment". That is out of date: v0.2.0 derives a fresh
  > `applicationId` per deploy and ships `multi_app_isolation_test.go`, so multiple
  > apps are supported. One app for all strategies remains the right choice anyway —
  > netting across strategies requires them to share state, which separate apps
  > could not do.
- State, encrypted and never in plaintext outside the enclave: each strategy's
  mandate and balances, each depositor's idle balance and shares, the queued
  intents, open batches, and a mirror of the endpoint's custody (§3.5).
- **Accepting an intent.** The engine checks it against the strategy's mandate —
  allowed tokens, maximum order size, maximum position — and checks the strategy
  can afford it, counting what it already has queued or out in an open batch. A
  buy must carry a limit price, because that is what bounds its cost.
- **Cancelling an intent.** A manager can cancel their own intent while it is
  still queued, which releases the funds it committed. An intent already in a
  batch sent to market cannot be cancelled. Cancelling someone else's intent is
  refused with the same reason as cancelling one that does not exist, so intent
  IDs cannot be probed.
- **Closing a batch** happens when the operator sends `close_batch` naming a token
  pair and a reference price. There is no schedule: the enclave has no clock
  (THREAT_MODEL.md §4.1). Only that pair's queued intents are netted; intents on
  every other pair stay queued, untouched. Closing several pairs takes one request
  each, because a batch produces one order and the trigger executes one order per
  state update. The engine then:
  1. nets that pair's queued intents against each other (§3.4);
  2. if they cancel out, settles them internally and publishes no order;
  3. otherwise emits one order for the residual, and hands the trigger the funds
     to execute it;
  4. when the trigger reports the fill, settles every participant at one clearing
     price and sends each manager a private fill event.
- What reaches the market is the batch's net, never a per-strategy breakdown.
- NAV is computed only to price an allocation or a redemption, from prices
  supplied with that request. It is never published (§6).

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

**Known limit: the trigger trusts its router.** It records the base amount it asked
for rather than measuring what arrived. An honest exact-output router guarantees
those are equal. A misbehaving router, or a base token that takes a fee on
transfer, would have the enclave credit base that never arrived. Measuring the
trigger's balances before and after the swap would remove this.

> **Revised 2026-09-12** after reading the Vela v0.2.0 sources. The original plan —
> a bespoke custody contract that verifies enclave attestations itself — would
> re-implement what `ProcessorEndpoint` already does. Vela ships a purpose-built
> mechanism for exactly this, the **trigger-contract flow**, and Legate uses it.

- Solidity, extending Vela's `AbstractTrigger`. Legate overrides two hooks
  (`_execute`, `_getTrustProcessPayload`); the base class supplies the
  `onlyProcessorEndpoint` guard and the non-overridable sweep.
- **Custody stays with `ProcessorEndpoint`**, which checks the enclave's signature
  on every state update. The enclave never holds funds.
- The round trip per execution:
  1. the engine returns a `Withdrawal` to the trigger — funds move in (unshield),
  2. it emits one `AppEvent` with ABI-encoded order parameters,
  3. `trigger.execute()` performs the swap from the trigger's own address,
  4. `trigger.withdraw()` sweeps the proceeds back (reshield),
  5. `getTrustProcessPayload()` returns the fill, which re-enters the enclave as a
     `TRUSTPROCESS` request handled by the `trusted_request` export.
- This is what lets the enclave act on a public venue without revealing whom it is
  acting for. If `_execute` reverts, the full amount is swept back.
- The trigger emits only `BatchOrderExecuted` and `BatchOrderFailed`, which restate
  the already-public order. The original design's PureFi check on deposits and its
  public NAV and fee events are not built (§6).

### 3.4 Netting and settlement

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

**Fixed 2026-09-13: one strategy could stall batching.** A batch used to take its
token pair from whichever intent was queued first. One small intent on another
pair its mandate allowed could therefore either stall every batch, when its pair
had too few contributors (the refusal left the queue unchanged, so every later
attempt refused the same way), or, when it was dust, internalise and clear the
entire queue, silently discarding every other pair's intents. `close_batch` now
names the pair, other pairs are never touched, and a manager can cancel a queued
intent. `TestAnIntentOnAnotherPairCannotBlockBatching` and
`TestClosingAPairThatInternalisesKeepsOtherPairsQueued` cover both cases, and were
confirmed to fail against the old behaviour.

**Known issue: dropped intents are not reported.** When a pair closes, any of its
intents whose limit the reference price does not satisfy are discarded, and their
authors get no receipt. They see only that no fill arrived.

### 3.5 Custody and withdrawals

_Implemented in `vela-app/app/state.go`, `ledger.go` and `settle.go`._

A depositor exits in two steps: **redeem** converts shares into idle quote at the
current NAV, and **withdraw** pays idle balance out through a Vela withdrawal,
which the endpoint credits to the destination as a claim. Only idle balance can
leave, and redemption pays from a strategy's quote holdings only, so a fully
invested strategy must unwind a position before its depositors can exit.

The enclave keeps a **mirror of the endpoint's custody** for the app, per token.
It exists because of one line in `ProcessorEndpoint`: a state update whose
withdrawals exceed the app's custody reverts in full. That request would then sit
at the head of the queue indefinitely and block every request behind it, so a
single accounting error would freeze the app for all users. The enclave cannot
read the chain, so it mirrors custody instead and refuses — privately — any
withdrawal the mirror cannot cover, whether to a user or to the trigger.

The mirror moves exactly when on-chain custody does:

| Event | Custody |
|---|---|
| Deposit | + amount |
| Withdrawal to a user | − amount |
| Batch sent to market | − what is handed to the trigger |
| Trigger's sweep after execution | + unspent input + purchased output |
| Fully internalised batch | unchanged |

Whenever no batch is open, custody must equal every idle balance plus every
strategy balance; during an open batch, less what is out with the trigger.
`TestCustodyStaysBalancedThroughTheWholeLifecycle` asserts that after every step
of a journey covering all of the above, with hand-checkable numbers, and was
confirmed to fail when either the sweep credit or the trigger debit is removed.

**Known limit.** The sweep credit assumes the trigger's sweep succeeded. Vela
records a token whose transfer back fails as a failed sweep and leaves it in the
trigger; the mirror would then overstate custody for that token. This needs a
token that refuses transfers, and fixing it means reporting the sweep's actual
result in the trigger's payload.

### 3.6 Auditing

_Implemented in the app and covered by unit tests. Not yet exercised on the live
stack._

- Vela routes deanonymization requests from authorised auditors to the app, and
  encrypts the result to the auditor's key. This is Legate's compliance path, not
  a public block-explorer trail.
- Legate's report lists each strategy's manager, shares outstanding, token
  balances and halted flag. It does not include depositor accounts or any
  transaction history.
- The live run uses Vela's Authority Service only to upload the WASM artifact; it
  does not yet request a report.

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
  mandate before the engine catches it (oracle lag, extreme volatility)? And who
  may halt a strategy, on what signal?

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

## 6. In the original design, not built

Listed so that nothing above reads as a promise the code already keeps.

| Feature | State |
|---|---|
| Published, attested NAV or performance record per strategy | Not started. NAV is computed inside the enclave but never published, so depositors cannot yet judge a strategy's track record |
| Drawdown stop | Not started |
| Halting a strategy | The engine refuses intents and allocations for a halted strategy, but nothing sets the flag yet |
| PureFi compliance check on deposits | Not started |
| Batches on a schedule | Not planned as such: the enclave has no clock, so batches close on the operator's request |
| Netting several pairs in one request | Not planned: each batch nets one pair, and the operator closes pairs one request at a time, because the trigger executes one order per state update (§3.2) |
| Protocol, performance or management fees, and the ZEN staking share | Not started (§4) |
| Private execution venues (ZENDEX, DarkSwap) | Not live yet; the live run trades against a fixed-price test router |
