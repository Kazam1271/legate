// The JS half of a cross-language contract with the Go app: this asserts the
// command builders still produce exactly what test/fixtures/commands.json
// pins, and vela-app/app/sdk_fixture_test.go asserts Go decodes that same file
// to the intended values. Each side implements the wire format independently;
// nothing else stops them drifting, and a mismatch would otherwise surface only
// against a live enclave, as a command that silently did something other than
// what was intended.
//
// If this test fails after a deliberate wire-format change, update
// fixture-inputs.mjs and the Go side too, then `npm run fixtures` to
// regenerate — never hand-edit fixtures/commands.json.

import { deepStrictEqual, throws } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { commands, Side } from '../dist/index.js';
import { FIXTURE_INPUTS as I } from './fixture-inputs.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/commands.json', import.meta.url)));
const byName = Object.fromEntries(fixture.cases.map((c) => [c.name, c.command]));

test('register_strategy matches the fixture', () => {
  const got = commands.registerStrategy(I.strategyId, {
    allowedTokens: [I.usdc, I.weth],
    maxOrderBase: I.maxOrderBase,
    maxPositionBase: I.maxPositionBase,
  });
  deepStrictEqual(got, byName.register_strategy);
});

test('allocate matches the fixture', () => {
  const got = commands.allocate({ strategyId: I.strategyId, amount: I.allocateAmount, prices: { [I.weth]: I.refPrice } });
  deepStrictEqual(got, byName.allocate);
});

test('redeem matches the fixture', () => {
  const got = commands.redeem({ strategyId: I.strategyId, shares: I.redeemShares });
  deepStrictEqual(got, byName.redeem);
});

test('submit_intent (buy) matches the fixture', () => {
  const got = commands.submitIntent({
    strategyId: I.strategyId, base: I.weth, side: Side.Buy, amount: I.buyAmount, limitPrice: I.limitPrice,
  });
  deepStrictEqual(got, byName.submit_intent_buy);
});

test('submit_intent (unconditional sell) matches the fixture', () => {
  const got = commands.submitIntent({ strategyId: I.strategyId, base: I.weth, side: Side.Sell, amount: I.sellAmount });
  deepStrictEqual(got, byName.submit_intent_sell_unconditional);
});

test('cancel_intent matches the fixture', () => {
  deepStrictEqual(commands.cancelIntent(I.intentId), byName.cancel_intent);
});

test('close_batch matches the fixture', () => {
  const got = commands.closeBatch({ base: I.weth, refPrice: I.refPrice, slippageBps: I.slippageBps });
  deepStrictEqual(got, byName.close_batch);
});

test('withdraw to an explicit destination matches the fixture', () => {
  const got = commands.withdraw({ token: I.usdc, amount: I.withdrawAmount, destination: I.destination });
  deepStrictEqual(got, byName.withdraw_to_destination);
});

test('withdraw with no destination omits the field, matching the fixture', () => {
  const got = commands.withdraw({ token: I.usdc, amount: I.withdrawAmount });
  deepStrictEqual(got, byName.withdraw_to_sender);
  if ('destination' in got.withdraw) {
    throw new Error('destination must be omitted, not sent as undefined/null, or Go would see an empty string');
  }
});

// ---------------------------------------------------------------------------
// Validation: every mistake caught here costs nothing. The same mistake caught
// by the enclave still costs the request fee.

test('a buy without a limit price is refused before anything is sent', () => {
  throws(
    () => commands.submitIntent({ strategyId: 'a', base: I.weth, side: Side.Buy, amount: 1n }),
    /limit price/,
  );
  throws(
    () => commands.submitIntent({ strategyId: 'a', base: I.weth, side: Side.Buy, amount: 1n, limitPrice: 0n }),
    /limit price/,
    'an explicit zero limit price must be refused the same as an absent one',
  );
});

test('a negative amount is refused', () => {
  throws(() => commands.allocate({ strategyId: 'a', amount: -1n }), /negative/);
});

test('an amount that does not fit in 256 bits is refused', () => {
  throws(() => commands.allocate({ strategyId: 'a', amount: 1n << 256n }), /256 bits/);
});

test('a non-bigint amount is refused rather than silently coerced', () => {
  // A caller passing a JS number would otherwise produce a plausible-looking but
  // wrong hex string once coerced, so this must throw rather than proceed.
  throws(() => commands.allocate({ strategyId: 'a', amount: 100 }), /bigint/);
});

test('an invalid address is refused', () => {
  throws(() => commands.submitIntent({ strategyId: 'a', base: 'not-an-address', side: Side.Sell, amount: 1n }), /address/);
});

test('an empty strategy id is refused', () => {
  throws(() => commands.allocate({ strategyId: '', amount: 1n }), /strategyId/);
});

test('a mandate with no allowed tokens is refused', () => {
  throws(() => commands.registerStrategy('a', { allowedTokens: [] }), /allowedTokens/);
});

test('an out-of-range side is refused', () => {
  throws(() => commands.submitIntent({ strategyId: 'a', base: I.weth, side: 2, amount: 1n }), /side/);
});

test('addresses are checksummed regardless of the case supplied', () => {
  const lower = commands.submitIntent({ strategyId: 'a', base: I.weth, side: Side.Sell, amount: 1n });
  const upper = commands.submitIntent({ strategyId: 'a', base: I.weth.toUpperCase().replace('0X', '0x'), side: Side.Sell, amount: 1n });
  deepStrictEqual(lower, upper);
});
