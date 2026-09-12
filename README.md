# Legate

**Private agentic trading vaults on Horizen.**

Strategists — AI agents, quant bots, or rules-based systems — send encrypted trade
intents into a confidential vault engine. The engine holds each strategy's positions
and risk limits privately, nets and batches intents across strategies, executes the
combined flow through a single pooled custody contract, and publishes an attested,
verifiable performance record per strategy. Depositors get a track record they can
trust without ever seeing a position.

Built for Horizen's [Builder Ecosystem Fund Season 2](https://horizen.io/builder-fund/),
RFP 1: Private Agentic Trading Vaults.

## Status

**Early implementation.** The netting engine — the core privacy mechanism — is
implemented and tested. Nothing is deployed yet. See
[docs/ROADMAP.md](docs/ROADMAP.md) for the milestone plan.

| Component | State |
|---|---|
| `vela-app/app/math.go` — 512-bit `mulDiv` fixed-point math | Implemented, tested |
| `vela-app/app/netting.go` — batch netting, k-anonymity guard | Implemented, tested |
| `vela-app/app/state.go` — confidential state, mandates, NAV | Implemented, tested |
| `vela-app/app/ledger.go` — deposits, shares, redemption, intents | Implemented, tested |
| `vela-app/app/settle.go` — clearing price and fill allocation | Implemented, tested |
| `vela-app/app/abi.go` — order/fill codec for the trigger | Implemented, tested |
| `vela-app/app/handlers.go` — command dispatch, batch lifecycle | Implemented, tested |
| `vela-app/main.go` — Vela WASM exports | Implemented |
| `contracts/LegateTrigger.sol` — execution trigger | Not started |
| `sdk/` — strategist intent client | Stub |

`./build.sh build` produces `legate_app.wasm`, a complete Vela guest module
exporting `deploy`, `load_module`, `deposit`, `process_request` and
`trusted_request`. Toolchain setup is in [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md);
`./build.sh doctor` checks it.

What is not yet done: the trigger contract that executes the order on chain, and
a run against Vela's local stack. Until both exist, the batch lifecycle is proven
by `TestEndToEndBatchLifecycle` rather than by a live network.

## Why

Public vaults leak their edge — strategies get copied, entries get front-run, and
size invites adversarial trading. Legate keeps the *strategy* and *positions* private
while keeping the *result* provably honest.

## How it works (short version)

1. A strategist runs their model off-chain. Nobody, including Legate, sees it.
2. The strategist's client signs an intent (asset, direction, size, constraints) and
   encrypts it to the vault engine's TEE key.
3. The engine — a WASM app running inside a Vela confidential-compute enclave —
   decrypts the intent, checks it against that strategy's mandate (allowed assets,
   max size, drawdown stop), and updates encrypted internal state.
4. On each execution epoch, the engine nets intents across all active strategies and
   submits **one combined order** to Horizen execution venues (ZENDEX / DarkSwap /
   an AMM) through its trigger contract.
5. The engine attests an updated NAV per strategy and per depositor, posted on-chain
   as a signed state root. Auditors can request a deanonymization report through
   Vela's Authority Service; nobody else can.

Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Threat model and known leaks: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

### The netting property, concretely

Strategy A buys 100, strategy B sells 60. Only the **40** difference reaches the
market; the 60 that crossed internally never touches it — no slippage, no fee, no
footprint. An observer sees one pool order of 40 and cannot tell which strategies
produced it, because many different sets of intents net to the same residual.

`TestNetBatchIndistinguishability` asserts exactly that: three unrelated sets of
strategy intents produce byte-identical public output.

Two guards keep the property honest:

- **k-anonymity (`MinContributors`)** — a residual may only go to market if at least
  _k_ distinct strategies contributed. With one contributor the residual *is* that
  strategy's order, so the engine refuses rather than leaking.
- **Dust suppression (`MinResidual`)** — a tiny public order is uneconomic and
  unusually identifying, so it is internalised instead.

## Repo layout

```
contracts/    Solidity: LegateTrigger (extends Vela AbstractTrigger), PureFi gate
vela-app/     Go/WASM: the confidential vault engine (runs inside Vela)
sdk/          TypeScript client: strategist intent signing + depositor UI hooks
docs/         Architecture, threat model, roadmap
```

## Development

The engine's logic is plain Go and needs no enclave to test:

```bash
cd vela-app
go test ./...
```

Building the deployable artifact needs TinyGo (Vela pins v0.39.0); running the full
stack locally needs Docker.

## Team

Built by [Kazam1271](https://github.com/Kazam1271). Prior work: [Velo](https://veloexchange.org)
(privacy-adjacent Hedera DEX, Thrive Hedera grantee), [RoboNado](https://github.com/Kazam1271/RoboNado)
(EIP-712 trading automation).

## License

TBD.
