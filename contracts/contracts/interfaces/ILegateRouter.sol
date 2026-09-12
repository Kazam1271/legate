// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @title ILegateRouter
/// @notice The slice of a Uniswap V2-style router that Legate needs.
///
/// @dev Declared locally rather than pulled from a router package: only two
///      functions are used, and Legate must be able to point at whichever venue
///      exists on Horizen. ZENDEX and DarkSwap are the intended destinations but
///      are not live yet, so the venue is a constructor parameter.
///
///      Both calls are all-or-nothing against their limit. That gives the batch
///      a clean property: the residual either executes within the bound the
///      enclave set, or the swap reverts and every token is swept back.
interface ILegateRouter {
  /// @notice Buys an exact amount of the output token.
  /// @param amountOut Exact quantity of `path[path.length - 1]` to receive.
  /// @param amountInMax Most of `path[0]` that may be spent. Reverts if exceeded.
  /// @return amounts Amounts at each hop; `amounts[0]` is the input actually spent.
  function swapTokensForExactTokens(
    uint256 amountOut,
    uint256 amountInMax,
    address[] calldata path,
    address to,
    uint256 deadline
  ) external returns (uint256[] memory amounts);

  /// @notice Sells an exact amount of the input token.
  /// @param amountIn Exact quantity of `path[0]` to sell.
  /// @param amountOutMin Least of the output token to accept. Reverts if not met.
  /// @return amounts Amounts at each hop; the last is the output actually received.
  function swapExactTokensForTokens(
    uint256 amountIn,
    uint256 amountOutMin,
    address[] calldata path,
    address to,
    uint256 deadline
  ) external returns (uint256[] memory amounts);
}
