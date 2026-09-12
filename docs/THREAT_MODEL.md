# Legate: Threat Model

This is the honest answer to the application's hardest questions: *what's actually
private, from whom, what breaks if you remove the privacy, and where does it still
leak.* Treat this as a living document — update it as the design changes, and
expect it to be picked apart on the Horizen technical call.

## 1. What's private, and from whom

| Data | Hidden from | Visible to |
|---|---|---|
| Strategy logic / model | Everyone, including Legate operators | Nobody. Never leaves the strategist's own machine. |
| Live per-strategy positions | Public chain observers, other strategists, depositors of other strategies | The enclave only. Auditors, via Vela's Authority Service, with authorization. |
| Which depositor backs which strategy | Public chain observers | The enclave only (custody contract sees pooled deposits, not per-strategy allocation) |
| Per-strategy NAV / performance | — (this is deliberately public) | Depositors, publicly, as an attestation |
| Pooled TVL, total volume | — (deliberately public) | Everyone |

These guarantees cover payload *contents*. Request metadata — length, sender,
timing, success or failure — is a separate surface, covered in §4.4.

## 2. What breaks if privacy is removed

If positions and strategy identity were public:
- **Copy-trading kills the edge.** Anyone can front-run or replicate a visible
  strategy for free, and the strategist has no reason to list.
- **Size becomes a target.** Large positions invite adversarial trading
  (liquidation-hunting equivalents in a trading context: stop-hunting, spoofing
  against a known book).
- **Depositor-to-strategy linkage becomes a privacy leak for depositors too** — a
  fund's allocation strategy becomes public.

Without privacy, there's no reason for a serious strategist to use this over a
plain public vault (Yearn-style). Privacy isn't a feature bolt-on here — it's the
entire value proposition.

## 3. Trust assumptions

Being upfront about these, not hiding them:

1. **AWS Nitro Enclave hardware trust.** Confidentiality depends on Nitro's
   memory encryption and attestation being sound. This is Vela's trust base, not
   something Legate adds or removes. Users should understand they're trusting AWS
   hardware security, not a zero-knowledge proof.
2. **Vela operator trust (bounded).** The enclave's code is what enforces mandates
   and computes NAV. If Vela's infrastructure or the enclave image is compromised,
   the *attestation* — not the funds — is at risk (funds sit in the on-chain
   custody contract, which only acts on cryptographically verified attestations).
   We still depend on Vela's attestation verification being correctly implemented
   on both sides.
3. **Compliance is deanonymization, not immunity.** Vela's Authority Service can
   produce full deanonymization reports for authorized auditors. Legate is
   "private from other users," not "private from regulators." This needs to be
   explicit in user-facing copy.
4. **Price trust.** The enclave cannot fetch prices. The reference price a batch
   nets at arrives with the `close_batch` request, and valuation prices arrive with
   the request that needs them. What bounds the damage from a bad one is not the
   feed but two independent checks: every intent carries its own limit price, and
   the order handed to the trigger carries a quote bound derived from the tightest
   of those limits, which the swap enforces on chain. A wrong reference price can
   therefore stall a batch or skip intents, but cannot fill anyone past their own
   limit. Sourcing prices from an oracle such as Stork is future work, and would
   narrow but not remove this trust.

## 4. Where it still leaks (the honest gaps)

This is the section reviewers will push hardest on.

### 4.1 Pool composition leaks with few strategies
If a pool has 1–2 strategies, or one strategy dominates the netted flow, an
observer watching the custody contract's on-chain trades can reconstruct that
strategy's position almost as if it were public. **Netting only hides you inside
a crowd.**

Mitigations (to prove in M1, not just claim):
- Minimum strategy count per pool before it accepts depositor capital.
  **Implemented** as the `MinContributors` k-anonymity guard in
  `vela-app/app/netting.go`: a residual may only go to market if at least _k_
  distinct strategies contributed, otherwise `NetBatch` refuses rather than leaking.
  It does not apply when a batch fully internalises, since then no public order
  exists to attribute.
