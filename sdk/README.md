# @legate/sdk

A client for Legate's confidential vault engine on Vela: strategists submitting
intents, depositors allocating and redeeming, and the operator closing batches.

Wraps Vela's [`@horizen/vela-common-ts`](https://github.com/HorizenOfficial/vela-common-ts)
client, which handles key derivation, ECDH encryption to the enclave, and
decryption of events. This package adds what Legate specifically needs: typed
command builders, the fixed-size padding the enclave enforces, and reading the
private receipt every command answers with.

## Install

```bash
npm install @legate/sdk ethers
```

`ethers` (`^6.13.0`) is a peer dependency.

## Quick start

```ts
import { LegateClient, Side } from '@legate/sdk';

const client = LegateClient.fromPrivateKey(process.env.PRIVATE_KEY!, 'http://127.0.0.1:8545', {
  applicationId: 12345n,
  processorEndpoint: '0x...',
  teeAuthenticator: '0x...',
});

// Once per signer, before it can send commands or read results.
await client.registerKey();

// A strategy manager queues an intent.
const outcome = await client.submitIntent({
  strategyId: 'alpha',
  base: '0x...weth',
  side: Side.Buy,
  amount: 10n * 10n ** 18n,
  limitPrice: 3_100n * 10n ** 18n,
});

if (outcome.status === 'rejected') {
  // Refused by the rules, not by the chain. Only this signer can see why.
  console.log('refused:', outcome.reason);
} else {
  console.log('intent id:', outcome.detail.intentId);
}
```

## Why commands are built, not written by hand

Every field name here has to match the Go structs the enclave decodes
(`vela-app/app/handlers.go`) exactly. Go's JSON decoder silently ignores a field
it doesn't recognise — a misspelled key doesn't error, it just leaves that
parameter unset. The command builders in `commands.ts` are the one place those
field names are written, and a shared fixture
(`test/fixtures/commands.json`) is checked against the Go side too
(`vela-app/app/sdk_fixture_test.go`), so a wire-format drift fails a test on
both ends instead of surfacing as a live enclave quietly doing the wrong thing.

Regenerate the fixture only after a deliberate wire-format change, on both sides
in the same change:

```bash
npm run build && npm run fixtures
```

## Why every command is padded before encryption

Vela's endpoint publishes each request's ciphertext length on chain. Without
padding, that length alone tells an observer which command was sent — a buy from
a sell, one strategy id's length from another's, the rough size of a hex-encoded
amount. Combined with the sender address every request already exposes, that's
enough to read a strategist's direction straight off the chain; the first live
run against a real Vela stack showed exactly this (two buys and a sell encrypted
to three different byte lengths).

`LegateClient.submit` pads every command to `PADDED_PAYLOAD_SIZE` (1024 bytes,
matching `app.PaddedPayloadSize`) before encrypting it. The enclave enforces this
size rather than merely tolerating padding — a single careless client sending
unpadded requests would leak its own intents and thin out everyone else's crowd.

## Rejection is private; failure is public

A command can end three different ways, and they need different handling:

- **Publicly, on chain**, if the enclave can't make sense of the request at all
  (bad JSON, a field that doesn't decode). `submit` throws `RequestFailedError`.
  This is visible to everyone, always — Vela publishes the request's status and
  error message.
- **Privately**, if the request decoded fine but the rules refused it (insufficient
  balance, an unknown strategy, wrong mandate). This is **not** thrown — Legate
  makes an accepted and a rejected request cost the same fee and carry
  identically-shaped public events, so only the sender's decrypted receipt says
  which happened. `submit` returns `{ status: 'rejected', reason }`.
- **Accepted**, returned as `{ status: 'accepted', detail }`.

```ts
const outcome = await client.allocate({ strategyId: 'alpha', amount: 1_000n });
if (outcome.status === 'rejected') {
  // A real outcome, not an error — check outcome.reason and decide what to do.
}
```

## Reading fill events

A settled batch tells each strategy's manager what their strategy received, but
not who else was in the batch or what anyone else's fill looked like:

```ts
// Right after your own close_batch or submit_intent request:
const fills = await client.fillsFor(outcome);

// A manager finds fills from requests it did not submit — the trusted
// settlement request a batch triggers — by scanning a block range:
const fills = await client.findFills({ fromBlock: 12_000 });
```

## Withdrawing

```ts
await client.withdraw({ token: usdc, amount: 500n });
// The endpoint credits it as a pull-payment claim:
await client.claim(usdc);
```

Withdrawing to a different address than the sender's own is allowed, but does
**not** unlink the two — the withdrawal is published under the sender's own
request, and the sender of every request is public. Treat `destination` as a
convenience, not a privacy feature.

## API

See `dist/index.d.ts` once built, or the source in `src/`. The main surfaces:

- `LegateClient` — one client per signer, covering every role (strategist,
  depositor, operator); the enclave decides what each may do.
- `commands` — pure builders for every command, validated locally.
- `parseEvent`, `decodeOrder` — parsers for what comes back.
- `padPayload` — the padding `submit` applies automatically; exposed for
  anything that needs to encrypt a command without going through the client.

## Development

```bash
npm install
npm run build     # tsc -> dist/
npm test          # build, then run test/*.test.mjs
npm run fixtures  # regenerate test/fixtures/commands.json (after build)
```
