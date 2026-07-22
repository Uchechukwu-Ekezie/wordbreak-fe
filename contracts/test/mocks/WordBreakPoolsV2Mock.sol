// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {WordBreakPools} from "../../src/WordBreakPools.sol";

/// @dev Test-only stand-in for "a future version of WordBreakPools." Proves the upgrade path
///      actually works: new storage appends safely after V1's layout (including its reserved
///      `__gap`), a new function becomes callable, and all of V1's existing state (rounds,
///      balances) survives the upgrade untouched. Never deployed for real — lives only in tests.
contract WordBreakPoolsV2Mock is WordBreakPools {
    /// @dev Appended after all V1 storage (including `__gap`) — safe by construction, since
    ///      Solidity lays out inherited storage in linearized order and `__gap` was reserved
    ///      exactly so upgrades have room to grow without colliding with anything above it.
    uint256 public newFeature;

    constructor(address token_) WordBreakPools(token_) {}

    function setNewFeature(uint256 v) external {
        newFeature = v;
    }

    function version() external pure override returns (string memory) {
        return "2.0.0";
    }
}
