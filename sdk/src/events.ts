/**
 * Parsers for what the enclave sends back.
 *
 * Private events arrive as JSON padded with trailing spaces to a fixed bucket
 * size, so their encrypted length reveals nothing. `JSON.parse` accepts trailing
 * whitespace, so bodies parse unchanged.
 */

import { AbiCoder, getAddress, hexlify } from 'ethers';

import { Side } from './constants.js';

/** The private answer to every command. */
export type Receipt =
  | { type: 'receipt'; command: string; status: 'accepted'; detail: Record<string, string> }
  | { type: 'receipt'; command: string; status: 'rejected'; reason: string };

/** One intent's share of a settled batch. */
export interface Fill {
  side: 'buy' | 'sell';
  /** Base units received (buy) or given up (sell). */
  base: bigint;
  /** Quote units paid (buy) or received (sell). */
  quote: bigint;
}

/**
 * A settled batch, as reported privately to one strategy's manager.
 *
 * The body does not name the strategy, so a manager running several strategies
 * cannot yet tell their fill events apart.
 */
export interface FillEvent {
  type: 'fills';
  /** `0x`-prefixed bytes16, matching {@link PublicOrder.batchId}. */
  batchId: string;
  /** Fixed-point price every participant settled at. */
  clearingPrice: bigint;
  /** Set when the realised price was worse than a participant's limit. */
  limitBreached: boolean;
  fills: Fill[];
}

/** Sent to a depositor when a deposit is credited. */
export interface DepositEvent {
  type: 'deposit';
  token: string;
  balanceAfter: bigint;
}

export type LegateEvent = Receipt | FillEvent | DepositEvent;

/** The one order a batch sends to market. Public: anyone can read it. */
export interface PublicOrder {
  batchId: string;
  side: Side;
  base: string;
  quote: string;
  baseAmount: bigint;
  /** Most quote a buy may spend, or least a sell must receive. */
  quoteLimit: bigint;
}

class EventParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventParseError';
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EventParseError(`${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new EventParseError(`${field} is not a string`);
  return value;
}

function asBigint(value: unknown, field: string): bigint {
  const s = asString(value, field);
  if (!/^0x[0-9a-fA-F]+$/.test(s)) throw new EventParseError(`${field} is not a hex integer: ${s}`);
  return BigInt(s);
}

/** Decrypted event bytes to a typed event. Throws on anything unrecognised. */
export function parseEvent(body: Uint8Array | string): LegateEvent {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EventParseError('event body is not valid JSON');
  }
  const obj = asRecord(parsed, 'event');

  switch (obj.type) {
    case 'receipt':
      return parseReceiptObject(obj);
    case 'fills':
      return parseFillObject(obj);
    case 'deposit':
      return {
        type: 'deposit',
        token: getAddress(asString(obj.token, 'token')),
        balanceAfter: asBigint(obj.balanceAfter, 'balanceAfter'),
      };
    default:
      throw new EventParseError(`unknown event type: ${String(obj.type)}`);
  }
}

function parseReceiptObject(obj: Record<string, unknown>): Receipt {
  const command = asString(obj.command, 'command');
  if (obj.status === 'accepted') {
    const detail: Record<string, string> = {};
    if (obj.detail !== undefined) {
      for (const [k, v] of Object.entries(asRecord(obj.detail, 'detail'))) {
        detail[k] = asString(v, `detail.${k}`);
      }
    }
    return { type: 'receipt', command, status: 'accepted', detail };
  }
  if (obj.status === 'rejected') {
    return { type: 'receipt', command, status: 'rejected', reason: asString(obj.reason, 'reason') };
  }
  throw new EventParseError(`unknown receipt status: ${String(obj.status)}`);
}

function parseFillObject(obj: Record<string, unknown>): FillEvent {
  const rawFills = obj.fills;
  if (!Array.isArray(rawFills)) throw new EventParseError('fills is not an array');

  const fills = rawFills.map((f, i) => {
    const fill = asRecord(f, `fills[${i}]`);
    const side = fill.side;
    if (side !== 'buy' && side !== 'sell') throw new EventParseError(`fills[${i}].side is not buy or sell`);
    return {
      side,
      base: asBigint(fill.base, `fills[${i}].base`),
      quote: asBigint(fill.quote, `fills[${i}].quote`),
    } satisfies Fill;
  });

  // The enclave writes the batch ID as bare hex; the public order carries it as
  // bytes16. Normalise so the two can be matched.
  const rawId = asString(obj.batchId, 'batchId').toLowerCase();
  const batchId = rawId.startsWith('0x') ? rawId : `0x${rawId}`;

  return {
    type: 'fills',
    batchId,
    clearingPrice: asBigint(obj.clearingPrice, 'clearingPrice'),
    limitBreached: obj.limitBreached === true,
    fills,
  };
}

const ORDER_TYPES = ['bytes16', 'uint8', 'address', 'address', 'uint256', 'uint256'];

/**
 * Decodes the public batch order from its AppEvent data. The layout matches
 * `app.EncodeOrder` and `LegateTrigger`, and is pinned by the cross-language
 * vectors in `contracts/test/fixtures/abi-vectors.json`.
 */
export function decodeOrder(data: Uint8Array | string): PublicOrder {
  const bytes = typeof data === 'string' ? data : hexlify(data);
  const [batchId, side, base, quote, baseAmount, quoteLimit] = AbiCoder.defaultAbiCoder().decode(ORDER_TYPES, bytes);
  const sideNumber = Number(side);
  if (sideNumber !== Side.Buy && sideNumber !== Side.Sell) {
    throw new EventParseError(`order side is not buy or sell: ${sideNumber}`);
  }
  return {
    batchId: String(batchId).toLowerCase(),
    side: sideNumber,
    base: getAddress(String(base)),
    quote: getAddress(String(quote)),
    baseAmount: BigInt(baseAmount),
    quoteLimit: BigInt(quoteLimit),
  };
}
