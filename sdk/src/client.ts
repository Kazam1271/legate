import { JsonRpcProvider, Wallet, encodeBytes32String, type Provider, type Signer } from 'ethers';
import {
  ETH_TOKEN,
  PROTOCOL_VERSION,
  RequestType,
  VelaClient,
  exportPublicKeyToHex,
  hexToBytes,
} from '@horizen/vela-common-ts';

import * as commands from './commands.js';
import type { LegateCommand, Mandate, Prices } from './commands.js';
import { DEFAULT_MAX_FEE, SUBTYPE, type Side } from './constants.js';
import { LegateTimeoutError, LegateValidationError, RequestFailedError } from './errors.js';
import { decodeOrder, parseEvent, type FillEvent, type LegateEvent, type PublicOrder } from './events.js';
import { padPayload } from './padding.js';

export interface LegateConfig {
  /** The Legate app's Vela application ID. */
  applicationId: bigint;
  /** Vela ProcessorEndpoint address. */
  processorEndpoint: string;
  /** Vela TeeAuthenticator address. */
  teeAuthenticator: string;
  /** Ceiling on each request's fee, in wei. Unused fee is refunded. */
  maxFee?: bigint;
  /** How often to poll for results. Default 1000 ms. */
  pollIntervalMs?: number;
  /** How long to wait for a result before giving up. Default 240 s. */
  timeoutMs?: number;
  /** Sign with eth_sign instead of personal_sign, for wallets that lack it. */
  useAlternativeSign?: boolean;
}

/** Where a request landed, which is enough to find everything it produced. */
export interface RequestRef {
  requestId: string;
  /** Block the request was submitted in. Results appear in this block or later. */
  blockNumber: number;
}

/**
 * How a command ended. A rule-based refusal is not an error: on chain it looks
 * exactly like an acceptance, and only the sender can read the reason.
 */
export type CommandOutcome = RequestRef & { fee: bigint } & (
    | { status: 'accepted'; detail: Record<string, string> }
    | { status: 'rejected'; reason: string }
  );

export interface SubmitOptions {
  /**
   * Tokens to deposit with the request. The deposit is credited to the sender's
   * idle balance before the command runs, so depositing and allocating can travel
   * in one request. ERC-20 deposits are approved automatically.
   *
   * A deposit is public; what the command then does with it is not.
   */
  deposit?: { token: string; amount: bigint };
}

/** A range of blocks, oldest first. `toBlock` defaults to the latest block. */
export interface BlockRange {
  fromBlock: number;
  toBlock?: number;
}

/**
 * A client for one participant in one Legate vault.
 *
 * Wraps Vela's `VelaClient`, which handles key derivation, encryption to the
 * enclave and decryption of events, and adds what Legate needs on top: typed
 * commands, the fixed-size padding the enclave enforces, and reading the private
 * receipt every command answers with.
 *
 * The same client serves every role. Strategy managers register strategies and
 * submit or cancel intents; depositors allocate, redeem and withdraw; the operator
 * closes batches. The enclave decides who may do what.
 */
export class LegateClient {
  /** The underlying Vela client, for anything this class does not cover. */
  readonly vela: VelaClient;

  private readonly maxFee: bigint;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(
    readonly signer: Signer,
    readonly config: LegateConfig,
  ) {
    if (typeof config.applicationId !== 'bigint') {
      throw new LegateValidationError('config.applicationId must be a bigint');
    }
    this.vela = new VelaClient(
      signer,
      config.useAlternativeSign ?? false,
      commands.toAddress(config.teeAuthenticator, 'teeAuthenticator'),
      commands.toAddress(config.processorEndpoint, 'processorEndpoint'),
    );
    this.maxFee = config.maxFee ?? DEFAULT_MAX_FEE;
    this.pollIntervalMs = config.pollIntervalMs ?? 1_000;
    this.timeoutMs = config.timeoutMs ?? 240_000;
  }

  /**
   * Builds a client from a raw private key, for bots and agents.
   *
   * Response caching is disabled on the provider. ethers caches identical RPC
   * responses for 250 ms by default, and a chain that mines instantly (such as a
   * local Anvil) can confirm a transaction inside that window, so the next nonce
   * lookup is served a stale count and fails with "nonce too low".
   */
  static fromPrivateKey(privateKey: string, rpcUrl: string, config: LegateConfig): LegateClient {
    const provider = new JsonRpcProvider(rpcUrl, undefined, { pollingInterval: 500, cacheTimeout: -1 });
    return new LegateClient(new Wallet(privateKey, provider), config);
  }

  /** The signer's address. */
  async address(): Promise<string> {
    return this.signer.getAddress();
  }

  private get provider(): Provider {
    const provider = this.signer.provider;
    if (!provider) throw new LegateValidationError('the signer must be connected to a provider');
    return provider;
  }

