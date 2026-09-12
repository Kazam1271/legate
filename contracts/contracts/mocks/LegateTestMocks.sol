// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

import {ITokenAllowlist} from 'vela/contracts/interfaces/ITokenAllowlist.sol';
import {ITrigger} from 'vela/contracts/interfaces/ITrigger.sol';
import {Structs} from 'vela/contracts/Structs.sol';

import {ILegateRouter} from '../interfaces/ILegateRouter.sol';

/// @notice Minimal ERC-20 for tests.
contract TestToken is ERC20 {
  constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }
}

/// @notice Token allowlist stand-in.
contract TestTokenAllowlist is ITokenAllowlist {
  address[] private _tokens;
  mapping(address => bool) private _allowed;

  function addAllowedToken(address token) external {
    if (!_allowed[token]) {
      _allowed[token] = true;
      _tokens.push(token);
    }
  }

  function removeAllowedToken(address token) external {
    _allowed[token] = false;
  }

  function isAllowedToken(address token) external view returns (bool) {
    return token == address(0) || _allowed[token];
  }

  function getAllowedTokens() external view returns (address[] memory) {
    return _tokens;
  }
}

/// @notice ProcessorEndpoint stand-in that can drive a trigger the way the real
///         endpoint does during stateUpdate.
/// @dev Vela ships a MockTriggerEndpoint, but it only forwards
///      getTrustProcessPayload. Exercising the full round trip also needs an
///      execute forwarder, and a variant that swallows a revert the way the real
///      endpoint's try/catch does.
contract TestEndpoint {
  ITokenAllowlist public tokenAllowlist;

  constructor(ITokenAllowlist _tokenAllowlist) {
    tokenAllowlist = _tokenAllowlist;
  }

  receive() external payable {}

  function callExecute(ITrigger trigger, Structs.EventData calldata appEventData) external {
    trigger.execute(appEventData);
  }

  /// @notice Calls execute and reports whether it reverted, mirroring the real
  ///         endpoint, which isolates each trigger callback in a try/catch so a
  ///         reverting trigger can never block a state update.
  function tryExecute(
    ITrigger trigger,
    Structs.EventData calldata appEventData
  ) external returns (bool success) {
    try trigger.execute(appEventData) {
      return true;
    } catch {
      return false;
    }
  }

  function callWithdraw(
    ITrigger trigger
  ) external returns (Structs.TokenAndAmount[] memory, Structs.TokenAndAmount[] memory) {
    return trigger.withdraw();
  }

  function callGetTrustProcessPayload(
    ITrigger trigger,
    Structs.EventData calldata appEventData,
    bool executeSuccess,
    bool withdrawSuccess,
    Structs.TokenAndAmount[] calldata returnedTokens,
    Structs.TokenAndAmount[] calldata failedTokens
  ) external returns (bytes memory) {
    return
      trigger.getTrustProcessPayload(
        appEventData,
        executeSuccess,
        withdrawSuccess,
        returnedTokens,
        failedTokens
      );
  }
}

/// @notice Router stand-in that trades at a fixed price with no slippage.
/// @dev price is quote units per whole base unit, scaled by PRICE_SCALE.
contract TestRouter is ILegateRouter {
  uint256 public constant PRICE_SCALE = 1e18;

  uint256 public price;
  bool public failNext;

  constructor(uint256 _price) {
    price = _price;
  }

  function setPrice(uint256 _price) external {
    price = _price;
  }

  /// @notice Makes the next swap revert, standing in for a venue that cannot
  ///         fill within the caller's limit.
  function setFailNext(bool _fail) external {
    failNext = _fail;
  }

  function quoteFor(uint256 baseAmount) public view returns (uint256) {
    return (baseAmount * price) / PRICE_SCALE;
  }

  function swapTokensForExactTokens(
    uint256 amountOut,
    uint256 amountInMax,
    address[] calldata path,
    address to,
    uint256
  ) external returns (uint256[] memory amounts) {
    require(!failNext, 'TestRouter: forced failure');

    uint256 amountIn = quoteFor(amountOut);
    require(amountIn <= amountInMax, 'TestRouter: EXCESSIVE_INPUT_AMOUNT');

    IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
    TestToken(path[1]).mint(to, amountOut);

    amounts = new uint256[](2);
    amounts[0] = amountIn;
    amounts[1] = amountOut;
  }

  function swapExactTokensForTokens(
    uint256 amountIn,
    uint256 amountOutMin,
    address[] calldata path,
    address to,
    uint256
  ) external returns (uint256[] memory amounts) {
    require(!failNext, 'TestRouter: forced failure');

    uint256 amountOut = quoteFor(amountIn);
    require(amountOut >= amountOutMin, 'TestRouter: INSUFFICIENT_OUTPUT_AMOUNT');

    IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
    TestToken(path[1]).mint(to, amountOut);

    amounts = new uint256[](2);
    amounts[0] = amountIn;
    amounts[1] = amountOut;
  }
}
