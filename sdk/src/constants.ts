/**
 * Constants shared with the enclave. Each must match its Go counterpart in
 * `vela-app/app`; the fixture tests on both sides fail if they drift.
 */

/**
 * The exact length every command must have before encryption. Matches
 * `app.PaddedPayloadSize`.
 *
 * Ciphertext length reveals plaintext length, so without padding an observer
 * could tell a buy from a sell, or one strategy from another, by size alone. The
 * enclave refuses any other length rather than tolerating it.
 */
export const PADDED_PAYLOAD_SIZE = 1024;

/** Order side. Matches `app.Side`, which encodes as a JSON number. */
export enum Side {
  Buy = 0,
  Sell = 1,
}

/**
 * Event subtypes the app publishes. These are public log topics.
 *
 * Every command answers with a `receipt`, whatever the command and whatever the
 * outcome, so the subtype says nothing about what was sent.
 */
export const SUBTYPE = {
  receipt: 'receipt',
  fills: 'fills',
  deposit: 'deposit',
  batchOrder: 'batch_order',
} as const;

/**
 * Default ceiling on the fee a request may pay, in wei. Whatever the app does not
 * charge is refunded. Override it per client.
 */
export const DEFAULT_MAX_FEE = 10n ** 16n; // 0.01 ETH

/** Fixed-point scale for prices: quote units per whole base unit, times 1e18. */
export const PRICE_SCALE = 10n ** 18n;
