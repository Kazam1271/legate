// End-to-end run of Legate against a live local Vela stack.
//
// Unlike the unit tests, nothing here is simulated: the WASM app runs in Vela's
// executor, payloads are encrypted to the enclave's key, the trigger contract
// executes against a router on chain, and settlement comes back through a real
// TRUSTPROCESS request.
//
// Two batches are run.
//
//   Batch 1 — both strategies buy. Nothing nets, so the whole flow goes to market
//   and back: withdrawal to the trigger, swap, sweep, trusted settlement.
//
//   Batch 2 — alpha buys 10 WETH while beta sells 6. They net inside the enclave,
//   and the only order that ever appears on chain is the residual 4. That is the
//   privacy claim, observed on a real chain rather than asserted in a test.
//
// Prerequisites:
//   1. The vela-starterkit stack is running (docker compose up).
//   2. npx hardhat compile                        (contract artifacts)
//   3. cd ../vela-app && ./build.sh production_build   (the WASM)
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
import {
  VelaClient,
  RequestType,
  PROTOCOL_VERSION,
  ETH_TOKEN,
  exportPublicKeyToHex,
  hexToBytes,
  stringToBytes,
  bytesToString,
} from '@horizen/vela-common-ts';

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

const ORDER_TYPES = ['bytes16', 'uint8', 'address', 'address', 'uint256', 'uint256'];
const SIDE = { buy: 0, sell: 1 };

// cacheTimeout is disabled deliberately. ethers caches identical RPC responses
// for 250ms by default, and the starter kit's Anvil mines each transaction the
// instant it arrives. A deploy can therefore confirm inside that window, and the
// next transaction's nonce lookup is served the stale cached count — failing with
// "nonce too low" on a chain that is working perfectly.
const provider = new ethers.JsonRpcProvider(RPC, undefined, { pollingInterval: 500, cacheTimeout: -1 });
const coder = ethers.AbiCoder.defaultAbiCoder();

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
// Chain helpers

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

async function awaitResult(client, requestId, fromBlock, label) {
  return poll(label, async () => {
    const latest = await provider.getBlockNumber();
    return client.getRequestCompletedEvent(requestId, latest, fromBlock);
  });
}

async function waitForCompletion(client, requestId, fromBlock, label) {
  const result = await awaitResult(client, requestId, fromBlock, label);
  if (result.status !== 0n) {
    throw new Error(`${label} failed in the enclave (code ${result.errorCode}): ${result.errorMessage}`);
  }
  return result;
}

// Must match app.PaddedPayloadSize. Ciphertext length reveals plaintext length,
// so every command is padded to one size and the enclave rejects any other.
const PADDED_PAYLOAD_SIZE = 1024;

function padPayload(json) {
  const bytes = stringToBytes(json);
  if (bytes.length > PADDED_PAYLOAD_SIZE) {
    throw new Error(`command is ${bytes.length} bytes, over the ${PADDED_PAYLOAD_SIZE}-byte padded size`);
  }
  const padded = new Uint8Array(PADDED_PAYLOAD_SIZE).fill(0x20); // ASCII space
  padded.set(bytes);
  return padded;
}

// Size of every encrypted PROCESS payload that reached the chain.
const cipherSizes = [];

// ---------------------------------------------------------------------------
// Actors

function actor(name, key) {
  const wallet = new ethers.Wallet(key, provider);
  const client = new VelaClient(wallet, false, TEE_AUTH, PROCESSOR);
  return { name, wallet, client, address: wallet.address };
}

const admin = actor('admin', KEYS.admin);
const operator = actor('operator', KEYS.operator);
const alphaManager = actor('alpha manager', KEYS.alphaManager);
const betaManager = actor('beta manager', KEYS.betaManager);
const depositor = actor('depositor', KEYS.depositor);

// Every request we submit, so the trigger's own requests can be told apart.
const submitted = new Set();

