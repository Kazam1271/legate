// End-to-end run of Legate against a live local Vela stack, driven through
// @legate/sdk rather than talking to @horizen/vela-common-ts by hand.
//
// This is deliberately the same scenario the original hand-rolled version of
// this script ran (kept in git history — see the commit that introduced the
// SDK), now proving the SDK itself against a real enclave rather than only
// against Go's in-process tests. Two batches:
//
//   Batch 1 — both strategies buy. Nothing nets, so the whole flow goes to market
//   and back: withdrawal to the trigger, swap, sweep, trusted settlement.
//
//   Batch 2 — alpha buys 10 WETH while beta sells 6. They net inside the enclave,
//   and the only order that ever appears on chain is the residual 4. That is the
//   privacy claim, observed on a real chain rather than asserted in a test.
//
// What the SDK still doesn't cover, by design, is kept at the raw
// @horizen/vela-common-ts / ethers level: deploying the app itself (not a
// Legate business command), and reading the trigger contract's own events
// (BatchOrderExecuted, TriggerExecuted) and the raw public shape of a UserEvent
// (subtype + ciphertext length, with no decryption) — an outside observer's
// view, which is not something a participant's own client would ever compute
// about someone else's request.
//
// Prerequisites:
//   1. The vela-starterkit stack is running (docker compose up).
//   2. npx hardhat compile                              (contract artifacts)
//   3. cd ../vela-app && ./build.sh production_build     (the WASM)
//   4. cd ../sdk && npm run build                        (the SDK's dist/)
//
// Run:  node scripts/e2e-local.mjs
//
// Addresses default to the deterministic ones the starter kit deploys on Anvil,
// and can be overridden with VELA_PROCESSOR / VELA_TEE_AUTH / VELA_RPC /
// VELA_AUTHORITY.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ethers } from 'ethers';
import { VelaClient, RequestType, PROTOCOL_VERSION, ETH_TOKEN, stringToBytes } from '@horizen/vela-common-ts';
import { LegateClient, Side, commands } from '@legate/sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.resolve(here, '..');
const wasmPath = path.resolve(contractsDir, '../vela-app/production_build/legate_app.wasm');

const RPC = process.env.VELA_RPC ?? 'http://127.0.0.1:8545';
const AUTHORITY = process.env.VELA_AUTHORITY ?? 'http://127.0.0.1:8081';
const PROCESSOR = process.env.VELA_PROCESSOR ?? '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9';
const TEE_AUTH = process.env.VELA_TEE_AUTH ?? '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';

// Anvil's well-known development keys. Account #2 is deliberately skipped: the
// starter kit's manager signs with it, and sharing it would race the manager for
// nonces.
const KEYS = {
  admin: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // #0, holds DEPLOYER_ROLE
  operator: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // #3
  alphaManager: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // #4
  betaManager: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', // #5
  depositor: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e', // #6
};

const E18 = 10n ** 18n;
const REF_PRICE = 3000n * E18;
const LIMIT_PRICE = 3100n * E18;
const MAX_FEE = ethers.parseEther('0.01');

// cacheTimeout is disabled deliberately. ethers caches identical RPC responses
// for 250ms by default, and the starter kit's Anvil mines each transaction the
// instant it arrives. A deploy can therefore confirm inside that window, and the
// next transaction's nonce lookup is served the stale cached count — failing with
// "nonce too low" on a chain that is working perfectly.
const provider = new ethers.JsonRpcProvider(RPC, undefined, { pollingInterval: 500, cacheTimeout: -1 });

// ---------------------------------------------------------------------------
// Output

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

let stepNo = 0;
function step(title) {
  stepNo += 1;
  console.log(`\n${bold(`${stepNo}. ${title}`)}`);
}
const info = (msg) => console.log(`   ${msg}`);
const ok = (msg) => console.log(`   ${green('✔')} ${msg}`);

function check(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
  ok(message);
}

