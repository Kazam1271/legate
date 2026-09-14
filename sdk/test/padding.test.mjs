// padPayload is a privacy mechanism, not a convenience, so its invariants are
// tested directly: fixed output length, and the padding is invisible to a JSON
// parser (which is what lets the enclave decode a padded payload unchanged).

import { deepStrictEqual, throws } from 'node:assert';
import { test } from 'node:test';

import { padPayload, PADDED_PAYLOAD_SIZE, PayloadTooLargeError } from '../dist/index.js';

test('every command pads to exactly the fixed size', () => {
  const short = padPayload({ command: 'redeem', redeem: { strategyId: 'a', shares: '0x1', prices: {} } });
  const longer = padPayload({
    command: 'register_strategy',
    registerStrategy: { id: 'a-fairly-long-strategy-identifier', mandate: { allowedTokens: ['0x' + 'aa'.repeat(20)] } },
  });
  deepStrictEqual(short.length, PADDED_PAYLOAD_SIZE);
  deepStrictEqual(longer.length, PADDED_PAYLOAD_SIZE);
});

test('two different commands of different natural length pad to the same size', () => {
  // The whole point: without this, an observer could tell commands apart by
  // ciphertext length alone, which is what the first live run on Vela showed.
  const a = padPayload({ command: 'redeem', redeem: { strategyId: 'a', shares: '0x1', prices: {} } });
  const b = padPayload({
    command: 'submit_intent',
    intent: { strategyId: 'a', base: '0x' + 'bb'.repeat(20), side: 0, amount: '0x64', limitPrice: '0x1' },
  });
  deepStrictEqual(a.length, b.length);
});

test('padding is trailing spaces a JSON parser ignores', () => {
  const command = { command: 'redeem', redeem: { strategyId: 'a', shares: '0x1', prices: {} } };
  const padded = padPayload(command);
  const text = new TextDecoder().decode(padded);
  deepStrictEqual(JSON.parse(text), command);
});

test('a command larger than the padded size is refused before it is sent', () => {
  const hugeId = 'x'.repeat(PADDED_PAYLOAD_SIZE);
  throws(
    () => padPayload({ command: 'redeem', redeem: { strategyId: hugeId, shares: '0x1', prices: {} } }),
    PayloadTooLargeError,
  );
});

test('padPayload accepts a raw JSON string as well as a command object', () => {
  const a = padPayload('{"command":"redeem"}');
  const b = padPayload({ command: 'redeem' });
  deepStrictEqual(a, b);
});
