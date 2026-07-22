// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {WordBreakPools} from "../src/WordBreakPools.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {DeployProxy} from "./lib/DeployProxy.sol";

/// @notice TESTNET verification for recordScore: deploys a fresh pool + mock cUSD, opens a
///         round, has the deployer enter and play twice (two different scores, proving the
///         history is append-only, not overwrite-only), and records both scores on-chain with
///         real referee signatures. Mirrors TestnetSetup.s.sol's env convention.
///         Env (contracts/.env.testnet): PRIVATE_KEY, REFEREE_PRIVATE_KEY, REFEREE, ROUND_ID,
///         RAKE_BPS, ENTRY_FEE, ROUND_SECONDS.
contract RecordScoreRoundTrip is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        uint256 refereePk = vm.envUint("REFEREE_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address referee = vm.addr(refereePk);
        require(referee == vm.envAddress("REFEREE"), "REFEREE_PRIVATE_KEY doesn't match REFEREE");

        address treasury = vm.envOr("TREASURY", deployer);
        uint96 rakeBps = uint96(vm.envOr("RAKE_BPS", uint256(500)));
        uint32 refundDelay = uint32(vm.envOr("REFUND_DELAY", uint256(2 days)));
        uint128 entryFee = uint128(vm.envOr("ENTRY_FEE", uint256(0.1 ether)));
        uint256 roundId = vm.envUint("ROUND_ID");
        uint64 endTime = uint64(block.timestamp + vm.envOr("ROUND_SECONDS", uint256(1 days)));

        vm.startBroadcast(pk);
        MockERC20 token = new MockERC20();
        token.mint(deployer, 10 ether);
        (WordBreakPools pool,) =
            DeployProxy.deploy(address(token), referee, treasury, rakeBps, refundDelay, deployer);
        pool.createRound(roundId, entryFee, endTime);

        token.approve(address(pool), entryFee);
        pool.enter(roundId);
        vm.stopBroadcast();

        console.log("POOL     ", address(pool));
        console.log("TOKEN    ", address(token));
        console.log("ROUND_ID ", roundId);
        console.log("PLAYER   ", deployer);

        // Attempt 0: a weak first play.
        _recordScore(pool, refereePk, roundId, deployer, 10, 0);
        // Attempt 1: a much better second play, same day -- proves history, not overwrite.
        _recordScore(pool, refereePk, roundId, deployer, 42, 1);

        uint256[] memory scores = pool.getScores(roundId, deployer);
        console.log("SCORE_COUNT", pool.scoreCount(roundId, deployer));
        for (uint256 i; i < scores.length; ++i) {
            console.log("  attempt", i, "score", scores[i]);
        }
    }

    function _recordScore(
        WordBreakPools pool,
        uint256 refereePk,
        uint256 roundId,
        address player,
        uint256 score,
        uint256 attempt
    ) internal {
        bytes32 digest = pool.scoreDigest(roundId, player, score, attempt);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(refereePk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        pool.recordScore(roundId, player, score, attempt, sig);
        vm.stopBroadcast();

        console.log("recorded attempt", attempt, "score", score);
    }
}