  // ---------------------------------------------------------------------------
  // Setup

  /**
   * Registers this signer's encryption key with the app. Required once per app,
   * before the signer can send commands or read their results.
   *
   * The key is deliberately registered without a subtype seed. Vela lets a user
   * register a seed so that events addressed to them carry opaque, per-user
   * subtypes instead of the app's labels. For Legate that would weaken privacy
   * rather than strengthen it: every command sends its sender a receipt, and the
   * sender of every request is public, so each receipt would reveal one of the
   * sender's subtypes. Once an observer had collected a manager's subtypes, any
   * fill event carrying one would show that manager traded in that batch. With
   * shared labels, fill events cannot be attributed at all.
   */
  async registerKey(): Promise<RequestRef> {
    const keyPair = await this.vela.getSignerKeyPair();
    const publicKey = hexToBytes(await exportPublicKeyToHex(keyPair.publicKey));

    const receipt = await this.vela.submitRequestAndWaitForRequestId(
      PROTOCOL_VERSION,
      this.config.applicationId,
      RequestType.ASSOCIATEKEY,
      publicKey,
      ETH_TOKEN,
      0n,
      this.maxFee,
    );
    const ref = { requestId: receipt.requestId, blockNumber: receipt.transactionReceipt!.blockNumber };
    const completion = await this.waitForCompletion(ref);
    if (completion.status !== 0n) {
      throw new RequestFailedError(ref.requestId, completion.errorCode, completion.errorMessage);
    }
    return ref;
  }

  // ---------------------------------------------------------------------------
  // Commands

  /**
   * Pads, encrypts and submits a command, waits for the enclave, and returns the
   * outcome from the sender's private receipt.
   *
   * Throws {@link RequestFailedError} if the enclave failed the request publicly.
   * A refusal by the rules is returned, not thrown, as status "rejected".
   */
  async submit(command: LegateCommand, options: SubmitOptions = {}): Promise<CommandOutcome> {
    // Padding first: an oversized command fails here, before anything is sent.
    const payload = padPayload(command);
    const ciphertext = await this.vela.encryptForTee(payload);

    let token = ETH_TOKEN;
    let amount = 0n;
    if (options.deposit) {
      token = options.deposit.token === ETH_TOKEN ? ETH_TOKEN : commands.toAddress(options.deposit.token, 'deposit token');
      amount = options.deposit.amount;
      if (typeof amount !== 'bigint' || amount <= 0n) {
        throw new LegateValidationError('deposit amount must be a positive bigint');
      }
      if (token !== ETH_TOKEN) {
        await (await this.vela.approveToken(token, amount)).wait();
      }
    }

    const submitted = await this.vela.submitRequestAndWaitForRequestId(
      PROTOCOL_VERSION,
      this.config.applicationId,
      RequestType.PROCESS,
      ciphertext,
      token,
      amount,
      this.maxFee,
    );
    const ref = { requestId: submitted.requestId, blockNumber: submitted.transactionReceipt!.blockNumber };

    const completion = await this.waitForCompletion(ref);
    if (completion.status !== 0n) {
      throw new RequestFailedError(ref.requestId, completion.errorCode, completion.errorMessage);
    }

    const receipt = (await this.eventsFor(ref)).find((e) => e.type === 'receipt');
    if (!receipt || receipt.type !== 'receipt') {
      throw new Error(`request ${ref.requestId} completed but no receipt could be decrypted for this signer`);
    }

    return receipt.status === 'accepted'
      ? { ...ref, fee: completion.applicationFees, status: 'accepted', detail: receipt.detail }
      : { ...ref, fee: completion.applicationFees, status: 'rejected', reason: receipt.reason };
  }

  /** Registers a strategy managed by this signer. */
  registerStrategy(id: string, mandate: Mandate, options?: SubmitOptions): Promise<CommandOutcome> {
    return this.submit(commands.registerStrategy(id, mandate), options);
  }

  /** Allocates idle quote balance to a strategy. Pass a deposit to fund it in the same request. */
  allocate(params: { strategyId: string; amount: bigint; prices?: Prices }, options?: SubmitOptions): Promise<CommandOutcome> {
    return this.submit(commands.allocate(params), options);
  }

  /** Redeems shares for idle quote balance at the current NAV. */
  redeem(params: { strategyId: string; shares: bigint; prices?: Prices }, options?: SubmitOptions): Promise<CommandOutcome> {
    return this.submit(commands.redeem(params), options);
  }

  /** Queues an intent. On acceptance, `detail.intentId` identifies it for cancellation. */
  submitIntent(
    params: { strategyId: string; base: string; side: Side; amount: bigint; limitPrice?: bigint },
    options?: SubmitOptions,
  ): Promise<CommandOutcome> {
    return this.submit(commands.submitIntent(params), options);
  }

