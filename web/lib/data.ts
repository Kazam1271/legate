/**
 * Mock data for the Legate interface.
 *
 * Every value here is DETERMINISTIC: seeded pseudo-randomness and a fixed
 * epoch, never Math.random() or Date.now() at render time. The server and the
 * client must produce identical markup, or React discards the server render.
 * Anything genuinely live (a countdown) belongs in a client component behind a
 * mounted guard — see components/next-batch.tsx.
 */

/** mulberry32 — small, fast, and identical on every platform. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed reference time for the whole app: 2026-09-15 14:32:08 UTC. */
export const EPOCH = Date.UTC(2026, 8, 15, 14, 32, 8);

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type Side = 'buy' | 'sell';

export const TOKENS = ['WETH', 'WBTC', 'ZEN', 'USDC'] as const;

export interface Mandate {
  /** Tokens the enclave will accept an intent for. */
  tokens: string[];
  /** Largest single intent, in base units. */
  maxOrderSize: number;
  /** Largest position the strategy may hold, in base units. */
  maxPositionSize: number;
  baseSymbol: string;
}

export interface Strategy {
  id: string;
  name: string;
  manager: string;
  /** Net asset value per share, in quote currency. */
  nav: number;
  /** Total value allocated to this strategy, in quote currency. */
  tvl: number;
  /** Return since inception, as a percentage. */
  returnPct: number;
  /** Worst peak-to-trough decline observed, as a positive percentage. */
  drawdownPct: number;
  depositors: number;
  managementFeePct: number;
  performanceFeePct: number;
  mandate: Mandate;
  inceptionDays: number;
  /** NAV per share, oldest first, one point per day. */
  navHistory: number[];
}

interface StrategySeed {
  id: string;
  name: string;
  manager: string;
  seed: number;
  startNav: number;
  returnPct: number;
  volatility: number;
  tvl: number;
  depositors: number;
  managementFeePct: number;
  performanceFeePct: number;
  mandate: Mandate;
}

