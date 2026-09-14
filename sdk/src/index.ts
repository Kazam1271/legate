/**
 * Legate SDK — a client for Legate's confidential vault engine on Vela.
 *
 * See the README in this package for usage.
 */

export { LegateClient } from './client.js';
export type { BlockRange, CommandOutcome, LegateConfig, RequestRef, SubmitOptions } from './client.js';

export * as commands from './commands.js';
export type { Hex, LegateCommand, Mandate, Prices } from './commands.js';

export { decodeOrder, parseEvent } from './events.js';
export type { DepositEvent, Fill, FillEvent, LegateEvent, PublicOrder, Receipt } from './events.js';

export { padPayload } from './padding.js';
export { DEFAULT_MAX_FEE, PADDED_PAYLOAD_SIZE, PRICE_SCALE, Side, SUBTYPE } from './constants.js';
export { LegateTimeoutError, LegateValidationError, PayloadTooLargeError, RequestFailedError } from './errors.js';

export const SDK_VERSION = '0.1.0';
