# Legate

**Private agentic trading vaults on Horizen.**

Strategists — AI agents, quant bots, or rules-based systems — send encrypted trade
intents into a confidential vault engine running in a Vela enclave. The engine
holds each strategy's positions and risk limits privately, nets intents across
strategies, and sends only the combined remainder to market through a single
trigger contract. An observer sees one pooled order and cannot tell which
strategies produced it.

Not yet built: a published, attested performance record per strategy, which is
what would let depositors judge a strategy they cannot see into. See
[what is not built](#not-built-yet).

Built for Horizen's [Builder Ecosystem Fund Season 2](https://horizen.io/builder-fund/),
RFP 1: Private Agentic Trading Vaults.

## Status

**Running end-to-end on a local Vela stack.** The engine, the WASM app and the
trigger contract are implemented, and a live run on Vela's Docker environment
nets real trades inside the enclave (see [Live run](#live-run)). Not yet on a
public testnet or real Nitro hardware. See [docs/ROADMAP.md](docs/ROADMAP.md) for
the milestone plan.

| Component | State |
|---|---|
| `vela-app/app/math.go` — 512-bit `mulDiv` fixed-point math | Implemented, tested |
| `vela-app/app/netting.go` — batch netting, k-anonymity guard | Implemented, tested |
| `vela-app/app/state.go` — confidential state, mandates, NAV | Implemented, tested |
| `vela-app/app/ledger.go` — deposits, shares, redemption, withdrawal, intents | Implemented, tested |
| `vela-app/app/settle.go` — clearing price and fill allocation | Implemented, tested |
| `vela-app/app/abi.go` — order/fill codec for the trigger | Implemented, tested |
| `vela-app/app/handlers.go` — command dispatch, batch lifecycle | Implemented, tested |
| `vela-app/main.go` — Vela WASM exports | Implemented |
| `contracts/LegateTrigger.sol` — execution trigger | Implemented, tested |
| `sdk/` — strategist intent client | Stub |

`./build.sh build` produces `legate_app.wasm`, a complete Vela guest module
exporting `deploy`, `load_module`, `deposit`, `process_request` and
`trusted_request`. Toolchain setup is in [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md);
`./build.sh doctor` checks it.

Both sides run their own suites — 129 Go tests, 15 Solidity — and a shared
fixture holds them to the same wire format (see below).

What is not yet done: a public testnet deployment, real Nitro hardware (the local
stack emulates the enclave), and the features listed under
[Not built yet](#not-built-yet).

## Live run

`contracts/scripts/e2e-local.mjs` runs Legate against a real Vela stack: the WASM
app executes in Vela's executor, payloads are encrypted to the enclave's key, the
trigger swaps on chain, and settlement returns through a genuine `TRUSTPROCESS`
request. Nothing is mocked except the trading venue.

```bash
# 1. Start Vela's local environment (from the vela-starterkit repository)
cd vela-starterkit/dockerfiles && cp .env.dev .env && docker compose up -d

# 2. Build the app and contracts
cd legate/vela-app && ./build.sh production_build
cd ../contracts && npx hardhat compile

# 3. Run it
node scripts/e2e-local.mjs
```

It runs two batches, then has the depositor redeem and withdraw back to a wallet.
In the second batch, alpha buys 10 WETH while beta sells 6, and
the script asserts what reached the chain against what each manager decrypts:

```
public — anyone reading the chain:
  one order: buy 4.0 WETH
private — decrypted only by each manager:
  alpha bought 10.0 WETH
  beta sold    6.0 WETH
✔ both sides settled at one clearing price (3000.0)
✔ all 14 encrypted requests were 1052 bytes on chain, whatever they said
```

That last line matters as much as the netting. Encryption hides what a request
says, not the metadata around it, so the run also checks the metadata:

- **Length.** Ciphertext length reveals plaintext length, so every command is
  padded to a fixed size and the enclave refuses any other. The run submits one
  unpadded intent and checks it is refused.
- **Refusals.** Vela publishes an app's error strings, and a refusal reason can
  describe confidential state. So an intent the rules refuse completes as a
  success, and only its sender decrypts why. The run submits one and checks its
  status, fee, and event subtype and size match an accepted intent's exactly.

See [docs/THREAT_MODEL.md §4.4](docs/THREAT_MODEL.md) for what request metadata
still reveals.

Each run deploys fresh tokens, a fresh trigger and a fresh app, so it can be
repeated against the same stack without resetting it.

## Contracts

```bash
cd contracts
git submodule update --init --depth 1   # Vela's contracts, not published to npm
npm install
npx hardhat test
```

`LegateTrigger` extends Vela's `AbstractTrigger`. It executes the one netted
order a batch produces and reports the fill back into the enclave. It knows
nothing about strategies — it sees a single pooled order, which is the point,
since that order is a public on-chain event.

The enclave and the contract each implement the order and fill encodings
independently, in different languages. `contracts/test/fixtures/abi-vectors.json`
is the shared fixture that stops them drifting: the Go suite asserts its encoder
still produces those exact bytes, and the Hardhat suite asserts Solidity decodes
them to the same values. A mismatch would otherwise surface only on chain, after
funds had moved.

## Why

Public vaults leak their edge — strategies get copied, entries get front-run, and
size invites adversarial trading. Legate keeps the *strategy* and *positions*
private. Making the *result* verifiable to depositors is the part of the design
still to build.

## How it works (short version)

1. A strategist runs their model off-chain. Nobody, including Legate, sees it.
2. Their client encrypts an intent — strategy, token, side, size and a limit price —
   to the enclave's key, pads it to a fixed size, and submits it as a Vela request.
3. The engine, a WASM app inside a Vela enclave, checks the intent against the
   strategy's mandate (allowed tokens, maximum order size, maximum position) and
   whether the strategy can afford it, then queues it. A refusal is private: only
   the strategist learns why.
4. When the operator closes a batch, the engine nets the queued intents. If
   anything is left over, it hands **one combined order** to its trigger contract,
   which executes it against a venue. The fill comes back into the enclave, and
   every participant settles at one clearing price.
5. Depositors back strategies privately, and exit by redeeming shares and
   withdrawing. An authorised auditor can request a report of strategy balances
   through Vela's Authority Service; nobody else can see them.

Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Threat model and known leaks: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

### Not built yet

The original design promised more than the code does today. Not built:

- A published, attested NAV or performance record per strategy.
- A drawdown stop, or any way to halt a strategy. The engine refuses intents from a
  halted strategy, but nothing sets that flag.
- A PureFi compliance check on deposits.
- Batches on a schedule. The enclave has no clock, so batches close when the
  operator asks.
- More than one token pair per batch. The current behaviour has a known issue that
  lets one strategy block batching
  ([ARCHITECTURE.md §3.4](docs/ARCHITECTURE.md#34-netting-and-settlement)).
- Fees, including the ZEN staking share.
- The strategist SDK.
- Private venues. ZENDEX and DarkSwap are not live, and the live run trades against
  a fixed-price test router.

The full list, with detail, is in
[ARCHITECTURE.md §6](docs/ARCHITECTURE.md#6-in-the-original-design-not-built).

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
contracts/    Solidity: LegateTrigger (extends Vela's AbstractTrigger), test mocks,
              and the live-run script
vela-app/     Go/WASM: the confidential vault engine (runs inside Vela)
sdk/          TypeScript strategist client (stub)
docs/         Architecture, threat model, roadmap, toolchain
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
(Hedera DEX, funded through Thrive's Hedera Launch Program), [RoboNado](https://github.com/Kazam1271/RoboNado)
(EIP-712 trading automation).

## License

TBD.