const fmt = (units) => ethers.formatUnits(units, 18);
const hex = (n) => '0x' + BigInt(n).toString(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Chain helpers not covered by the SDK

async function artifact(sourceFile, name) {
  const p = path.join(contractsDir, 'artifacts', 'contracts', sourceFile, `${name}.json`);
  return JSON.parse(await readFile(p, 'utf8'));
}

async function deploy(signer, sourceFile, name, ...args) {
  const { abi, bytecode } = await artifact(sourceFile, name);
  const contract = await new ethers.ContractFactory(abi, bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function poll(label, fn, { timeoutMs = 240_000, intervalMs = 1_000 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null && value !== false) {
      return value;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

// Finds the TRUSTPROCESS request the trigger enqueued for a batch and waits for
// the enclave to settle it. Not a command any of our actors submitted, so it sits
// outside what LegateClient covers; adminVela's raw endpoint reference finds it
// by sender instead.
async function waitForSettlement(adminVela, appId, trigger, fromBlock) {
  const endpoint = adminVela.processorEndpoint;
  const requestId = await poll('the trigger to enqueue a trusted settlement', async () => {
    const latest = await provider.getBlockNumber();
    const events = await endpoint.queryFilter(
      endpoint.filters.RequestSubmitted(appId, undefined, trigger),
      fromBlock,
      latest,
    );
    return events.map((e) => e.args.requestId).find((id) => !submitted.has(id));
  });
  // The trigger's own request: plaintext, not an encrypted Legate command.
  submitted.add(requestId);
  const result = await poll('trusted settlement to complete', () => adminVela.getRequestCompletedEvent(requestId, undefined, fromBlock));
  if (result.status !== 0n) {
    throw new Error(`trusted settlement failed in the enclave (code ${result.errorCode}): ${result.errorMessage}`);
  }
  return requestId;
}

// The public shape of a request's encrypted events: what an observer can see
// without any key. Deliberately outside the SDK, which only ever decrypts for
// the signer it was constructed with.
async function publicUserEvents(adminVela, appId, requestId, fromBlock) {
  const endpoint = adminVela.processorEndpoint;
  const latest = await provider.getBlockNumber();
  const events = await endpoint.queryFilter(endpoint.filters.UserEvent(appId, requestId), fromBlock, latest);
  return events.map((e) => ({
    subtype: ethers.decodeBytes32String(e.args.eventSubType),
    bytes: ethers.dataLength(e.args.encryptedData),
  }));
}

// Every request we submit, so the trigger's own requests can be told apart.
const submitted = new Set();

// Every request that carried a Legate command through the SDK's padding and
// encryption — everything except key registration (a raw public key, not a
// padded command), the deliberately unpadded intent (step 8), and the
// trigger's own TRUSTPROCESS requests (plaintext, not encrypted at all).
// Checked at the end for uniform ciphertext length.
const processRequests = new Set();

// Reads back the payload length the chain actually received for a request, by
// finding the transaction that submitted it and decoding its own calldata. This
// is ground truth: not what the client computed locally before sending, but what
// is actually sitting in a mined block.
async function onChainPayloadBytes(endpoint, appId, requestId) {
  const [event] = await endpoint.queryFilter(endpoint.filters.RequestSubmitted(appId, requestId));
  if (!event) throw new Error(`no RequestSubmitted event found for ${requestId}`);
  const tx = await provider.getTransaction(event.transactionHash);
  const parsed = endpoint.interface.parseTransaction({ data: tx.data, value: tx.value });
  return ethers.dataLength(parsed.args.payload);
}

// Marks a request as both submitted (so waitForSettlement can tell the
// trigger's own requests apart) and, for a real padded Legate command, tracked
// for the ciphertext-length check.
function track(requestId, { isCommand = true } = {}) {
  submitted.add(requestId);
  if (isCommand) processRequests.add(requestId);
}

function totalBase(fillEvents, side) {
  let total = 0n;
  for (const event of fillEvents) {
    for (const f of event.fills) {
      if (f.side === side) total += f.base;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------

async function runBatch(label, appId, operator, alpha, beta, trigger, weth, intents) {
  const triggerAddress = await trigger.getAddress();
  step(`${label}: strategies submit encrypted intents`);
  const submissions = [];
  for (const { who, strategyId, side, amount, limit } of intents) {
    const outcome = await who.submitIntent({ strategyId, base: weth, side, amount, limitPrice: limit });
    track(outcome.requestId);
    info(
      `${who.__name}: ${side === Side.Buy ? 'buy' : 'sell'} ${fmt(amount)} WETH on ${strategyId} ` +
        dim(`→ accepted, intent ${outcome.detail.intentId}`),
    );
    submissions.push({ who, ...outcome });
  }

  step(`${label}: operator closes the batch`);
  const close = await operator.closeBatch({ base: weth, refPrice: REF_PRICE, slippageBps: 0 });
  track(close.requestId);
  const closeRef = { requestId: close.requestId, blockNumber: close.blockNumber };

  const order = await operator.publicOrderFor(closeRef);
  if (!order) {
    throw new Error(`close_batch reported "${close.detail.outcome}" but produced no public order`);
  }
  info(`public order: ${order.side === Side.Buy ? 'buy' : 'sell'} ${fmt(order.baseAmount)} WETH, quote bound ${fmt(order.quoteLimit)}`);

  const endpoint = operator.vela.processorEndpoint;
  const executed = await poll('the trigger to execute', async () => {
    const latest = await provider.getBlockNumber();
    const events = await endpoint.queryFilter(endpoint.filters.TriggerExecuted(appId, close.requestId), close.blockNumber, latest);
    return events[0];
  });
  check(executed.args.success, 'the trigger executed the order on chain');

  const [swap] = await trigger.queryFilter(trigger.filters.BatchOrderExecuted(order.batchId), close.blockNumber);
  check(swap !== undefined, `venue filled ${fmt(swap?.args.baseFilled ?? 0n)} WETH for ${fmt(swap?.args.quoteMoved ?? 0n)} USDC`);

  step(`${label}: enclave settles through a trusted request`);
  const settlementId = await waitForSettlement(operator.vela, appId, triggerAddress, close.blockNumber);
  info(`trusted request ${dim(settlementId)} completed`);

  return { order, settlementId, closeBlock: close.blockNumber, submissions };
}

async function main() {
  console.log(bold('\nLegate — live end-to-end run on a local Vela stack, via @legate/sdk\n'));

  const adminWallet = new ethers.Wallet(KEYS.admin, provider);
  // Deploying is not a Legate business command, so admin talks to Vela directly
  // rather than through a LegateClient (which needs an applicationId that does
  // not exist yet at this point).
  const adminVela = new VelaClient(adminWallet, false, TEE_AUTH, PROCESSOR);

  step('Check the stack is reachable');
  const network = await provider.getNetwork();
  info(`chain id ${network.chainId}`);
  for (const [name, addr] of [
    ['ProcessorEndpoint', PROCESSOR],
    ['TeeAuthenticator', TEE_AUTH],
  ]) {
    const code = await provider.getCode(addr);
    check(code !== '0x', `${name} is deployed at ${addr}`);
  }
  const teeKey = await adminVela.getTeePublicKey();
  check(teeKey && teeKey.length > 10, 'the enclave has published its P-521 key');
  const startBlock = await provider.getBlockNumber();

  step('Deploy test tokens, a router and LegateTrigger');
  const weth = await deploy(adminWallet, 'mocks/LegateTestMocks.sol', 'TestToken', 'Wrapped Ether', 'WETH');
  const usdc = await deploy(adminWallet, 'mocks/LegateTestMocks.sol', 'TestToken', 'USD Coin', 'USDC');
  const router = await deploy(adminWallet, 'mocks/LegateTestMocks.sol', 'TestRouter', REF_PRICE);
  const trigger = await deploy(adminWallet, 'LegateTrigger.sol', 'LegateTrigger', PROCESSOR, await router.getAddress());
  const WETH = (await weth.getAddress()).toLowerCase();
  const USDC = (await usdc.getAddress()).toLowerCase();
  const TRIGGER = await trigger.getAddress();
  info(`WETH ${WETH}`);
  info(`USDC ${USDC}`);
  info(`LegateTrigger ${TRIGGER}`);

  step('Allowlist the tokens on the endpoint');
  const allowlistAddr = await adminVela.processorEndpoint.tokenAllowlist();
  const allowlist = new ethers.Contract(
    allowlistAddr,
    ['function addAllowedToken(address)', 'function isAllowedToken(address) view returns (bool)'],
    adminWallet,
  );
  for (const t of [WETH, USDC]) {
    await (await allowlist.addAllowedToken(t)).wait();
  }
  check((await allowlist.isAllowedToken(WETH)) && (await allowlist.isAllowedToken(USDC)), 'WETH and USDC are allowlisted');

  step('Upload legate_app.wasm to the authority service');
  const wasm = await readFile(wasmPath);
  const sha256 = createHash('sha256').update(wasm).digest();
  const form = new FormData();
  form.append('wasm', new Blob([wasm]), 'legate_app.wasm');
  const upload = await fetch(`${AUTHORITY}/deploy/upload`, { method: 'POST', body: form });
  if (!upload.ok) {
    throw new Error(`upload failed: ${upload.status} ${await upload.text()}`);
  }
  const uploaded = await upload.json();
  check(uploaded.wasmSha256 === sha256.toString('hex'), `artifact stored (${(wasm.length / 1024).toFixed(0)} KB, sha256 matches)`);

  step('Deploy the app, wired to the trigger');
  const deployReceipt = await adminVela.submitDeployRequestWithTriggerAndWaitForRequestId(
    PROTOCOL_VERSION,
    MAX_FEE,
    sha256,
    { triggerContract: TRIGGER, quoteToken: USDC, operator: new ethers.Wallet(KEYS.operator).address, minContributors: 2, minResidual: '0x0' },
    TRIGGER,
  );
  let appId;
  for (const log of deployReceipt.transactionReceipt.logs) {
    try {
      const parsed = adminVela.processorEndpoint.interface.parseLog(log);
      if (parsed?.name === 'DeployRequestSubmitted') appId = parsed.args.applicationId;
    } catch {
      // not an endpoint log
    }
  }
  if (appId === undefined) throw new Error('DeployRequestSubmitted not found');
  const deployBlock = deployReceipt.transactionReceipt.blockNumber;
  const deployed = await poll('the enclave to load the app', async () => {
    const latest = await provider.getBlockNumber();
    return adminVela.getDeployRequestCompletedEvent(appId, undefined, latest, deployBlock);
  });
  if (deployed.status !== 0n) {
    throw new Error(`deploy failed in the enclave (code ${deployed.errorCode}): ${deployed.errorMessage}`);
  }
  check(true, `application ${appId} deployed and running in the enclave`);

  // Every command from here on goes through @legate/sdk. This is the point of
  // the exercise: the SDK's own applicationId, padding, encryption and receipt
  // decryption now stand in for everything runBatch etc. used to build by hand.
  const config = { applicationId: appId, processorEndpoint: PROCESSOR, teeAuthenticator: TEE_AUTH };
  const makeActor = (name, key) => {
    const client = new LegateClient(new ethers.Wallet(key, provider), config);
    client.__name = name; // for this script's own log lines only
    return client;
  };
  const operator = makeActor('operator', KEYS.operator);
  const alphaManager = makeActor('alpha manager', KEYS.alphaManager);
  const betaManager = makeActor('beta manager', KEYS.betaManager);
  const depositor = makeActor('depositor', KEYS.depositor);

  step('Register each participant’s encryption key');
  for (const who of [operator, alphaManager, betaManager, depositor]) {
    const ref = await who.registerKey();
    // ASSOCIATEKEY carries a raw public key, not a padded Legate command.
    track(ref.requestId, { isCommand: false });
    info(`${who.__name} ${dim(await who.address())}`);
  }

  step('Managers register strategies with enclave-enforced mandates');
  const mandate = { allowedTokens: [USDC, WETH], maxOrderBase: 1_000n * E18, maxPositionBase: 10_000n * E18 };
  for (const [who, id] of [[alphaManager, 'alpha'], [betaManager, 'beta']]) {
    const r = await who.registerStrategy(id, mandate);
    track(r.requestId);
  }
  ok('strategies alpha and beta registered');

  step('The enclave refuses a payload that is not padded');
  {
    // Bypasses the SDK's own padPayload deliberately, via the raw Vela client the
    // SDK exposes for exactly this: anything outside what LegateClient covers.
    // Encrypted exactly as a careless client would, without padding.
    const unpaddedCommand = commands.submitIntent({ strategyId: 'alpha', base: WETH, side: Side.Buy, amount: E18, limitPrice: LIMIT_PRICE });
    const ciphertext = await alphaManager.vela.encryptForTee(stringToBytes(JSON.stringify(unpaddedCommand)));
    const submittedReq = await alphaManager.vela.submitRequestAndWaitForRequestId(
      PROTOCOL_VERSION, appId, RequestType.PROCESS, ciphertext, ETH_TOKEN, 0n, MAX_FEE,
    );
    // Deliberately unpadded — excluded from the ciphertext-length check below,
    // which is exactly what makes it stand out as an observer would see it.
    submitted.add(submittedReq.requestId);
    const result = await poll('the unpadded request to be judged', () =>
      alphaManager.vela.getRequestCompletedEvent(submittedReq.requestId, undefined, submittedReq.transactionReceipt.blockNumber));
    check(result.status !== 0n, `a ${ciphertext.length}-byte unpadded intent was rejected`);
    check(/padded/.test(result.errorMessage ?? ''), `rejection reason: "${result.errorMessage}"`);
  }

  step('Depositor funds the pool and privately backs both strategies');
  for (const [strategyId, amount] of [['alpha', 100_000n * E18], ['beta', 50_000n * E18]]) {
    await (await usdc.mint(await depositor.address(), amount)).wait();
    // Deposit and allocation travel in one request. The deposit is public; which
    // strategy it backs is inside the encrypted payload.
    const outcome = await depositor.allocate({ strategyId, amount }, { deposit: { token: USDC, amount } });
    track(outcome.requestId);
    check(outcome.status === 'accepted' && BigInt(outcome.detail.shares) === amount, `${fmt(amount)} USDC deposited ${dim(`(the allocation to ${strategyId} is encrypted)`)}`);
  }

  // Batch 1: two buyers, so the full residual goes to market.
  const batch1 = await runBatch('Batch 1', appId, operator, alphaManager, betaManager, trigger, WETH, [
    { who: alphaManager, strategyId: 'alpha', side: Side.Buy, amount: 10n * E18, limit: LIMIT_PRICE },
    { who: betaManager, strategyId: 'beta', side: Side.Buy, amount: 6n * E18, limit: LIMIT_PRICE },
  ]);
  check(batch1.order.baseAmount === 16n * E18, 'batch 1 public order is the combined 16 WETH');

  const alphaFills1 = await alphaManager.fillsFor({ requestId: batch1.settlementId, blockNumber: batch1.closeBlock });
  const betaFills1 = await betaManager.fillsFor({ requestId: batch1.settlementId, blockNumber: batch1.closeBlock });
  check(totalBase(alphaFills1, 'buy') === 10n * E18, 'alpha privately received 10 WETH');
  check(totalBase(betaFills1, 'buy') === 6n * E18, 'beta privately received 6 WETH');

  step('A rule-breaking intent is refused privately');
  {
    // Beta holds 6 WETH and tries to sell 100. The enclave must refuse, but Vela
    // publishes error strings, so the refusal has to look like a success.
    //
    // Unlike the original hand-rolled version of this script, neither outcome
    // needs a separate decrypt step: submitIntent already returns the sender's
    // own decrypted receipt. accepted came from batch1's own submission above;
    // rejected is read directly off this call.
    const accepted = batch1.submissions.find((s) => s.who === alphaManager);
    const rejected = await betaManager.submitIntent({ strategyId: 'beta', base: WETH, side: Side.Sell, amount: 100n * E18 });
    track(rejected.requestId);

    const acceptedEvents = await publicUserEvents(operator.vela, appId, accepted.requestId, accepted.blockNumber);
    const rejectedEvents = await publicUserEvents(operator.vela, appId, rejected.requestId, rejected.blockNumber);
    const shape = (evs) => evs.map((e) => `${e.subtype}:${e.bytes}`).join(',');

    info(bold('public — the accepted and the rejected intent:'));
    info(`  accepted: fee ${accepted.fee} wei, events ${shape(acceptedEvents)}`);
    info(`  rejected: fee ${rejected.fee} wei, events ${shape(rejectedEvents)}`);

    // submitIntent would have thrown RequestFailedError had this failed publicly,
    // so simply having a rejected.status at all already proves the request
    // completed successfully on chain, with no public error message.
    check(rejected.status === 'rejected', 'the refusal completed as a success, with no public error message');
    check(rejected.fee === accepted.fee, 'it was charged exactly the fee an accepted intent pays');
    check(shape(rejectedEvents) === shape(acceptedEvents), 'its events have the same subtype and encrypted size as an accepted intent’s');

    info(bold('private — decrypted only by each sender:'));
    info(`  alpha: ${accepted.status}`);
    info(`  beta:  ${rejected.status} — "${rejected.reason}"`);
    check(accepted.status === 'accepted', 'alpha privately learns its intent was accepted');
    check(rejected.status === 'rejected' && /insufficient balance/.test(rejected.reason), 'beta privately learns why its intent was refused');
  }

  // Batch 2: opposing flow nets inside the enclave. The refused intent above must
  // not have entered the queue, which the 4 WETH assertion below also proves.
  const batch2 = await runBatch('Batch 2', appId, operator, alphaManager, betaManager, trigger, WETH, [
    { who: alphaManager, strategyId: 'alpha', side: Side.Buy, amount: 10n * E18, limit: LIMIT_PRICE },
    { who: betaManager, strategyId: 'beta', side: Side.Sell, amount: 6n * E18 },
  ]);

  step('What the chain saw versus what actually happened');
  const alphaFills2 = await alphaManager.fillsFor({ requestId: batch2.settlementId, blockNumber: batch2.closeBlock });
  const betaFills2 = await betaManager.fillsFor({ requestId: batch2.settlementId, blockNumber: batch2.closeBlock });
  const alphaBought = totalBase(alphaFills2, 'buy');
  const betaSold = totalBase(betaFills2, 'sell');

  info(bold('public — anyone reading the chain:'));
  info(`  one order: buy ${fmt(batch2.order.baseAmount)} WETH`);
  info(bold('private — decrypted only by each manager:'));
  info(`  alpha bought ${fmt(alphaBought)} WETH`);
  info(`  beta sold    ${fmt(betaSold)} WETH`);

  check(batch2.order.baseAmount === 4n * E18, 'the only order on chain is the netted 4 WETH');
  check(alphaBought === 10n * E18, 'alpha nonetheless received its full 10 WETH');
  check(betaSold === 6n * E18, 'beta nonetheless sold its full 6 WETH');
  const alphaPrice = alphaFills2[0]?.clearingPrice;
  const betaPrice = betaFills2[0]?.clearingPrice;
  check(
    alphaPrice !== undefined && alphaPrice === betaPrice,
    `both sides settled at one clearing price (${fmt(alphaPrice ?? 0n)}), so neither can tell it crossed internally`,
  );

  step('Depositor exits: redeem, withdraw, claim');
  {
    // Alpha now holds 40,000 USDC and 20 WETH, a NAV of 100,000; beta is back to
    // 50,000 USDC. Redemption pays from quote only, so 40,000 of alpha's shares
    // and all 50,000 of beta's can be redeemed.
    //
    // The WETH price is keyed by the checksummed address — the SDK checksums
    // every address it sends — exercising the same normalisation on the real
    // executor the original script's redeem step did.
    const checksummedWETH = ethers.getAddress(WETH);
    const alphaRedeem = await depositor.redeem({ strategyId: 'alpha', shares: 40_000n * E18, prices: { [checksummedWETH]: REF_PRICE } });
    track(alphaRedeem.requestId);
    const betaRedeem = await depositor.redeem({ strategyId: 'beta', shares: 50_000n * E18 });
    track(betaRedeem.requestId);

    check(
      alphaRedeem.status === 'accepted' && BigInt(alphaRedeem.detail.value) === 40_000n * E18,
      `redeemed alpha for ${fmt(BigInt(alphaRedeem.detail.value))} USDC, priced with a checksummed key (private)`,
    );

    // A fresh wallet. Withdrawing here does not unlink it from the depositor: the
    // Withdrawal event is published under the depositor's request, whose sender
    // is public — the SDK's own README says as much.
    const destination = ethers.Wallet.createRandom().address;
    const total = 90_000n * E18;
    const withdrawal = await depositor.withdraw({ token: USDC, amount: total, destination });
    track(withdrawal.requestId);

    const endpoint = depositor.vela.processorEndpoint;
    const latest = await provider.getBlockNumber();
    const [publicWithdrawal] = await endpoint.queryFilter(
      endpoint.filters.Withdrawal(appId, withdrawal.requestId),
      withdrawal.blockNumber,
      latest,
    );
    check(
      publicWithdrawal?.args.to === destination && publicWithdrawal?.args.amount === total,
      `withdrew ${fmt(total)} USDC to a fresh address ${dim(destination)} (public, as any vault exit is)`,
    );

    const claimable = await depositor.pendingClaims(USDC, destination);
    check(claimable === total, `the endpoint holds ${fmt(claimable)} USDC claimable for it`);

    await depositor.claim(USDC, destination);
    const received = await usdc.balanceOf(destination);
    check(received === total, `after claiming, the fresh address holds ${fmt(received)} USDC`);
  }

  step('Every command reached the chain as the same number of bytes');
  {
    // Reads the actual calldata of every submitted transaction — buys and
    // sells, registrations, allocations and batch closes all look alike, not
    // just to us but to the chain itself. This is what step 8's deliberately
    // unpadded intent, excluded here, was refused for pretending it could skip.
    const endpoint = operator.vela.processorEndpoint;
    const sizes = new Map();
    for (const requestId of processRequests) {
      const bytes = await onChainPayloadBytes(endpoint, appId, requestId);
      sizes.set(bytes, (sizes.get(bytes) ?? 0) + 1);
    }
    check(
      sizes.size === 1,
      `all ${processRequests.size} encrypted requests were ${[...sizes.keys()].join('/')} bytes on chain, whatever they said`,
    );
  }

  console.log(green(bold('\nLive run passed: Legate netted real trades on a Vela enclave, through @legate/sdk.\n')));
  info(dim(`blocks ${startBlock}–${await provider.getBlockNumber()}, application ${appId}, ${submitted.size} requests submitted`));
}

main().catch((err) => {
  console.error(`\n\x1b[31m✘ ${err.message}\x1b[0m`);
  if (process.env.DEBUG) console.error(err);
  process.exitCode = 1;
});