async function associateKey(who, appId) {
  const keyPair = await who.client.getSignerKeyPair();
  const publicKey = hexToBytes(await exportPublicKeyToHex(keyPair.publicKey));
  if (publicKey.length !== 133) {
    throw new Error(`unexpected P-521 public key length ${publicKey.length}`);
  }
  const receipt = await who.client.submitRequestAndWaitForRequestId(
    PROTOCOL_VERSION,
    appId,
    RequestType.ASSOCIATEKEY,
    publicKey,
    ETH_TOKEN,
    0n,
    MAX_FEE,
  );
  submitted.add(receipt.requestId);
  await waitForCompletion(
    who.client,
    receipt.requestId,
    receipt.transactionReceipt.blockNumber,
    `${who.name}: associate key`,
  );
}

async function submitProcess(who, appId, instructions, { token = ETH_TOKEN, amount = 0n } = {}) {
  const plaintext = JSON.stringify(instructions);
  const ciphertext = await who.client.encryptForTee(padPayload(plaintext));
  cipherSizes.push(ciphertext.length);

  if (token !== ETH_TOKEN && amount > 0n) {
    await (await who.client.approveToken(token, amount)).wait();
  }

  const receipt = await who.client.submitRequestAndWaitForRequestId(
    PROTOCOL_VERSION,
    appId,
    RequestType.PROCESS,
    ciphertext,
    token,
    amount,
    MAX_FEE,
  );
  submitted.add(receipt.requestId);

  const block = receipt.transactionReceipt.blockNumber;
  const result = await waitForCompletion(who.client, receipt.requestId, block, `${who.name}: ${instructions.command}`);

  return {
    requestId: receipt.requestId,
    block,
    result,
    plaintextBytes: plaintext.length,
    cipherBytes: ciphertext.length,
  };
}

// The public shape of a request's encrypted events: what an observer can see
// without any key.
async function publicUserEvents(appId, requestId, fromBlock) {
  const endpoint = admin.client.processorEndpoint;
  const latest = await provider.getBlockNumber();
  const events = await endpoint.queryFilter(endpoint.filters.UserEvent(appId, requestId), fromBlock, latest);
  return events.map((e) => ({
    subtype: ethers.decodeBytes32String(e.args.eventSubType),
    bytes: ethers.dataLength(e.args.encryptedData),
  }));
}

// The receipt a sender decrypts for one of their requests.
async function decryptReceipt(who, appId, requestId, fromBlock) {
  const latest = await provider.getBlockNumber();
  const [bytes] = await who.client.getCurrentUserEvents(
    latest,
    fromBlock,
    appId,
    requestId,
    ethers.encodeBytes32String('receipt'),
    () => true,
    true,
  );
  if (!bytes) throw new Error(`${who.name} could not decrypt a receipt for ${requestId}`);
  return JSON.parse(bytesToString(bytes));
}

// Finds the TRUSTPROCESS request the trigger enqueued for a batch and waits for
// the enclave to settle it. The endpoint records the trigger as its sender.
async function waitForSettlement(appId, trigger, fromBlock) {
  const endpoint = admin.client.processorEndpoint;
  const requestId = await poll('the trigger to enqueue a trusted settlement', async () => {
    const latest = await provider.getBlockNumber();
    const events = await endpoint.queryFilter(
      endpoint.filters.RequestSubmitted(appId, undefined, trigger),
      fromBlock,
      latest,
    );
    return events.map((e) => e.args.requestId).find((id) => !submitted.has(id));
  });
  submitted.add(requestId);
  await waitForCompletion(admin.client, requestId, fromBlock, 'trusted settlement');
  return requestId;
}

async function publicOrderFor(appId, requestId, fromBlock) {
  const latest = await provider.getBlockNumber();
  const events = await admin.client.getAppEvents(
    latest,
    fromBlock,
    appId,
    requestId,
    ethers.encodeBytes32String('batch_order'),
  );
  if (events.length !== 1) {
    throw new Error(`expected one public batch order, found ${events.length}`);
  }
  const [batchId, side, base, quote, baseAmount, quoteLimit] = coder.decode(ORDER_TYPES, events[0].data);
  return { batchId, side: Number(side), base, quote, baseAmount, quoteLimit };
}

async function privateFills(who, appId, requestId, fromBlock) {
  const latest = await provider.getBlockNumber();
  const decrypted = await who.client.getCurrentUserEvents(
    latest,
    fromBlock,
    appId,
    requestId,
    ethers.encodeBytes32String('fills'),
    () => true,
    false,
  );
  return decrypted.map((bytes) => JSON.parse(bytesToString(bytes)));
}

