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

**Design phase.** No contracts deployed, no Vela app running yet. See
[docs/ROADMAP.md](docs/ROADMAP.md) for the milestone plan.

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
   an AMM) through a pooled custody contract.
5. The engine attests an updated NAV per strategy and per depositor, posted on-chain
   as a signed state root. Auditors can request a deanonymization report through
   Vela's Authority Service; nobody else can.

Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Threat model and known leaks: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Repo layout

```
contracts/    Solidity: custody, entrypoint/exit, PureFi gate
vela-app/     Go/WASM: the confidential vault engine (runs inside Vela)
sdk/          TypeScript client: strategist intent signing + depositor UI hooks
docs/         Architecture, threat model, roadmap
```

## Team

Built by [Kazam1271](https://github.com/Kazam1271). Prior work: [Velo](https://veloexchange.org)
(privacy-adjacent Hedera DEX, Thrive Hedera grantee), [RoboNado](https://github.com/Kazam1271/RoboNado)
(EIP-712 trading automation).

## License

TBD.