  /** Cancels one of this signer's queued intents. */
  cancelIntent(intentId: string, options?: SubmitOptions): Promise<CommandOutcome> {
    return this.submit(commands.cancelIntent(intentId), options);
  }

  /**
   * Closes the batch for one token pair. Operator only. On acceptance,
   * `detail.outcome` is "sent_to_market" or "internalised".
   */
  closeBatch(params: { base: string; refPrice: bigint; slippageBps?: number }, options?: SubmitOptions): Promise<CommandOutcome> {
    return this.submit(commands.closeBatch(params), options);
  }

  /** Withdraws idle balance as a claim, then call {@link claim} to receive it. */
  withdraw(params: { token: string; amount: bigint; destination?: string }, options?: SubmitOptions): Promise<CommandOutcome> {
    return this.submit(commands.withdraw(params), options);
  }

  // ---------------------------------------------------------------------------
  // Reading results

  /**
   * Every event from a request that this signer can decrypt.
   *
   * Events are looked up by request and decrypted, rather than filtered by
   * subtype, so a request that carries several events for this signer — a
   * deposit and a receipt, say — returns all of them.
   */
  async eventsFor(ref: RequestRef): Promise<LegateEvent[]> {
    const latest = await this.provider.getBlockNumber();
    // Vela's client takes its block range newest first.
    const bodies = await this.vela.getCurrentUserEvents(
      latest,
      ref.blockNumber,
      this.config.applicationId,
      ref.requestId,
      undefined,
      () => true,
      false,
    );
    return bodies.map((body) => parseEvent(body));
  }

  /**
   * Fill events addressed to this signer under one request: the batch close, for
   * a batch that internalised, or the trusted settlement request, for one that
   * went to market.
   */
  async fillsFor(ref: RequestRef): Promise<FillEvent[]> {
    return (await this.eventsFor(ref)).filter((e): e is FillEvent => e.type === 'fills');
  }

  /**
   * Every fill event addressed to this signer in a block range, whichever request
   * produced it. Managers do not submit the settlement requests their fills
   * arrive in, so this is how they find them.
   */
  async findFills(range: BlockRange): Promise<FillEvent[]> {
    const toBlock = range.toBlock ?? (await this.provider.getBlockNumber());
    const bodies = await this.vela.getCurrentUserEvents(
      toBlock,
      range.fromBlock,
      this.config.applicationId,
      undefined,
      encodeBytes32String(SUBTYPE.fills),
      () => true,
      false,
    );
    return bodies.map((body) => parseEvent(body)).filter((e): e is FillEvent => e.type === 'fills');
  }

  /** The public order a batch close sent to market, or undefined if it internalised or was refused. */
  async publicOrderFor(ref: RequestRef): Promise<PublicOrder | undefined> {
    const latest = await this.provider.getBlockNumber();
    const events = await this.vela.getAppEvents(
      latest,
      ref.blockNumber,
      this.config.applicationId,
      ref.requestId,
      encodeBytes32String(SUBTYPE.batchOrder),
    );
    if (events.length > 1) {
      throw new Error(`expected at most one batch order under ${ref.requestId}, found ${events.length}`);
    }
    return events.length === 1 ? decodeOrder(events[0].data) : undefined;
  }

  /** Waits for the enclave to complete a request, successfully or not. */
  async waitForCompletion(ref: RequestRef): Promise<{
    status: bigint;
    applicationFees: bigint;
    errorCode: bigint | undefined;
    errorMessage: string | undefined;
  }> {
    return this.poll(`request ${ref.requestId} to complete`, async () => {
      const latest = await this.provider.getBlockNumber();
      // Vela's client takes its block range newest first.
      return this.vela.getRequestCompletedEvent(ref.requestId, latest, ref.blockNumber);
    });
  }

  // ---------------------------------------------------------------------------
  // Claims

  /** Tokens withdrawn to `payee` and waiting to be claimed. Defaults to this signer. */
  async pendingClaims(token: string, payee?: string): Promise<bigint> {
    return this.vela.getPendingClaims(commands.toAddress(token, 'token'), payee ?? (await this.address()));
  }

  /** Transfers withdrawn tokens to `payee`. Anyone may pay the gas for any payee. */
  async claim(token: string, payee?: string): Promise<void> {
    await (await this.vela.claim(commands.toAddress(token, 'token'), payee ?? (await this.address()))).wait();
  }

  private async poll<T>(what: string, fn: () => Promise<T | undefined>): Promise<T> {
    const started = Date.now();
    for (;;) {
      const value = await fn();
      if (value !== undefined) return value;
      if (Date.now() - started > this.timeoutMs) throw new LegateTimeoutError(what, this.timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }
}
