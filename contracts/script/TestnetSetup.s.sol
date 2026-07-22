// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {WordBreakPools} from "../src/WordBreakPools.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {DeployProxy} from "./lib/DeployProxy.sol";

/// @notice TESTNET (Celo Sepolia): deploys a mintable mock cUSD + WordBreakPools and opens a
///         round in one shot. Uses a mock token so test players can be funded freely (real
///         testnet cUSD is hard to source). Env comes from contracts/.env.testnet:
///           PRIVATE_KEY, REFEREE, ROUND_ID, RAKE_BPS, ENTRY_FEE, ROUND_SECONDS
contract TestnetSetup is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address referee = vm.envAddress("REFEREE");
        address treasury = vm.envOr("TREASURY", deployer);
        uint96 rakeBps = uint96(vm.envOr("RAKE_BPS", uint256(500)));
        uint32 refundDelay = uint32(vm.envOr("REFUND_DELAY", uint256(2 days)));
        uint128 entryFee = uint128(vm.envOr("ENTRY_FEE", uint256(0.1 ether)));
        uint256 roundId = vm.envUint("ROUND_ID");
        uint64 endTime = uint64(block.timestamp + vm.envOr("ROUND_SECONDS", uint256(1 days)));

        vm.startBroadcast(pk);
        MockERC20 token = new MockERC20();
        token.mint(deployer, 1000 ether); // test cUSD to fund players
        (WordBreakPools pool,) =
            DeployProxy.deploy(address(token), referee, treasury, rakeBps, refundDelay, deployer);
        pool.createRound(roundId, entryFee, endTime);
        vm.stopBroadcast();

        console.log("CUSD_MOCK ", address(token));
        console.log("POOL      ", address(pool));
        console.log("ROUND_ID  ", roundId);
        console.log("END_TIME  ", endTime);
        console.log("Next: POST /api/admin/daily/open {roundId, endTime}, set web env, play.");
    }
}