const STRATEGY_SEEDS: StrategySeed[] = [
  {
    id: 'vector-momentum',
    name: 'Vector Momentum',
    manager: '0xa88d4f2b9c7e1a3d5f8b0c2e4a6d9f1b3c5e7c41',
    seed: 1_337,
    startNav: 1_481.67,
    returnPct: 41.2,
    volatility: 0.021,
    tvl: 8_940_000,
    depositors: 212,
    managementFeePct: 2,
    performanceFeePct: 20,
    mandate: { tokens: ['WETH', 'USDC'], maxOrderSize: 250, maxPositionSize: 1_200, baseSymbol: 'WETH' },
  },
  {
    id: 'arbiter-systematic',
    name: 'Arbiter Systematic',
    manager: '0x91ed7c3a5b8f2d4e6a0c9b1d3f5a7e9c2b4d19fb',
    seed: 2_089,
    startNav: 1_920.4,
    returnPct: 27.8,
    volatility: 0.013,
    tvl: 12_410_000,
    depositors: 348,
    managementFeePct: 2,
    performanceFeePct: 20,
    mandate: { tokens: ['WETH', 'WBTC', 'USDC'], maxOrderSize: 400, maxPositionSize: 2_000, baseSymbol: 'WETH' },
  },
  {
    id: 'delta-neutral-core',
    name: 'Delta Neutral Core',
    manager: '0x4b7fa19d2e6c8035b1d4f7a9c2e5b8d0f3a6c72e',
    seed: 3_571,
    startNav: 1_044.9,
    returnPct: 9.4,
    volatility: 0.005,
    tvl: 6_205_000,
    depositors: 401,
    managementFeePct: 1,
    performanceFeePct: 10,
    mandate: { tokens: ['WETH', 'USDC'], maxOrderSize: 600, maxPositionSize: 3_000, baseSymbol: 'WETH' },
  },
  {
    id: 'basis-harvest',
    name: 'Basis Harvest',
    manager: '0xc20e5d8b4a1f7c396e2b0d5a8f1c4e7b9d3a60f5',
    seed: 4_231,
    startNav: 1_128.3,
    returnPct: 18.6,
    volatility: 0.009,
    tvl: 4_870_000,
    depositors: 156,
    managementFeePct: 2,
    performanceFeePct: 15,
    mandate: { tokens: ['WBTC', 'USDC'], maxOrderSize: 30, maxPositionSize: 140, baseSymbol: 'WBTC' },
  },
  {
    id: 'volatility-carry',
    name: 'Volatility Carry',
    manager: '0x7d3b9e0c6a2f8154d7b3e9a0c5f2b8d6e1a4c39b',
    seed: 5_903,
    startNav: 2_310.75,
    returnPct: 33.1,
    volatility: 0.028,
    tvl: 3_115_000,
    depositors: 87,
    managementFeePct: 2,
    performanceFeePct: 25,
    mandate: { tokens: ['WETH', 'USDC'], maxOrderSize: 180, maxPositionSize: 700, baseSymbol: 'WETH' },
  },
  {
    id: 'mean-reversion-nine',
    name: 'Mean Reversion Nine',
    manager: '0x1f6c8a3d5b0e9274c6a8f1d3b5e7092a4c6e81d7',
    seed: 6_449,
    startNav: 987.2,
    returnPct: -4.3,
    volatility: 0.016,
    tvl: 1_640_000,
    depositors: 63,
    managementFeePct: 2,
    performanceFeePct: 20,
    mandate: { tokens: ['WETH', 'USDC'], maxOrderSize: 120, maxPositionSize: 500, baseSymbol: 'WETH' },
  },
  {
    id: 'liquidity-provision-alpha',
    name: 'Liquidity Provision Alpha',
    manager: '0x8e2a4c6b0d9f7135a2c4e6b8d0f2a4c6e8b0d295',
    seed: 7_717,
    startNav: 1_203.55,
    returnPct: 14.9,
    volatility: 0.007,
    tvl: 9_720_000,
    depositors: 274,
    managementFeePct: 1.5,
    performanceFeePct: 12,
    mandate: { tokens: ['WETH', 'ZEN', 'USDC'], maxOrderSize: 350, maxPositionSize: 1_500, baseSymbol: 'WETH' },
  },
  {
    id: 'thesis-long-horizon',
    name: 'Thesis Long Horizon',
    manager: '0x5a9c1e3b7d0f2846b9d1f3a5c7e9b1d3f5a7c904',
    seed: 8_863,
    startNav: 1_655.1,
    returnPct: 22.4,
    volatility: 0.019,
    tvl: 5_330_000,
    depositors: 118,
    managementFeePct: 2,
    performanceFeePct: 20,
    mandate: { tokens: ['WBTC', 'WETH', 'USDC'], maxOrderSize: 200, maxPositionSize: 900, baseSymbol: 'WETH' },
  },
];

const HISTORY_DAYS = 180;

/**
 * Builds a NAV series that ends exactly on the stated return but wanders on the
 * way there. A straight line reads as fake; noise around a drift does not.
 */
function buildNavHistory(s: StrategySeed): number[] {
  const random = rng(s.seed);
  const endNav = s.startNav * (1 + s.returnPct / 100);
  const steps = HISTORY_DAYS - 1;

  const shocks: number[] = [];
  for (let i = 0; i < steps; i++) {
    // Box-Muller, so the walk has normal-ish tails rather than uniform ones.
    const u1 = Math.max(random(), 1e-9);
    const u2 = random();
    shocks.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * s.volatility);
  }

  // Centre the shocks so they add no net drift, then apply the drift that lands
  // the series on endNav.
  const meanShock = shocks.reduce((a, b) => a + b, 0) / steps;
  const drift = (Math.log(endNav) - Math.log(s.startNav)) / steps;

  const series = [s.startNav];
  for (let i = 0; i < steps; i++) {
    const prev = series[series.length - 1];
    series.push(prev * Math.exp(drift + (shocks[i] - meanShock)));
  }

  // Compounding error over 180 steps leaves the last point a hair off.
  series[series.length - 1] = endNav;
  return series.map((v) => Math.round(v * 100) / 100);
}

function maxDrawdown(series: number[]): number {
  let peak = series[0];
  let worst = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > worst) worst = dd;
  }
  return Math.round(worst * 1000) / 10;
}

export const STRATEGIES: Strategy[] = STRATEGY_SEEDS.map((s) => {
  const navHistory = buildNavHistory(s);
  return {
    id: s.id,
    name: s.name,
    manager: s.manager,
    nav: navHistory[navHistory.length - 1],
    tvl: s.tvl,
    returnPct: s.returnPct,
    drawdownPct: maxDrawdown(navHistory),
    depositors: s.depositors,
    managementFeePct: s.managementFeePct,
    performanceFeePct: s.performanceFeePct,
    mandate: s.mandate,
    inceptionDays: HISTORY_DAYS,
    navHistory,
  };
});

