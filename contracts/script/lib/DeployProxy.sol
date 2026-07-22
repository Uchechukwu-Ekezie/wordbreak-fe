// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {WordBreakPools} from "../../src/WordBreakPools.sol";

/// @notice Shared helper for deploying WordBreakPools behind a UUPS (ERC1967) proxy —
///         used by both the deploy scripts and the test suite so there's exactly one place
///         that encodes "how the implementation gets wired up," instead of drifting copies.
///
/// The address callers should use everywhere (frontend, backend, other scripts) is the
/// PROXY address returned here, never the implementation address — the implementation on
/// its own is deliberately uninitializable (see the contract's constructor).
library DeployProxy {
    function deploy(
        address token,
        address referee,
        address treasury,
        uint96 rakeBps,
        uint32 refundDelay,
        address owner
    ) internal returns (WordBreakPools pool, address implementation) {
        implementation = address(new WordBreakPools(token));
        bytes memory initData = abi.encodeCall(
            WordBreakPools.initialize, (referee, treasury, rakeBps, refundDelay, owner)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(implementation, initData);
        pool = WordBreakPools(address(proxy));
    }
}
