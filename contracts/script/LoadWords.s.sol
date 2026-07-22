// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {WordBreakArena} from "../src/WordBreakArena.sol";

/// @notice One-off ops script: batch-loads a newline-delimited word list into an already
///         deployed WordBreakArena's on-chain dictionary. Caller must be that arena's owner.
///         Env: PRIVATE_KEY, ARENA (deployed address), WORDLIST (path to a file with one
///         UPPERCASE word per line, no trailing newline), BATCH_SIZE (default 200).
contract LoadWords is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address arenaAddr = vm.envAddress("ARENA");
        string memory path = vm.envString("WORDLIST");
        uint256 batchSize = vm.envOr("BATCH_SIZE", uint256(200));

        WordBreakArena arena = WordBreakArena(arenaAddr);

        string memory content = vm.readFile(path);
        string[] memory words = vm.split(content, "\n");
        uint256 n = words.length;
        console.log("total words:", n);

        vm.startBroadcast(pk);
        uint256 i;
        while (i < n) {
            uint256 end = i + batchSize;
            if (end > n) end = n;
            bytes32[] memory hashes = new bytes32[](end - i);
            for (uint256 j = i; j < end; ++j) {
                hashes[j - i] = keccak256(bytes(words[j]));
            }
            arena.loadWords(hashes);
            console.log("loaded batch", i, end);
            i = end;
        }
        vm.stopBroadcast();
    }
}
