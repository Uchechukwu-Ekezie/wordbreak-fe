// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {WordBreakPools} from "../src/WordBreakPools.sol";

/// @notice Opens a daily round on-chain. The operator runs this, then tells the backend the
///         same roundId + endTime via POST /api/admin/daily/open so paid submissions are gated.
///
/// Env:
///   PRIVATE_KEY  - operator key (must be owner or referee on the pool)
///   POOLS        - deployed WordBreakPools address
///   ROUND_ID     - e.g. 20260716 (a YYYYMMDD date key)
///   ENTRY_FEE    - entry fee in token base units (cUSD = 18 dp; 0.1 cUSD = 100000000000000000)
///   END_TIME     - unix seconds when entry closes
contract CreateRound is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        WordBreakPools pool = WordBreakPools(vm.envAddress("POOLS"));
        uint256 roundId = vm.envUint("ROUND_ID");
        uint128 entryFee = uint128(vm.envUint("ENTRY_FEE"));
        uint64 endTime = uint64(vm.envUint("END_TIME"));

        vm.startBroadcast(pk);
        pool.createRound(roundId, entryFee, endTime);
        vm.stopBroadcast();

        console.log("Round created");
        console.log("  roundId: ", roundId);
        console.log("  entryFee:", entryFee);
        console.log("  endTime: ", endTime);
        console.log("Next: POST /api/admin/daily/open with this roundId + endTime.");
    }
}
