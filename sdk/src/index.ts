/**
 * Legate SDK — strategist intent signing + depositor client.
 *
 * Status: stub. Not yet implemented — see ../../docs/ARCHITECTURE.md §3.1.
 *
 * Planned surface:
 *   - generateIntentKeypair(): P-521 keypair for encrypting intents to the
 *     Vela enclave (separate from the strategist's secp256k1 tx-signing key).
 *   - signIntent(intent, secp256k1Key): signs an intent for on-chain submission.
 *   - encryptIntent(intent, enclavePublicKey): encrypts the intent payload.
 *   - submitIntent(...): submits the encrypted, signed intent to
 *     ProcessorEndpoint on Horizen L3.
 */

export const SDK_VERSION = "0.0.1";