- Batching windows wide enough to mix multiple strategies' intents.
- ~~Randomized execution timing within the epoch window~~ — **not available.**
  Vela guests must be deterministic: no clocks, no RNG (lock and batch IDs must
  come from in-state counters). Randomness would have to be supplied from outside
  the enclave, which means trusting whoever supplies it. Batch cadence is therefore
  externally driven, and *who closes batches* becomes a design question in its own
  right, tracked in ARCHITECTURE.md §4.
- Order splitting on the combined order. Still possible, but note it must be driven
  by deterministic in-state rules rather than randomisation, for the same reason.
- Dust-residual suppression (`MinResidual`, implemented): a very small public order
  is both uneconomic and unusually identifying, so it is internalised instead.

### 4.2 Deposit and withdrawal edges are visible
The custody contract is public. Deposit and withdrawal amounts and timing are
visible on-chain, even though the *destination* (which strategy) is not. A
sophisticated observer correlating deposit timing with subsequent NAV shifts could
make probabilistic inferences.

Mitigation under consideration: route deposits/withdrawals through a private
ledger primitive (Vela's `vela-nova`-style private transfer model) rather than a
plain public contract call — deferred past M1, tracked as a known gap.

### 4.3 Netting doesn't hide net directional exposure
If every strategy in the pool is long the same asset, netting doesn't hide
anything — the combined order reveals the pool's aggregate direction even though
no single strategy's is. This is a structural limit, not a bug to fix; it needs to
be disclosed to strategists and depositors, not solved away.

### 4.4 Request metadata: what leaks around the ciphertext

Encrypting a payload hides what it says. Everything *around* it — its length, who
sent it, when, and whether it succeeded — stays public. Running Legate on a real
Vela stack, and then tracing exactly what Vela's executor publishes, surfaced the
leaks below. None of them is visible to a unit test, which only ever sees plaintext.

| Leak | Status |
|---|---|
| Payload length | Fixed — padding, enforced by the enclave |
| Error messages and failure status | Fixed — private rejections |
| Sender address and timing | Open — inherent to Vela's request model |
| Number of fill events per batch | Open |

**Payload length — found in the live run, fixed.** AES-GCM output is the plaintext
plus a fixed 28 bytes, so ciphertext length is plaintext length. In the first live
run, two buys and a sell encrypted to 214, 213 and 196 bytes. That was enough to
read:

| Signal in the length | Why |
|---|---|
| Which command was sent | Commands have different shapes |
| Buy versus unconditional sell | A real limit price is ~18 characters longer than `"0x0"` |
| Which strategy | `"alpha"` is one character longer than `"beta"` |
| Rough order of magnitude of amounts | Hex strings grow with the value |

Combined with the sender address below, an observer could read a strategist's
direction straight off the chain — contradicting §1.

Fix, implemented: every `PROCESS` payload is padded with trailing spaces to exactly
`PaddedPayloadSize` (1024 bytes), which JSON already permits. The enclave
**rejects** any other length rather than merely tolerating padding, because a
single careless client would otherwise leak its own intents and thin everyone
else's crowd. The live run now asserts that every encrypted request — buys, sells,
registrations, allocations, batch closes — is the same size on chain, and that an
unpadded intent is refused.

**Error messages — found by reading the executor, fixed.** When the app returns an
error, Vela's executor publishes it, truncated to 100 characters, in the signed
`RequestCompleted` event. Legate's errors are specific, and some of them are about
confidential state: `intent would exceed the mandate's maximum position` told every
observer that strategy was near its cap. Whether a request failed at all was public
too, and so was a refused batch close — which revealed when too few strategies had
submitted to satisfy the k-anonymity guard.

Fix, implemented: failures now come in two kinds, published differently.

- **Malformed requests fail publicly** — bad padding, unparseable JSON, a missing
  parameter. The reason depends only on what the sender sent.
- **Rule-based refusals are private.** An unaffordable intent, a mandate breach, a
  batch the k-anonymity guard will not release: each completes as a *successful*
  request that leaves state unchanged, and the reason goes only to the sender in an
  encrypted receipt.

A rejection only hides anything if it matches an acceptance in everything the chain
records, so all of these are made equal by construction:

| Observable | How it is equalised |
|---|---|
| Status and error message | Both succeed with no error |
| Fee | Fuel is fixed per command, independent of outcome |
| Events | Exactly one receipt, one subtype for every command, padded to 1024 bytes |
| State root | Vela bumps a nonce inside the hashed app data on every success, so the root moves even when Legate's state does not |

The live run submits an intent the rules must refuse and asserts, on the real
chain, that its status, fee, and event subtype and size are identical to an
accepted intent's — while the sender alone decrypts the reason.

A subtle trap had to be avoided. Handlers can mutate state before the rule that
refuses them runs: closing a batch clears the pending queue before checking for a
price bound. Under the old model that was harmless, because Vela discards state on
error. Now that a rejection is a successful request, returning the handler's working
copy would have silently dropped every queued intent. A rejection therefore returns
the state exactly as it arrived. A test covers this, and was confirmed to fail when
the bug is reintroduced.

What a private rejection still reveals, or costs:

- **A refused batch close is not fully hidden.** It publishes no order, like a batch
  that internalised completely, but unlike one it carries no fill events. So *that*
  nothing settled is visible; *why* is not.
- **A refusal is charged the full fee**, as an acceptance is. A cheaper refusal would
  announce itself.
- **A deposit made alongside a refused allocation stays in the vault** as idle
  balance rather than being refunded, since an on-chain refund would announce the
  refusal. This makes a depositor withdrawal command necessary; it does not exist
  yet.

**Sender address and timing — inherent to the request model, open.** Every request
records its sender's address and block. Nobody learns which strategy a wallet runs
from the chain alone, since registration is encrypted, but a wallet's activity
pattern is visible: when it submits, and how often. Possible mitigations, none yet
implemented: letting a manager authorise session keys so submissions do not all
come from one address, and submitting cover intents at a steady cadence so real
activity does not stand out.

**Fill event count — open.** Settling a batch sends one encrypted fill event to
each participating strategy's manager. Recipients are hidden, but the number of
events is not, so an observer learns how many strategies took part in each batch.
The k-anonymity guard ensures that number is at least _k_; knowing it exactly still
helps attribution when it is small. A mitigation would be to send every registered
strategy an event per batch, empty for those that did not trade.

### 4.5 Enclave compromise scenarios
- **Side-channel attacks on Nitro** are a known (if difficult) class of attack
  against TEEs generally. Legate inherits this risk from Vela; it is not something
  this project can independently mitigate.
- **Malicious or buggy WASM app code** — since Legate's engine *is* the WASM app,
  bugs in this code are a first-party risk, not a third-party one. This is why
  M2 (security audit) matters more here than in a typical dApp: the audit surface
  includes code that would normally be invisible/server-side in a non-confidential
  system.

## 5. What Legate does NOT claim

- Not anonymous from regulators or authorized auditors — explicitly designed with
  a compliant deanonymization path.
- Not zero-knowledge — this is TEE-based confidentiality with hardware trust
  assumptions, not a cryptographic privacy proof. Being clear about this
  distinction is part of "what most teams get wrong" (per the application's own
  framing): conflating TEE confidentiality with ZK-grade guarantees oversells the
  privacy model.
- Not resistant to a fully compromised Nitro enclave at the hardware level — no
  TEE-based system is.

## 6. Comparable implementations studied

- **Obscura** (Horizen ecosystem): verifiable trader reputation via zkSNARKs +
  TEE — proves *performance* without exposing trades, similar attestation goal,
  different mechanism (ZK proof of aggregate stats vs. TEE-computed NAV). Where it
  differs from Legate: reputation/social-proof product, not custody of pooled
  capital or live trade execution.
- **Almanak** (Ethereum, multi-sig + TEE vaults): closest operational comparable —
  AI-agent swarm managing DeFi strategies in TEE-secured vaults, reported ~$132M
  peak TVL. Publicly less focused on strategy-level confidentiality; appears to
  optimize for automation and risk management more than hiding positions from
  competitors.
- **Zama's confidential lending call-to-action** (FHE-based): different privacy
  primitive (FHE vs TEE) and different product (lending vs trading), but the
  liquidation/oracle problems they name are structurally similar to Legate's
  netting/oracle risks above.

*(This section should be filled in further with direct engineering conversations
before the application is submitted — see ROADMAP.md M1.)*
