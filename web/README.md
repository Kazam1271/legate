# @legate/web

The Legate interface: five screens covering the two audiences the protocol has
to serve at once — strategists, who need privacy, and depositors, who need
enough signal to trust a strategy they cannot see into.

Live at **[legate-eight.vercel.app](https://legate-eight.vercel.app)**, deployed
from `main` on every push that touches this directory.

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # production build, fully static
```

No wallet connection and no chain calls. Every figure is representative data,
generated locally.

## Screens

| Route | What it is for |
|---|---|
| `/` | The netting property, made visible: many private intents, one public order |
| `/vaults` | Depositor view — attested NAV and mandate, never positions |
| `/vaults/[id]` | One strategy in depth: NAV history, enclave-enforced mandate, batch participation |
| `/batches` | The proof page — every settled batch and the volume that never reached the market |
| `/console` | Strategist view — submit an encrypted intent, read your own private fills |

## Why the data is generated the way it is

`lib/data.ts` is deterministic: a seeded PRNG (mulberry32) and one fixed
`EPOCH` constant. Nothing calls `Math.random()` or `Date.now()` during render,
and `lib/format.ts` avoids `toLocaleString` entirely.

This is not fussiness. Next.js renders every page on the server first, then
hydrates it in the browser. A value that differs between those two renders —
a random NAV, a timestamp a few milliseconds apart, a date formatted in a
different timezone — makes React discard the server render and throw a
hydration error. Seeded data makes that class of bug structurally impossible
rather than merely unlikely.

Two consequences worth knowing:

- **The netting diagram animates in pure CSS.** A JavaScript animation loop
  would need client state, which is exactly what has to match the server.
  CSS animations start after paint and cannot disagree.
- **The batch countdown** (`components/next-batch.tsx`) is the one genuinely
  live value. It starts from the same fixed number the server rendered and only
  begins ticking inside `useEffect`, which never runs during SSR.

Navigation highlighting uses `usePathname()` rather than `window.location`,
for the same reason: `window` does not exist on the server.

## Design

One accent colour — amber — reserved for things that are public or verifiable:
the residual order, attested figures, the primary action. Violet marks what
stays private. Everything else is graphite, so the accent means something when
it appears.

Financial figures use tabular numerals (`.tnum`) so columns align digit to
digit.

## What is mocked

Everything. This is an interface preview built ahead of a public deployment:
there is no wallet, no RPC, and no enclave behind it. The engine those screens
describe is real and tested — see the repository root — but the two are not yet
wired together.