export function strategyById(id: string): Strategy | undefined {
  return STRATEGIES.find((s) => s.id === id);
}

export interface Batch {
  id: string;
  /** Milliseconds since the Unix epoch; fixed, never Date.now(). */
  timestamp: number;
  base: string;
  quote: string;
  clearingPrice: number;
  /** Base volume matched inside the enclave. Never reaches the market. */
  crossedBase: number;
  /** Base volume sent to market as one public order. */
  residualBase: number;
  residualSide: Side;
  /** Distinct strategies that contributed intents. */
  contributors: number;
}

interface BatchSeed {
  base: string;
  price: number;
  total: number;
  crossRatio: number;
  side: Side;
  contributors: number;
}

const BATCH_SEEDS: BatchSeed[] = [
  { base: 'WETH', price: 3_184.2, total: 168, crossRatio: 1, side: 'buy', contributors: 6 },
  { base: 'WETH', price: 3_176.85, total: 241, crossRatio: 0.883, side: 'buy', contributors: 7 },
  { base: 'WBTC', price: 71_402.5, total: 14.4, crossRatio: 0.792, side: 'sell', contributors: 4 },
  { base: 'WETH', price: 3_169.4, total: 96, crossRatio: 1, side: 'sell', contributors: 5 },
  { base: 'WETH', price: 3_158.12, total: 312, crossRatio: 0.836, side: 'sell', contributors: 8 },
  { base: 'ZEN', price: 18.44, total: 21_500, crossRatio: 0.714, side: 'buy', contributors: 3 },
  { base: 'WETH', price: 3_151.9, total: 187, crossRatio: 0.925, side: 'buy', contributors: 6 },
  { base: 'WBTC', price: 71_188.0, total: 9.2, crossRatio: 1, side: 'buy', contributors: 4 },
  { base: 'WETH', price: 3_142.66, total: 204, crossRatio: 0.804, side: 'sell', contributors: 7 },
  { base: 'WETH', price: 3_137.05, total: 143, crossRatio: 0.867, side: 'buy', contributors: 5 },
  { base: 'ZEN', price: 18.29, total: 16_800, crossRatio: 0.881, side: 'sell', contributors: 3 },
  { base: 'WETH', price: 3_129.74, total: 276, crossRatio: 0.942, side: 'buy', contributors: 8 },
  { base: 'WBTC', price: 70_954.3, total: 11.6, crossRatio: 0.759, side: 'sell', contributors: 4 },
  { base: 'WETH', price: 3_118.5, total: 122, crossRatio: 1, side: 'sell', contributors: 5 },
  { base: 'WETH', price: 3_110.28, total: 198, crossRatio: 0.848, side: 'buy', contributors: 6 },
  { base: 'WETH', price: 3_101.9, total: 164, crossRatio: 0.793, side: 'sell', contributors: 6 },
];

export const BATCHES: Batch[] = BATCH_SEEDS.map((b, i) => {
  const crossedBase = Math.round(b.total * b.crossRatio * 1000) / 1000;
  const residualBase = Math.round((b.total - crossedBase) * 1000) / 1000;
  return {
    id: 'B-' + (8841 - i),
    timestamp: EPOCH - i * 47 * MINUTE,
    base: b.base,
    quote: 'USDC',
    clearingPrice: b.price,
    crossedBase,
    residualBase,
    residualSide: b.side,
    contributors: b.contributors,
  };
});

export function nettingRatio(b: Batch): number {
  const total = b.crossedBase + b.residualBase;
  return total === 0 ? 0 : b.crossedBase / total;
}

/** Quote-currency value of everything in a batch, crossed and residual alike. */
export function batchVolume(b: Batch): number {
  return (b.crossedBase + b.residualBase) * b.clearingPrice;
}

export function crossedVolume(b: Batch): number {
  return b.crossedBase * b.clearingPrice;
}

/** Batches a given strategy contributed to. Only public batch facts are shown. */
export function batchesFor(strategyId: string): Batch[] {
  const offset = STRATEGIES.findIndex((s) => s.id === strategyId);
  return BATCHES.filter((_, i) => (i + offset) % 2 === 0).slice(0, 8);
}

