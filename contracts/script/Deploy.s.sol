// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {WordBreakPools} from "../src/WordBreakPools.sol";
import {DeployProxy} from "./lib/DeployProxy.sol";

/// @notice Deploys WordBreakPools behind a UUPS proxy. Configure via env vars:
///   TOKEN       - stablecoin address (cUSD). Defaults per chain if unset.
///   REFEREE     - backend signer address (required)
///   TREASURY    - rake recipient (required)
///   RAKE_BPS    - house rake in basis points (default 500 = 5%)
///   REFUND_DELAY- seconds after entry close before refunds open (default 172800 = 2 days)
///   OWNER       - contract owner (defaults to the deployer)
///
/// Verified cUSD (USDm) addresses baked in as fallbacks:
///   Celo Mainnet (42220):     0x765DE816845861e75A25fCA122bb6898B8B1282a
///   Celo Sepolia (11142220):  0xEF4d55D6dE8e8d73232827Cd1e9b2F2dBb45bC80
contract Deploy is Script {
    address constant CUSD_MAINNET = 0x765DE816845861e75A25fCA122bb6898B8B1282a;
    address constant CUSD_SEPOLIA = 0xEF4d55D6dE8e8d73232827Cd1e9b2F2dBb45bC80;

    function run() external returns (WordBreakPools pool) {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        address token = vm.envOr("TOKEN", _defaultCusd());
        address referee = vm.envAddress("REFEREE");
        address treasury = vm.envAddress("TREASURY");
        uint96 rakeBps = uint96(vm.envOr("RAKE_BPS", uint256(500)));
        uint32 refundDelay = uint32(vm.envOr("REFUND_DELAY", uint256(2 days)));
        address owner = vm.envOr("OWNER", deployer);

        require(token != address(0), "TOKEN unset and no default for this chain");

        vm.startBroadcast(deployerPk);
        address implementation;
        (pool, implementation) =
            DeployProxy.deploy(token, referee, treasury, rakeBps, refundDelay, owner);
        vm.stopBroadcast();

        console.log("WordBreakPools (proxy - USE THIS ADDRESS):", address(pool));
        console.log("  implementation:", implementation);
        console.log("  token:   ", token);
        console.log("  referee: ", referee);
        console.log("  treasury:", treasury);
        console.log("  rakeBps: ", rakeBps);
        console.log("  owner:   ", owner);
    }

    function _defaultCusd() internal view returns (address) {
        if (block.chainid == 42220) return CUSD_MAINNET;
        if (block.chainid == 11142220) return CUSD_SEPOLIA;
        return address(0);
    }
}
