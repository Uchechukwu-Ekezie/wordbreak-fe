// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {WordBreakPools} from "../src/WordBreakPools.sol";

/// @notice Deploys ONLY a new WordBreakPools implementation — no proxy, no `initialize()`.
///         For upgrading an already-live proxy via `upgradeToAndCall`, which only the proxy's
///         current OWNER can run, from their own key, separately from this script. Deploying
///         bare bytecode needs no special privilege — any funded account can do it; only the
///         owner can ever point the live proxy at the result.
///         Env: PRIVATE_KEY, TOKEN (defaults to mainnet cUSD if unset).
contract DeployImplementationOnly is Script {
    address constant CUSD_MAINNET = 0x765DE816845861e75A25fCA122bb6898B8B1282a;

    function run() external returns (address implementation) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address token = vm.envOr("TOKEN", CUSD_MAINNET);

        vm.startBroadcast(pk);
        WordBreakPools impl = new WordBreakPools(token);
        vm.stopBroadcast();

        implementation = address(impl);
        console.log("NEW IMPLEMENTATION:", implementation);
        console.log("token:            ", token);
        console.log("version:          ", impl.version());
    }
}
