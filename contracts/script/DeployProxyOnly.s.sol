// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {WordBreakPools} from "../src/WordBreakPools.sol";

/// @notice Recovery script: deploys ONLY the ERC1967Proxy against an already-deployed
///         implementation (skips redeploying the implementation). Env:
///   PRIVATE_KEY, IMPLEMENTATION, REFEREE, TREASURY, RAKE_BPS, REFUND_DELAY, OWNER
contract DeployProxyOnly is Script {
    function run() external returns (address proxy) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address implementation = vm.envAddress("IMPLEMENTATION");
        address referee = vm.envAddress("REFEREE");
        address treasury = vm.envAddress("TREASURY");
        uint96 rakeBps = uint96(vm.envOr("RAKE_BPS", uint256(500)));
        uint32 refundDelay = uint32(vm.envOr("REFUND_DELAY", uint256(2 days)));
        address owner = vm.envAddress("OWNER");

        bytes memory initData = abi.encodeCall(
            WordBreakPools.initialize, (referee, treasury, rakeBps, refundDelay, owner)
        );

        vm.startBroadcast(pk);
        ERC1967Proxy p = new ERC1967Proxy(implementation, initData);
        vm.stopBroadcast();

        proxy = address(p);
        console.log("PROXY (USE THIS ADDRESS):", proxy);
        console.log("implementation:", implementation);
    }
}
