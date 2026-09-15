/**
 * Formatting helpers.
 *
 * These are all locale- and timezone-independent on purpose. `toLocaleString`
 * resolves differently on the server and in the browser, which is a classic
 * source of hydration mismatches; every formatter here produces the same string
 * everywhere.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** Thousands separators without Intl. */
function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function num(value: number, decimals = 2): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [int, frac] = fixed.split('.');
  const body = frac ? group(int) + '.' + frac : group(int);
  return (value < 0 ? '-' : '') + body;
}

export function usd(value: number, decimals = 2): string {
  return '$' + num(value, decimals);
}

/** Compact currency: $18.42m, $412.5k. Used where space is tight. */
export function usdCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return sign + '$' + num(abs / 1e9, 2) + 'b';
  if (abs >= 1e6) return sign + '$' + num(abs / 1e6, 2) + 'm';
  if (abs >= 1e3) return sign + '$' + num(abs / 1e3, 1) + 'k';
  return sign + '$' + num(abs, 2);
}

export function pct(value: number, decimals = 1): string {
  return num(value, decimals) + '%';
}

/** Signed percentage, for returns where direction is the point. */
export function signedPct(value: number, decimals = 1): string {
  return (value > 0 ? '+' : '') + num(value, decimals) + '%';
}

/** Ratio in 0..1 rendered as a percentage. */
export function ratioPct(ratio: number, decimals = 1): string {
  return num(ratio * 100, decimals) + '%';
}

/** Token amounts: trims pointless trailing zeros but keeps real precision. */
export function amount(value: number, maxDecimals = 4): string {
  const rounded = Number(value.toFixed(maxDecimals));
  const decimals = Number.isInteger(rounded) ? 1 : String(rounded).split('.')[1].length;
  return num(rounded, decimals);
}

/** 0xa88d...7c41 */
export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail) return address;
  return address.slice(0, lead) + '...' + address.slice(-tail);
}

export function utcTime(ms: number): string {
  const d = new Date(ms);
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' UTC';
}

export function utcDate(ms: number): string {
  const d = new Date(ms);
  return pad(d.getUTCDate()) + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

export function utcDateTime(ms: number): string {
  return utcDate(ms) + ' ' + utcTime(ms);
}

/** "3h 12m ago", computed against a fixed reference rather than the wall clock. */
export function since(ms: number, now: number): string {
  const delta = Math.max(0, now - ms);
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem === 0 ? hours + 'h ago' : hours + 'h ' + rem + 'm ago';
  return Math.floor(hours / 24) + 'd ago';
}

/** mm:ss, for the batch countdown. */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  return pad(Math.floor(s / 60)) + ':' + pad(s % 60);
}