const totalVolume = BATCHES.reduce((sum, b) => sum + batchVolume(b), 0);
const totalCrossed = BATCHES.reduce((sum, b) => sum + crossedVolume(b), 0);

const dayBatches = BATCHES.filter((b) => b.timestamp > EPOCH - DAY);
const dayVolume = dayBatches.reduce((sum, b) => sum + batchVolume(b), 0);
const dayCrossed = dayBatches.reduce((sum, b) => sum + crossedVolume(b), 0);

export const PROTOCOL_STATS = {
  strategiesLive: 24,
  valueInVaults: STRATEGIES.reduce((sum, s) => sum + s.tvl, 0),
  batchesSettled: 18_402,
  /** Share of all volume matched inside the enclave, across every batch. */
  nettingRatio: totalCrossed / totalVolume,
  enclave: 'vela-tee-04',
  attestation: 'verified',
  lastBatchAt: EPOCH,
};

export const LAST_24H = {
  batches: 96,
  volume: dayVolume,
  crossed: dayCrossed,
  ratio: dayCrossed / dayVolume,
};

/** A strategy's own outcome from a settled batch. Only its manager sees this. */
export interface Fill {
  batchId: string;
  timestamp: number;
  side: Side;
  base: string;
  amount: number;
  price: number;
  /** False when the residual leg failed and only crossed volume settled. */
  filled: boolean;
}

export const PRIVATE_FILLS: Record<string, Fill[]> = {
  'vector-momentum': [
    { batchId: 'B-8841', timestamp: EPOCH, side: 'buy', base: 'WETH', amount: 42, price: 3_184.2, filled: true },
    { batchId: 'B-8840', timestamp: EPOCH - 47 * MINUTE, side: 'buy', base: 'WETH', amount: 68, price: 3_176.85, filled: true },
    { batchId: 'B-8838', timestamp: EPOCH - 141 * MINUTE, side: 'sell', base: 'WETH', amount: 25, price: 3_169.4, filled: true },
    { batchId: 'B-8837', timestamp: EPOCH - 188 * MINUTE, side: 'sell', base: 'WETH', amount: 90, price: 3_158.12, filled: true },
    { batchId: 'B-8835', timestamp: EPOCH - 282 * MINUTE, side: 'buy', base: 'WETH', amount: 54, price: 3_151.9, filled: true },
    { batchId: 'B-8833', timestamp: EPOCH - 376 * MINUTE, side: 'sell', base: 'WETH', amount: 31, price: 3_142.66, filled: false },
  ],
  'arbiter-systematic': [
    { batchId: 'B-8841', timestamp: EPOCH, side: 'sell', base: 'WETH', amount: 60, price: 3_184.2, filled: true },
    { batchId: 'B-8839', timestamp: EPOCH - 94 * MINUTE, side: 'sell', base: 'WBTC', amount: 4.2, price: 71_402.5, filled: true },
    { batchId: 'B-8838', timestamp: EPOCH - 141 * MINUTE, side: 'buy', base: 'WETH', amount: 18, price: 3_169.4, filled: true },
    { batchId: 'B-8834', timestamp: EPOCH - 329 * MINUTE, side: 'buy', base: 'WBTC', amount: 2.8, price: 71_188.0, filled: true },
  ],
};

/** Intents waiting for the next batch to close. Private until netted. */
export interface QueuedIntent {
  id: string;
  side: Side;
  base: string;
  amount: number;
  limitPrice?: number;
}

export const QUEUED_INTENTS: Record<string, QueuedIntent[]> = {
  'vector-momentum': [
    { id: 'i-0e41', side: 'buy', base: 'WETH', amount: 35, limitPrice: 3_200 },
    { id: 'i-0e42', side: 'sell', base: 'WETH', amount: 12 },
  ],
  'arbiter-systematic': [{ id: 'i-0e40', side: 'buy', base: 'WBTC', amount: 1.5, limitPrice: 71_800 }],
};

/** Strategies the signed-in manager controls, for the console. */
export const MY_STRATEGY_IDS = ['vector-momentum', 'arbiter-systematic'];

/** Seconds until the next batch closes, at EPOCH. Ticks only on the client. */
export const NEXT_BATCH_SECONDS = 134;
