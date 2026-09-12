// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {AbstractTrigger} from 'vela/contracts/trigger/AbstractTrigger.sol';
import {IProcessorEndpoint} from 'vela/contracts/interfaces/IProcessorEndpoint.sol';
import {Structs} from 'vela/contracts/Structs.sol';

import {ILegateRouter} from './interfaces/ILegateRouter.sol';

/// @title LegateTrigger
/// @notice Executes the single netted order a Legate batch produces, and reports
///         the fill back into the enclave.
///
/// @dev The enclave decides *what* to trade but cannot touch a venue itself. This
///      contract is the arm that reaches out: the ProcessorEndpoint moves the
///      batch's funds in, `_execute` performs one swap from this contract's own
///      address, the base class sweeps everything back, and
///      `_getTrustProcessPayload` hands the result to the WASM app's
///      `trusted_request`.
///
///      Nothing here knows about strategies. It sees one pooled order, which is
///      the whole point: the order is a plaintext on-chain event, so anything it
///      revealed would be public.
///
/// Wire formats, which must stay in lockstep with `vela-app/app/abi.go`:
///
///   AppEvent.data (in):   (bytes16 batchId, uint8 side, address base,
///                          address quote, uint256 baseAmount, uint256 quoteLimit)
///   Trusted payload (out): (bytes16 batchId, uint256 baseFilled,
///                          uint256 quoteMoved, uint8 outcome)
///                          outcome: 0 = success, 1 = failure
contract LegateTrigger is AbstractTrigger {
  using SafeERC20 for IERC20;

  /// @notice Order sides, matching `Side` in the WASM app.
  uint8 internal constant SIDE_BUY = 0;
  uint8 internal constant SIDE_SELL = 1;

  /// @notice Subtype of the AppEvent carrying a batch order. Must match
  ///         `subtypeBatchOrder` in the WASM app, which packs the ASCII label
  ///         left-aligned into a bytes32.
  bytes32 public constant BATCH_ORDER_SUBTYPE = bytes32(bytes('batch_order'));

  /// @notice Venue the netted order is executed against.
  ILegateRouter public immutable router;

  /// @notice Emitted when a batch order executes. The order is already public,
  ///         so this reveals nothing further.
  event BatchOrderExecuted(
    bytes16 indexed batchId,
    uint8 side,
    uint256 baseFilled,
    uint256 quoteMoved
  );

  /// @notice Emitted when a batch order could not be executed.
  event BatchOrderFailed(bytes16 indexed batchId);

  error ZeroRouter();
  error UnexpectedSide(uint8 side);

  /// @dev Result of the swap performed in `_execute`, read back by
  ///      `_getTrustProcessPayload` later in the same transaction.
  ///
  ///      The two hooks are separate calls, so the result has to survive between
  ///      them. It never needs to survive the transaction: a reverting `_execute`
  ///      is rolled back by the endpoint's try/catch, leaving nothing recorded,
  ///      and the batch id is checked on read so a stale record from an earlier
  ///      batch can never be mistaken for this one. Transient storage would suit
  ///      this exactly and is a worthwhile optimisation once the toolchain is
  ///      pinned above 0.8.28.
  struct PendingResult {
    bytes16 batchId;
    bool recorded;
    uint256 baseFilled;
    uint256 quoteMoved;
  }

  PendingResult private _pending;

  /// @param _processorEndpoint ProcessorEndpoint that drives this trigger.
  /// @param _router Venue used to execute netted orders.
  constructor(
    IProcessorEndpoint _processorEndpoint,
    ILegateRouter _router
  ) AbstractTrigger(_processorEndpoint) {
    if (address(_router) == address(0)) {
      revert ZeroRouter();
    }
    router = _router;
  }

  /// @notice Executes the batch's netted order against the venue.
  ///
  /// @dev Reverting here is a safe outcome, not a failure to avoid: the endpoint
  ///      catches it, the base class sweeps every token back, and the enclave is
  ///      told the leg failed. It then settles the internally crossed volume
  ///      anyway and leaves only the residual unfilled. So a breached price bound
  ///      costs the batch its residual, never its funds.
  function _execute(Structs.EventData calldata appEventData) internal override {
    if (!_isBatchOrder(appEventData)) {
      // A TRUSTPROCESS stateUpdate carries no AppEvents and must not re-enter.
      return;
    }

    (
      bytes16 batchId,
      uint8 side,
      address base,
      address quote,
      uint256 baseAmount,
      uint256 quoteLimit
    ) = _decodeOrder(appEventData.events[0]);

    uint256 baseFilled;
    uint256 quoteMoved;

    if (side == SIDE_BUY) {
      // Buy exactly the residual, spending no more than the limit. Asking for an
      // exact output is what stops a favourable price handing the pool more base
      // than the batch has owners for.
      quoteMoved = _swapForExactBase(quote, base, baseAmount, quoteLimit);
      baseFilled = baseAmount;
    } else if (side == SIDE_SELL) {
      // Sell exactly the residual, requiring at least the limit in return.
      quoteMoved = _swapExactBase(base, quote, baseAmount, quoteLimit);
      baseFilled = baseAmount;
    } else {
      revert UnexpectedSide(side);
    }

    _pending = PendingResult({
      batchId: batchId,
      recorded: true,
      baseFilled: baseFilled,
      quoteMoved: quoteMoved
    });

    emit BatchOrderExecuted(batchId, side, baseFilled, quoteMoved);
  }

  /// @notice Reports the fill back to the enclave.
  ///
  /// @dev A payload is returned whenever there was an order, including when the
  ///      swap failed. That is deliberate: the enclave holds the batch open until
  ///      it is told what happened, so staying silent on failure would strand the
  ///      batch and its funds. An outcome of 1 tells it to settle the crossed
  ///      volume and leave the residual unfilled.
  function _getTrustProcessPayload(
    Structs.EventData calldata appEventData,
    bool executeSuccess,
    bool /*withdrawSuccess*/,
    Structs.TokenAndAmount[] calldata /*returnedTokens*/,
    Structs.TokenAndAmount[] calldata /*failedTokens*/
  ) internal override returns (bytes memory) {
    if (!_isBatchOrder(appEventData)) {
      // Returning empty is what terminates the TRUSTPROCESS round trip.
      return '';
    }

    (bytes16 batchId, , , , , ) = _decodeOrder(appEventData.events[0]);

    PendingResult memory result = _pending;
    delete _pending;

    if (!executeSuccess || !result.recorded || result.batchId != batchId) {
      emit BatchOrderFailed(batchId);
      return abi.encode(batchId, uint256(0), uint256(0), uint8(1));
    }

    return abi.encode(batchId, result.baseFilled, result.quoteMoved, uint8(0));
  }

  /// @dev Buys an exact amount of base, spending at most `maxQuoteIn`.
  ///      Returns the quote actually spent.
  function _swapForExactBase(
    address quote,
    address base,
    uint256 baseOut,
    uint256 maxQuoteIn
  ) private returns (uint256) {
    address[] memory path = new address[](2);
    path[0] = quote;
    path[1] = base;

    IERC20(quote).forceApprove(address(router), maxQuoteIn);
    uint256[] memory amounts = router.swapTokensForExactTokens(
      baseOut,
      maxQuoteIn,
      path,
      address(this),
      block.timestamp
    );
    // Routers may leave an allowance behind when they spend less than approved.
    IERC20(quote).forceApprove(address(router), 0);

    return amounts[0];
  }

  /// @dev Sells an exact amount of base, requiring at least `minQuoteOut` back.
  ///      Returns the quote actually received.
  function _swapExactBase(
    address base,
    address quote,
    uint256 baseIn,
    uint256 minQuoteOut
  ) private returns (uint256) {
    address[] memory path = new address[](2);
    path[0] = base;
    path[1] = quote;

    IERC20(base).forceApprove(address(router), baseIn);
    uint256[] memory amounts = router.swapExactTokensForTokens(
      baseIn,
      minQuoteOut,
      path,
      address(this),
      block.timestamp
    );
    IERC20(base).forceApprove(address(router), 0);

    return amounts[amounts.length - 1];
  }

  /// @dev True when this event data carries a batch order this trigger owns.
  function _isBatchOrder(Structs.EventData calldata appEventData) private pure returns (bool) {
    return
      appEventData.events.length != 0 &&
      appEventData.subTypes.length != 0 &&
      appEventData.subTypes[0] == BATCH_ORDER_SUBTYPE;
  }

  /// @dev Decodes the order the WASM app encoded. The layout is entirely static,
  ///      so it is a flat run of six words with no offsets to get wrong.
  function _decodeOrder(
    bytes calldata data
  )
    private
    pure
    returns (
      bytes16 batchId,
      uint8 side,
      address base,
      address quote,
      uint256 baseAmount,
      uint256 quoteLimit
    )
  {
    return abi.decode(data, (bytes16, uint8, address, address, uint256, uint256));
  }
}