function totalBase(fillEvents, side) {
  let total = 0n;
  for (const event of fillEvents) {
    for (const f of event.fills) {
      if (f.side === side) total += BigInt(f.base);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------

async function runBatch(label, appId, trigger, weth, intents) {
  const triggerAddress = await trigger.getAddress();
  step(`${label}: strategies submit encrypted intents`);
  const submissions = [];
  for (const { who, strategyId, side, amount, limit } of intents) {
    const r = await submitProcess(who, appId, {
      command: 'submit_intent',
      intent: {
        strategyId,
        base: weth,
        side: SIDE[side],
        amount: hex(amount),
        limitPrice: hex(limit),
      },
    });
    info(
      `${who.name}: ${side} ${fmt(amount)} WETH on ${strategyId} ` +
        dim(`→ on chain only as ${r.cipherBytes} bytes of ciphertext`),
    );
    submissions.push({ who, ...r });
  }

  step(`${label}: operator closes the batch`);
  const close = await submitProcess(operator, appId, {
    command: 'close_batch',
    closeBatch: { refPrice: hex(REF_PRICE), slippageBps: 0 },
  });
  const order = await publicOrderFor(appId, close.requestId, close.block);
  info(
    `public order: ${order.side === SIDE.buy ? 'buy' : 'sell'} ${fmt(order.baseAmount)} WETH, ` +
      `quote bound ${fmt(order.quoteLimit)}`,
  );

  const endpoint = admin.client.processorEndpoint;
  const executed = await poll('the trigger to execute', async () => {
    const latest = await provider.getBlockNumber();
    const events = await endpoint.queryFilter(
      endpoint.filters.TriggerExecuted(appId, close.requestId),
      close.block,
      latest,
    );
    return events[0];
  });
  check(executed.args.success, 'the trigger executed the order on chain');

  const [swap] = await trigger.queryFilter(trigger.filters.BatchOrderExecuted(order.batchId), close.block);
  check(swap !== undefined, `venue filled ${fmt(swap?.args.baseFilled ?? 0n)} WETH for ${fmt(swap?.args.quoteMoved ?? 0n)} USDC`);

  step(`${label}: enclave settles through a trusted request`);
  const settlementId = await waitForSettlement(appId, triggerAddress, close.block);
  info(`trusted request ${dim(settlementId)} completed`);

  return { order, settlementId, closeBlock: close.block, submissions };
}

async function main() {
  console.log(bold('\nLegate — live end-to-end run on a local Vela stack\n'));

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
  const teeKey = await admin.client.getTeePublicKey();
  check(teeKey && teeKey.length > 10, 'the enclave has published its P-521 key');
  const startBlock = await provider.getBlockNumber();

  step('Deploy test tokens, a router and LegateTrigger');
  const weth = await deploy(admin.wallet, 'mocks/LegateTestMocks.sol', 'TestToken', 'Wrapped Ether', 'WETH');
  const usdc = await deploy(admin.wallet, 'mocks/LegateTestMocks.sol', 'TestToken', 'USD Coin', 'USDC');
  const router = await deploy(admin.wallet, 'mocks/LegateTestMocks.sol', 'TestRouter', REF_PRICE);
  const trigger = await deploy(
    admin.wallet,
    'LegateTrigger.sol',
    'LegateTrigger',
    PROCESSOR,
    await router.getAddress(),
  );
  const WETH = (await weth.getAddress()).toLowerCase();
  const USDC = (await usdc.getAddress()).toLowerCase();
  const TRIGGER = await trigger.getAddress();
  info(`WETH ${WETH}`);
  info(`USDC ${USDC}`);
  info(`LegateTrigger ${TRIGGER}`);

  step('Allowlist the tokens on the endpoint');
  const allowlistAddr = await admin.client.processorEndpoint.tokenAllowlist();
  const allowlist = new ethers.Contract(
    allowlistAddr,
    ['function addAllowedToken(address)', 'function isAllowedToken(address) view returns (bool)'],
    admin.wallet,
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
  const deployReceipt = await admin.client.submitDeployRequestWithTriggerAndWaitForRequestId(
    PROTOCOL_VERSION,
    MAX_FEE,
    sha256,
    {
      triggerContract: TRIGGER,
      quoteToken: USDC,
      operator: operator.address,
      minContributors: 2,
      minResidual: '0x0',
    },
    TRIGGER,
  );
  let appId;
  for (const log of deployReceipt.transactionReceipt.logs) {
    try {
      const parsed = admin.client.processorEndpoint.interface.parseLog(log);
      if (parsed?.name === 'DeployRequestSubmitted') appId = parsed.args.applicationId;
    } catch {
      // not an endpoint log
    }
  }
  if (appId === undefined) throw new Error('DeployRequestSubmitted not found');
  const deployBlock = deployReceipt.transactionReceipt.blockNumber;
  const deployed = await poll('the enclave to load the app', async () => {
    const latest = await provider.getBlockNumber();
    return admin.client.getDeployRequestCompletedEvent(appId, undefined, latest, deployBlock);
  });
  if (deployed.status !== 0n) {
    throw new Error(`deploy failed in the enclave (code ${deployed.errorCode}): ${deployed.errorMessage}`);
  }
  check(true, `application ${appId} deployed and running in the enclave`);

  step('Register each participant’s encryption key');
  for (const who of [operator, alphaManager, betaManager, depositor]) {
    await associateKey(who, appId);
    info(`${who.name} ${dim(who.address)}`);
  }

  step('Managers register strategies with enclave-enforced mandates');
  const mandate = {
    allowedTokens: [USDC, WETH],
    maxOrderBase: hex(1_000n * E18),
    maxPositionBase: hex(10_000n * E18),
  };
  await submitProcess(alphaManager, appId, { command: 'register_strategy', registerStrategy: { id: 'alpha', mandate } });
  await submitProcess(betaManager, appId, { command: 'register_strategy', registerStrategy: { id: 'beta', mandate } });
  ok('strategies alpha and beta registered');

  step('The enclave refuses a payload that is not padded');
  {
    // Encrypted exactly as a careless client would, without padding.
    const unpadded = JSON.stringify({
      command: 'submit_intent',
      intent: { strategyId: 'alpha', base: WETH, side: SIDE.buy, amount: hex(E18), limitPrice: hex(LIMIT_PRICE) },
    });
    const ciphertext = await alphaManager.client.encryptForTee(stringToBytes(unpadded));
    const receipt = await alphaManager.client.submitRequestAndWaitForRequestId(
      PROTOCOL_VERSION,
      appId,
      RequestType.PROCESS,
      ciphertext,
      ETH_TOKEN,
      0n,
      MAX_FEE,
    );
    submitted.add(receipt.requestId);
    const result = await awaitResult(
      alphaManager.client,
      receipt.requestId,
      receipt.transactionReceipt.blockNumber,
      'the unpadded request to be judged',
    );
    check(result.status !== 0n, `a ${ciphertext.length}-byte unpadded intent was rejected`);
    check(/padded/.test(result.errorMessage ?? ''), `rejection reason: "${result.errorMessage}"`);
  }

  step('Depositor funds the pool and privately backs both strategies');
  for (const [strategyId, amount] of [
    ['alpha', 100_000n * E18],
    ['beta', 50_000n * E18],
  ]) {
    await (await usdc.mint(depositor.address, amount)).wait();
    // Deposit and allocation travel in one request. The deposit is public; which
    // strategy it backs is inside the encrypted payload.
    await submitProcess(
      depositor,
      appId,
      {
        command: 'allocate',
        allocate: { strategyId, amount: hex(amount), prices: {} },
      },
      { token: USDC, amount },
    );
    info(`${fmt(amount)} USDC deposited ${dim(`(the allocation to ${strategyId} is encrypted)`)}`);
  }

  // Batch 1: two buyers, so the full residual goes to market.
  const batch1 = await runBatch('Batch 1', appId, trigger, WETH, [
    { who: alphaManager, strategyId: 'alpha', side: 'buy', amount: 10n * E18, limit: LIMIT_PRICE },
    { who: betaManager, strategyId: 'beta', side: 'buy', amount: 6n * E18, limit: LIMIT_PRICE },
  ]);
  check(batch1.order.baseAmount === 16n * E18, 'batch 1 public order is the combined 16 WETH');

  const alphaFills1 = await privateFills(alphaManager, appId, batch1.settlementId, batch1.closeBlock);
  const betaFills1 = await privateFills(betaManager, appId, batch1.settlementId, batch1.closeBlock);
  check(totalBase(alphaFills1, 'buy') === 10n * E18, 'alpha privately received 10 WETH');
  check(totalBase(betaFills1, 'buy') === 6n * E18, 'beta privately received 6 WETH');

  step('A rule-breaking intent is refused privately');
  {
    // Beta holds 6 WETH and tries to sell 100. The enclave must refuse, but Vela
    // publishes error strings, so the refusal has to look like a success.
    const accepted = batch1.submissions.find((s) => s.who === alphaManager);
    const rejected = await submitProcess(betaManager, appId, {
      command: 'submit_intent',
      intent: { strategyId: 'beta', base: WETH, side: SIDE.sell, amount: hex(100n * E18), limitPrice: hex(0n) },
    });

    const acceptedEvents = await publicUserEvents(appId, accepted.requestId, accepted.block);
    const rejectedEvents = await publicUserEvents(appId, rejected.requestId, rejected.block);
    const shape = (evs) => evs.map((e) => `${e.subtype}:${e.bytes}`).join(',');

    info(bold('public — the accepted and the rejected intent:'));
    info(`  accepted: status ${accepted.result.status}, fee ${accepted.result.applicationFees} wei, events ${shape(acceptedEvents)}`);
    info(`  rejected: status ${rejected.result.status}, fee ${rejected.result.applicationFees} wei, events ${shape(rejectedEvents)}`);

    check(
      rejected.result.status === 0n && rejected.result.errorMessage === undefined,
      'the refusal completed as a success, with no public error message',
    );
    check(
      rejected.result.applicationFees === accepted.result.applicationFees,
      'it was charged exactly the fee an accepted intent pays',
    );
    check(
      shape(rejectedEvents) === shape(acceptedEvents),
      'its events have the same subtype and encrypted size as an accepted intent’s',
    );

    const betaReceipt = await decryptReceipt(betaManager, appId, rejected.requestId, rejected.block);
    const alphaReceipt = await decryptReceipt(alphaManager, appId, accepted.requestId, accepted.block);
    info(bold('private — decrypted only by each sender:'));
    info(`  alpha: ${alphaReceipt.status}`);
    info(`  beta:  ${betaReceipt.status} — "${betaReceipt.reason}"`);
    check(alphaReceipt.status === 'accepted', 'alpha privately learns its intent was accepted');
    check(
      betaReceipt.status === 'rejected' && /insufficient balance/.test(betaReceipt.reason),
      'beta privately learns why its intent was refused',
    );
  }

  // Batch 2: opposing flow nets inside the enclave. The refused intent above must
  // not have entered the queue, which the 4 WETH assertion below also proves.
  const batch2 = await runBatch('Batch 2', appId, trigger, WETH, [
    { who: alphaManager, strategyId: 'alpha', side: 'buy', amount: 10n * E18, limit: LIMIT_PRICE },
    { who: betaManager, strategyId: 'beta', side: 'sell', amount: 6n * E18, limit: 0n },
  ]);

  step('What the chain saw versus what actually happened');
  const alphaFills2 = await privateFills(alphaManager, appId, batch2.settlementId, batch2.closeBlock);
  const betaFills2 = await privateFills(betaManager, appId, batch2.settlementId, batch2.closeBlock);
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
    `both sides settled at one clearing price (${fmt(BigInt(alphaPrice ?? 0))}), so neither can tell it crossed internally`,
  );

  // Buys and sells, registrations, allocations and batch closes all look alike.
  const sizes = new Set(cipherSizes);
  check(
    sizes.size === 1,
    `all ${cipherSizes.length} encrypted requests were ${[...sizes].join('/')} bytes on chain, whatever they said`,
  );

  console.log(green(bold('\nLive run passed: Legate netted real trades on a Vela enclave.\n')));
  info(dim(`blocks ${startBlock}–${await provider.getBlockNumber()}, application ${appId}`));
}

main().catch((err) => {
  console.error(`\n\x1b[31m✘ ${err.message}\x1b[0m`);
  if (process.env.DEBUG) console.error(err);
  process.exitCode = 1;
});
