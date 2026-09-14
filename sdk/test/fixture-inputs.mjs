// Inputs the command fixture is built from. vela-app/app/sdk_fixture_test.go
// hardcodes the same values independently, so a wire-format mismatch between the
// SDK and the Go structs shows up as a failed expectation.

const E18 = 10n ** 18n;

export const FIXTURE_INPUTS = {
  // Letters in the addresses, so checksumming produces mixed case and the Go side
  // proves it accepts that.
  weth: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  usdc: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  destination: '0xcccccccccccccccccccccccccccccccccccccccc',

  strategyId: 'alpha',
  intentId: 'intent-0000000000000001',

  maxOrderBase: 1_000n,
  maxPositionBase: 5_000n,
  allocateAmount: 500_000n,
  redeemShares: 400n,
  buyAmount: 100n,
  sellAmount: 60n,
  withdrawAmount: 750n,

  refPrice: 3_000n * E18,
  limitPrice: 3_100n * E18,
  slippageBps: 50,
};
