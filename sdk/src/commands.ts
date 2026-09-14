/**
 * Builders for the commands the enclave understands.
 *
 * Each returns the exact JSON shape `app.PayloadInstructions` decodes. Go's JSON
 * decoder silently ignores a misspelled field, which would leave a parameter
 * unset rather than fail, so these builders are the one place field names are
 * written, and `test/fixtures/commands.json` pins them against the Go struct.
 *
 * Builders validate what can be checked locally. A mistake caught here costs
 * nothing; the same mistake caught by the enclave still costs the request fee.
 */

import { getAddress } from 'ethers';

import { Side } from './constants.js';
import { LegateValidationError } from './errors.js';

/** A hex-encoded unsigned integer, as `types.Uint256` expects: lowercase `0x`. */
export type Hex = `0x${string}`;

/** A strategy's risk envelope, enforced by the enclave on every intent. */
export interface Mandate {
  /** Tokens the strategy may hold or trade. Must include the vault's quote token. */
  allowedTokens: string[];
  /** Largest single intent, in base units. Omit or 0n for no limit. */
  maxOrderBase?: bigint;
  /** Largest holding of any one token, in base units. Omit or 0n for no limit. */
  maxPositionBase?: bigint;
}

/**
 * Prices keyed by token address, as fixed-point quote per base (see
 * `PRICE_SCALE`). The enclave cannot fetch prices, so valuing a strategy's
 * holdings needs one for each token it holds other than the quote token.
 */
export type Prices = Record<string, bigint>;

export type LegateCommand =
  | { command: 'register_strategy'; registerStrategy: { id: string; mandate: WireMandate } }
  | { command: 'allocate'; allocate: { strategyId: string; amount: Hex; prices: Record<string, Hex> } }
  | { command: 'redeem'; redeem: { strategyId: string; shares: Hex; prices: Record<string, Hex> } }
  | {
      command: 'submit_intent';
      intent: { strategyId: string; base: string; side: Side; amount: Hex; limitPrice: Hex };
    }
  | { command: 'cancel_intent'; cancelIntent: { intentId: string } }
  | { command: 'close_batch'; closeBatch: { base: string; refPrice: Hex; slippageBps: number } }
  | { command: 'withdraw'; withdraw: { token: string; amount: Hex; destination?: string } };

interface WireMandate {
  allowedTokens: string[];
  maxOrderBase?: Hex;
  maxPositionBase?: Hex;
}

/** Encodes a non-negative bigint the way `types.Uint256` decodes it. */
export function toHex(value: bigint, field = 'value'): Hex {
  if (typeof value !== 'bigint') {
    throw new LegateValidationError(`${field} must be a bigint, got ${typeof value}`);
  }
  if (value < 0n) {
    throw new LegateValidationError(`${field} must not be negative`);
  }
  if (value >= 1n << 256n) {
    throw new LegateValidationError(`${field} does not fit in 256 bits`);
  }
  return `0x${value.toString(16)}`;
}

function positive(value: bigint, field: string): Hex {
  if (typeof value === 'bigint' && value === 0n) {
    throw new LegateValidationError(`${field} must be greater than zero`);
  }
  return toHex(value, field);
}

