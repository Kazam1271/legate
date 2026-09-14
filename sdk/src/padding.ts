import { PADDED_PAYLOAD_SIZE } from './constants.js';
import type { LegateCommand } from './commands.js';
import { PayloadTooLargeError } from './errors.js';

const SPACE = 0x20;

/**
 * Pads a command to exactly {@link PADDED_PAYLOAD_SIZE} bytes with trailing
 * spaces, which JSON permits after a value, so the enclave parses it unchanged.
 *
 * Every command must go through this before encryption. The enclave refuses any
 * other length, because a single unpadded client would leak its own intents by
 * size and thin everyone else's crowd.
 */
export function padPayload(command: LegateCommand | string): Uint8Array {
  const json = typeof command === 'string' ? command : JSON.stringify(command);
  const bytes = new TextEncoder().encode(json);
  if (bytes.length > PADDED_PAYLOAD_SIZE) {
    throw new PayloadTooLargeError(bytes.length, PADDED_PAYLOAD_SIZE);
  }
  const padded = new Uint8Array(PADDED_PAYLOAD_SIZE).fill(SPACE);
  padded.set(bytes);
  return padded;
}
