const { expect } = require('chai');
const { ethers } = require('hardhat');
const vectors = require('./fixtures/abi-vectors.json');

const PRICE_SCALE = 10n ** 18n;
const SIDE_BUY = 0;
const SIDE_SELL = 1;

const coder = ethers.AbiCoder.defaultAbiCoder();

const ORDER_TYPES = ['bytes16', 'uint8', 'address', 'address', 'uint256', 'uint256'];
const FILL_TYPES = ['bytes16', 'uint256', 'uint256', 'uint8'];

function encodeOrder({ batchId, side, base, quote, baseAmount, quoteLimit }) {
  return coder.encode(ORDER_TYPES, [batchId, side, base, quote, baseAmount, quoteLimit]);
}

function batchIdFromNonce(n) {
  return ethers.zeroPadValue(ethers.toBeHex(n), 16);
}

// EventData as the ProcessorEndpoint passes it.
function eventData(events, subTypes) {
  return { events, subTypes };
}

describe('LegateTrigger', function () {
  async function deployAll(priceWhole = 3000n) {
    const [deployer] = await ethers.getSigners();

    const Token = await ethers.getContractFactory('TestToken');
    const base = await Token.deploy('Wrapped Ether', 'WETH');
    const quote = await Token.deploy('USD Coin', 'USDC');

    const Allowlist = await ethers.getContractFactory('TestTokenAllowlist');
    const allowlist = await Allowlist.deploy();
    await allowlist.addAllowedToken(await base.getAddress());
    await allowlist.addAllowedToken(await quote.getAddress());

    const Endpoint = await ethers.getContractFactory('TestEndpoint');
    const endpoint = await Endpoint.deploy(await allowlist.getAddress());

    const Router = await ethers.getContractFactory('TestRouter');
    const router = await Router.deploy(priceWhole * PRICE_SCALE);

    const Trigger = await ethers.getContractFactory('LegateTrigger');
    const trigger = await Trigger.deploy(await endpoint.getAddress(), await router.getAddress());

    return { deployer, base, quote, allowlist, endpoint, router, trigger };
  }

  // The order arrives as a plaintext on-chain event encoded by the Go app. If
  // the two implementations of this format ever diverge, the contract would act
  // on numbers the enclave never intended.
  describe('cross-language wire format', function () {
    it('decodes the order vector produced by the Go encoder', async function () {
      const decoded = coder.decode(ORDER_TYPES, vectors.order.encoded);

      expect(decoded[0]).to.equal(vectors.order.batchId);
      expect(Number(decoded[1])).to.equal(vectors.order.side);
      expect(decoded[2].toLowerCase()).to.equal(vectors.order.base.toLowerCase());
      expect(decoded[3].toLowerCase()).to.equal(vectors.order.quote.toLowerCase());
      expect(decoded[4]).to.equal(BigInt(vectors.order.baseAmount));
      expect(decoded[5]).to.equal(BigInt(vectors.order.quoteLimit));
    });

    it('produces fill payloads byte-identical to the Go encoder', async function () {
      const success = coder.encode(FILL_TYPES, [
        vectors.order.batchId,
        BigInt(vectors.fillSuccess.baseFilled),
        BigInt(vectors.fillSuccess.quoteMoved),
        vectors.fillSuccess.outcome,
      ]);
      expect(success).to.equal(vectors.fillSuccess.encoded);

      const failure = coder.encode(FILL_TYPES, [vectors.order.batchId, 0n, 0n, 1]);
      expect(failure).to.equal(vectors.fillFailure.encoded);
    });

    it('agrees with the Go app on the batch order subtype', async function () {
      const { trigger } = await deployAll();
      expect(await trigger.BATCH_ORDER_SUBTYPE()).to.equal(vectors.batchOrderSubtype);
    });
  });

  describe('buying the residual', function () {
    it('buys exactly the residual and reports what it spent', async function () {
      const { base, quote, endpoint, router, trigger } = await deployAll(3000n);

      const baseAmount = 40n;
      const quoteLimit = 40n * 3100n; // the enclave's bound, set from participant limits
      const batchId = batchIdFromNonce(7);

      // The endpoint moves the batch's quote into the trigger before executing.
      await quote.mint(await trigger.getAddress(), quoteLimit);

      const order = encodeOrder({
        batchId,
        side: SIDE_BUY,
        base: await base.getAddress(),
        quote: await quote.getAddress(),
        baseAmount,
        quoteLimit,
      });
      const data = eventData([order], [vectors.batchOrderSubtype]);

      await expect(endpoint.callExecute(await trigger.getAddress(), data))
        .to.emit(trigger, 'BatchOrderExecuted')
        .withArgs(batchId, SIDE_BUY, baseAmount, 40n * 3000n);

      // The trigger now holds the base it bought and the unspent quote.
      expect(await base.balanceOf(await trigger.getAddress())).to.equal(baseAmount);
      expect(await quote.balanceOf(await trigger.getAddress())).to.equal(quoteLimit - 40n * 3000n);

      const payload = await endpoint.callGetTrustProcessPayload.staticCall(
        await trigger.getAddress(),
        data,
        true,
        true,
        [],
        [],
      );

      const [gotBatchId, baseFilled, quoteMoved, outcome] = coder.decode(FILL_TYPES, payload);
      expect(gotBatchId).to.equal(batchId);
      expect(baseFilled).to.equal(baseAmount);
      expect(quoteMoved).to.equal(40n * 3000n);
      expect(Number(outcome)).to.equal(0);

      expect(await router.quoteFor(baseAmount)).to.equal(40n * 3000n);
    });

    // Asking for an exact output is what stops a favourable price handing the
    // pool more base than the batch has owners for.
    it('does not overfill when the price moves in its favour', async function () {
      const { base, quote, endpoint, router, trigger } = await deployAll(3000n);

      await router.setPrice(2000n * PRICE_SCALE); // much better than expected

      const baseAmount = 40n;
      const quoteLimit = 40n * 3100n;
      await quote.mint(await trigger.getAddress(), quoteLimit);

      const order = encodeOrder({
        batchId: batchIdFromNonce(1),
        side: SIDE_BUY,
        base: await base.getAddress(),
        quote: await quote.getAddress(),
        baseAmount,
        quoteLimit,
      });

      await endpoint.callExecute(
        await trigger.getAddress(),
        eventData([order], [vectors.batchOrderSubtype]),
      );

      // Exactly the residual, no more, and the saving stays as unspent quote.
      expect(await base.balanceOf(await trigger.getAddress())).to.equal(baseAmount);
      expect(await quote.balanceOf(await trigger.getAddress())).to.equal(quoteLimit - 40n * 2000n);
    });
  });

  describe('selling the residual', function () {
    it('sells exactly the residual and reports what it received', async function () {
      const { base, quote, endpoint, trigger } = await deployAll(3000n);

      const baseAmount = 60n;
      const minQuoteOut = 60n * 2900n;
      const batchId = batchIdFromNonce(9);

      await base.mint(await trigger.getAddress(), baseAmount);

      const order = encodeOrder({
        batchId,
        side: SIDE_SELL,
        base: await base.getAddress(),
        quote: await quote.getAddress(),
        baseAmount,
        quoteLimit: minQuoteOut,
      });
      const data = eventData([order], [vectors.batchOrderSubtype]);

      await endpoint.callExecute(await trigger.getAddress(), data);

      expect(await base.balanceOf(await trigger.getAddress())).to.equal(0n);
      expect(await quote.balanceOf(await trigger.getAddress())).to.equal(60n * 3000n);

      const payload = await endpoint.callGetTrustProcessPayload.staticCall(
        await trigger.getAddress(),
        data,
        true,
        true,
        [],
        [],
      );
      const [, baseFilled, quoteMoved, outcome] = coder.decode(FILL_TYPES, payload);
      expect(baseFilled).to.equal(baseAmount);
      expect(quoteMoved).to.equal(60n * 3000n);
      expect(Number(outcome)).to.equal(0);
    });
  });

  describe('when the venue cannot fill within the bound', function () {
    it('reverts rather than executing outside the limit', async function () {
      const { base, quote, endpoint, router, trigger } = await deployAll(3000n);

      // The price runs past the ceiling the enclave set.
      await router.setPrice(4000n * PRICE_SCALE);

      const baseAmount = 40n;
      const quoteLimit = 40n * 3100n;
      await quote.mint(await trigger.getAddress(), quoteLimit);

      const order = encodeOrder({
        batchId: batchIdFromNonce(3),
        side: SIDE_BUY,
        base: await base.getAddress(),
        quote: await quote.getAddress(),
        baseAmount,
        quoteLimit,
      });

      await expect(
        endpoint.callExecute(await trigger.getAddress(), eventData([order], [vectors.batchOrderSubtype])),
      ).to.be.reverted;
    });

    // The enclave holds the batch open until it is told what happened, so a
    // failure must still produce a payload or the batch would be stranded.
    it('still reports a failure payload so the batch is never stranded', async function () {
      const { base, quote, endpoint, trigger } = await deployAll(3000n);

      const batchId = batchIdFromNonce(4);
      const order = encodeOrder({
        batchId,
        side: SIDE_BUY,
        base: await base.getAddress(),
        quote: await quote.getAddress(),
        baseAmount: 40n,
        quoteLimit: 40n * 3100n,
      });
      const data = eventData([order], [vectors.batchOrderSubtype]);

      // executeSuccess = false, as the endpoint reports after catching a revert.
      const payload = await endpoint.callGetTrustProcessPayload.staticCall(
        await trigger.getAddress(),
        data,
        false,
        true,
        [],
        [],
      );

      const [gotBatchId, baseFilled, quoteMoved, outcome] = coder.decode(FILL_TYPES, payload);
      expect(gotBatchId).to.equal(batchId);
      expect(baseFilled).to.equal(0n);
      expect(quoteMoved).to.equal(0n);
      expect(Number(outcome)).to.equal(1);
      expect(payload).to.equal(
        coder.encode(FILL_TYPES, [batchId, 0n, 0n, 1]),
        'a failure payload must match what the Go decoder expects',
      );
    });

    it('reports failure when execute never recorded a result for this batch', async function () {
      const { base, quote, endpoint, trigger } = await deployAll();

      const order = encodeOrder({
        batchId: batchIdFromNonce(11),
        side: SIDE_BUY,
        base: await base.getAddress(),
        quote: await quote.getAddress(),
        baseAmount: 40n,
        quoteLimit: 40n * 3100n,
      });

      // executeSuccess is claimed true, but nothing was recorded.
      const payload = await endpoint.callGetTrustProcessPayload.staticCall(
        await trigger.getAddress(),
        eventData([order], [vectors.batchOrderSubtype]),
        true,
        true,
        [],
        [],
      );
      const [, , , outcome] = coder.decode(FILL_TYPES, payload);
      expect(Number(outcome)).to.equal(1);
    });
  });

  describe('loop termination', function () {
    // A TRUSTPROCESS state update carries no AppEvents. Returning empty is what
    // stops the trigger enqueueing another one for ever.
    it('returns an empty payload when there are no app events', async function () {
      const { endpoint, trigger } = await deployAll();

      const payload = await endpoint.callGetTrustProcessPayload.staticCall(
        await trigger.getAddress(),
        eventData([], []),
        true,
        true,
        [],
        [],
      );
      expect(payload).to.equal('0x');
    });

    it('ignores app events belonging to something else', async function () {
      const { base, quote, endpoint, trigger } = await deployAll();

      const order = encodeOrder({
        batchId: batchIdFromNonce(5),
        side: SIDE_BUY,
        base: await base.getAddress(),
        quote: await quote.getAddress(),
        baseAmount: 40n,
        quoteLimit: 40n * 3100n,
      });
      const otherSubtype = ethers.zeroPadBytes(ethers.toUtf8Bytes('something_else'), 32);

      const payload = await endpoint.callGetTrustProcessPayload.staticCall(
        await trigger.getAddress(),
        eventData([order], [otherSubtype]),
        true,
        true,
        [],
        [],
      );
      expect(payload).to.equal('0x');
    });
  });

  describe('access control', function () {
    it('only lets the processor endpoint execute', async function () {
      const { base, quote, trigger, deployer } = await deployAll();

      const order = encodeOrder({
        batchId: batchIdFromNonce(6),
        side: SIDE_BUY,
        base: await base.getAddress(),
        quote: await quote.getAddress(),
        baseAmount: 40n,
        quoteLimit: 40n * 3100n,
      });

      await expect(
        trigger.connect(deployer).execute(eventData([order], [vectors.batchOrderSubtype])),
      ).to.be.revertedWithCustomError(trigger, 'NotProcessorEndpoint');
    });

    it('only lets the processor endpoint sweep funds', async function () {
      const { trigger, deployer } = await deployAll();
      await expect(trigger.connect(deployer).withdraw()).to.be.revertedWithCustomError(
        trigger,
        'NotProcessorEndpoint',
      );
    });

    it('rejects a zero router', async function () {
      const { endpoint } = await deployAll();
      const Trigger = await ethers.getContractFactory('LegateTrigger');
      await expect(
        Trigger.deploy(await endpoint.getAddress(), ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(Trigger, 'ZeroRouter');
    });
  });

  describe('sweeping funds back', function () {
    it('returns everything it holds to the endpoint', async function () {
      const { base, quote, endpoint, trigger } = await deployAll(3000n);

      const quoteLimit = 40n * 3100n;
      await quote.mint(await trigger.getAddress(), quoteLimit);

      const order = encodeOrder({
        batchId: batchIdFromNonce(8),
        side: SIDE_BUY,
        base: await base.getAddress(),
        quote: await quote.getAddress(),
        baseAmount: 40n,
        quoteLimit,
      });
      await endpoint.callExecute(
        await trigger.getAddress(),
        eventData([order], [vectors.batchOrderSubtype]),
      );

      await endpoint.callWithdraw(await trigger.getAddress());

      // Nothing is left behind to contaminate the next batch.
      expect(await base.balanceOf(await trigger.getAddress())).to.equal(0n);
      expect(await quote.balanceOf(await trigger.getAddress())).to.equal(0n);
      expect(await base.balanceOf(await endpoint.getAddress())).to.equal(40n);
      expect(await quote.balanceOf(await endpoint.getAddress())).to.equal(quoteLimit - 40n * 3000n);
    });
  });
});