/** Validates and checksums an address. */
export function toAddress(value: string, field = 'address'): string {
  try {
    return getAddress(value);
  } catch {
    throw new LegateValidationError(`${field} is not a valid address: ${value}`);
  }
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LegateValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function encodePrices(prices: Prices | undefined): Record<string, Hex> {
  const out: Record<string, Hex> = {};
  for (const [token, price] of Object.entries(prices ?? {})) {
    out[toAddress(token, 'price token')] = toHex(price, `price for ${token}`);
  }
  return out;
}

/** Registers a strategy managed by the sender. */
export function registerStrategy(id: string, mandate: Mandate): LegateCommand {
  if (!Array.isArray(mandate?.allowedTokens) || mandate.allowedTokens.length === 0) {
    throw new LegateValidationError('mandate.allowedTokens must list at least one token');
  }
  const wire: WireMandate = {
    allowedTokens: mandate.allowedTokens.map((t) => toAddress(t, 'allowed token')),
  };
  if (mandate.maxOrderBase !== undefined) wire.maxOrderBase = toHex(mandate.maxOrderBase, 'maxOrderBase');
  if (mandate.maxPositionBase !== undefined) wire.maxPositionBase = toHex(mandate.maxPositionBase, 'maxPositionBase');

  return { command: 'register_strategy', registerStrategy: { id: nonEmpty(id, 'strategy id'), mandate: wire } };
}

/** Moves the sender's idle quote balance into a strategy, issuing shares at NAV. */
export function allocate(params: { strategyId: string; amount: bigint; prices?: Prices }): LegateCommand {
  return {
    command: 'allocate',
    allocate: {
      strategyId: nonEmpty(params.strategyId, 'strategyId'),
      amount: positive(params.amount, 'amount'),
      prices: encodePrices(params.prices),
    },
  };
}

/** Burns shares in a strategy, returning their value to the sender's idle balance. */
export function redeem(params: { strategyId: string; shares: bigint; prices?: Prices }): LegateCommand {
  return {
    command: 'redeem',
    redeem: {
      strategyId: nonEmpty(params.strategyId, 'strategyId'),
      shares: positive(params.shares, 'shares'),
      prices: encodePrices(params.prices),
    },
  };
}

/**
 * Queues a trade intent for the strategy the sender manages.
 *
 * A buy must carry a limit price: it is what bounds the intent's cost, and the
 * enclave refuses a buy without one. A sell may omit it, which makes the sell
 * unconditional.
 */
export function submitIntent(params: {
  strategyId: string;
  base: string;
  side: Side;
  amount: bigint;
  limitPrice?: bigint;
}): LegateCommand {
  if (params.side !== Side.Buy && params.side !== Side.Sell) {
    throw new LegateValidationError(`side must be Side.Buy or Side.Sell, got ${String(params.side)}`);
  }
  if (params.side === Side.Buy && (params.limitPrice === undefined || params.limitPrice === 0n)) {
    throw new LegateValidationError('a buy must carry a limit price, which is what bounds its cost');
  }
  return {
    command: 'submit_intent',
    intent: {
      strategyId: nonEmpty(params.strategyId, 'strategyId'),
      base: toAddress(params.base, 'base'),
      side: params.side,
      amount: positive(params.amount, 'amount'),
      limitPrice: toHex(params.limitPrice ?? 0n, 'limitPrice'),
    },
  };
}

/** Cancels one of the sender's own queued intents, releasing the funds it committed. */
export function cancelIntent(intentId: string): LegateCommand {
  return { command: 'cancel_intent', cancelIntent: { intentId: nonEmpty(intentId, 'intentId') } };
}

/**
 * Closes the batch for one token pair. Operator only.
 *
 * Pairs close one request at a time: a batch produces one order, and the trigger
 * executes one order per state update.
 */
export function closeBatch(params: { base: string; refPrice: bigint; slippageBps?: number }): LegateCommand {
  const slippageBps = params.slippageBps ?? 0;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 0xffffffff) {
    throw new LegateValidationError('slippageBps must be a non-negative integer');
  }
  return {
    command: 'close_batch',
    closeBatch: {
      base: toAddress(params.base, 'base'),
      refPrice: positive(params.refPrice, 'refPrice'),
      slippageBps,
    },
  };
}

/**
 * Pays idle balance out of the vault as a claim.
 *
 * Withdrawing to another address is allowed but does not unlink it from the
 * sender: the Withdrawal event is published under the sender's request.
 */
export function withdraw(params: { token: string; amount: bigint; destination?: string }): LegateCommand {
  const body: { token: string; amount: Hex; destination?: string } = {
    token: toAddress(params.token, 'token'),
    amount: positive(params.amount, 'amount'),
  };
  if (params.destination !== undefined) {
    body.destination = toAddress(params.destination, 'destination');
  }
  return { command: 'withdraw', withdraw: body };
}
