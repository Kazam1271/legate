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
4. **Oracle trust.** Stork price feeds inform mandate checks (drawdown, max
   position sizing relative to market price). A stale or manipulated feed could
   let a strategy exceed its real risk limit before the engine catches it.

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

### 4.4 Enclave compromise scenarios
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
