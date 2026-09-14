import { deepStrictEqual, throws } from 'node:assert';
import { test } from 'node:test';
import { AbiCoder, getAddress } from 'ethers';

import { decodeOrder, parseEvent, Side } from '../dist/index.js';

const encode = (json) => new TextEncoder().encode(json);

test('parses an accepted receipt', () => {
  const event = parseEvent(encode(JSON.stringify({
    type: 'receipt', command: 'submit_intent', status: 'accepted', detail: { intentId: 'intent-01' },
  })));
  deepStrictEqual(event, {
    type: 'receipt', command: 'submit_intent', status: 'accepted', detail: { intentId: 'intent-01' },
  });
});

test('parses a rejected receipt, and does not require a detail field', () => {
  const event = parseEvent(encode(JSON.stringify({
    command: 'allocate', type: 'receipt', status: 'rejected', reason: 'allocate: insufficient balance',
  })));
  deepStrictEqual(event, {
    type: 'receipt', command: 'allocate', status: 'rejected', reason: 'allocate: insufficient balance',
  });
});

test('parses a fills event, converting hex fields to bigint', () => {
  const event = parseEvent(encode(JSON.stringify({
    type: 'fills',
    batchId: '0000000000000000000000000000000a',
    clearingPrice: '0xa2a15d09519be00000',
    limitBreached: false,
    fills: [
      { side: 'buy', base: '0x64', quote: '0x2540be400' },
      { side: 'sell', base: '0x1', quote: '0x1' },
    ],
  })));
  deepStrictEqual(event.type, 'fills');
  deepStrictEqual(event.batchId, '0x0000000000000000000000000000000a');
  deepStrictEqual(event.clearingPrice, 3_000n * 10n ** 18n);
  deepStrictEqual(event.limitBreached, false);
  deepStrictEqual(event.fills[0], { side: 'buy', base: 100n, quote: 10_000_000_000n });
});

test('trailing padding (spaces after the JSON value) is ignored', () => {
  const token = '0x' + 'aa'.repeat(20);
  const withPadding = encode(JSON.stringify({ type: 'deposit', token, balanceAfter: '0x64' }) + '    ');
  deepStrictEqual(parseEvent(withPadding), { type: 'deposit', token: getAddress(token), balanceAfter: 100n });
});

test('an event of an unrecognised type is rejected rather than silently ignored', () => {
  throws(() => parseEvent(encode(JSON.stringify({ type: 'mystery' }))));
});

test('malformed JSON is rejected', () => {
  throws(() => parseEvent(encode('{not json')));
});

test('decodeOrder round-trips what a real trigger produces', () => {
  const weth = '0x' + 'aa'.repeat(20);
  const usdc = '0x' + 'bb'.repeat(20);
  const batchId = '0x00000000000000000000000000000007';
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['bytes16', 'uint8', 'address', 'address', 'uint256', 'uint256'],
    [batchId, Side.Buy, weth, usdc, 40n, 124_000n],
  );

  const order = decodeOrder(encoded);
  deepStrictEqual(order.batchId, batchId);
  deepStrictEqual(order.side, Side.Buy);
  deepStrictEqual(order.baseAmount, 40n);
  deepStrictEqual(order.quoteLimit, 124_000n);
});

test('decodeOrder rejects a side outside buy/sell', () => {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['bytes16', 'uint8', 'address', 'address', 'uint256', 'uint256'],
    ['0x' + '00'.repeat(16), 7, '0x' + 'aa'.repeat(20), '0x' + 'bb'.repeat(20), 1n, 1n],
  );
  throws(() => decodeOrder(encoded));
});
