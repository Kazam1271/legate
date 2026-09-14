/**
 * Errors the SDK raises.
 *
 * A Legate command can fail in three different places, and they call for
 * different handling:
 *
 *   - Before it is sent ({@link LegateValidationError}, {@link PayloadTooLargeError}).
 *     Checked locally, so a mistake costs nothing.
 *   - Publicly, on chain ({@link RequestFailedError}). The enclave refused a
 *     malformed request, and the reason is visible to everyone.
 *   - Privately. The request succeeded on chain, but the rules refused it. That is
 *     not an error at all: it comes back as an outcome with status "rejected",
 *     and only the sender can read the reason.
 */

/** Input the SDK can tell is wrong before anything is sent. */
export class LegateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegateValidationError';
  }
}

/** A command whose JSON does not fit the fixed padded size. */
export class PayloadTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`command is ${size} bytes, over the ${limit}-byte padded size`);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * A request the enclave failed publicly. Its reason is in the signed
 * RequestCompleted event, readable by anyone.
 */
export class RequestFailedError extends Error {
  constructor(
    readonly requestId: string,
    readonly errorCode: bigint | undefined,
    readonly errorMessage: string | undefined,
  ) {
    super(`request ${requestId} failed in the enclave (code ${errorCode}): ${errorMessage ?? 'no message'}`);
    this.name = 'RequestFailedError';
  }
}

/** Something expected on chain did not appear in time. */
export class LegateTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms waiting for ${what}`);
    this.name = 'LegateTimeoutError';
  }
}
