// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {WordBreakPools} from "../src/WordBreakPools.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {DeployProxy} from "./lib/DeployProxy.sol";

/// @notice LOCAL-ONLY: deploys mock cUSD + WordBreakPools on Anvil, funds two players, opens
///         round #1. Uses Anvil's default accounts (referee = account[1], matching the Go
///         signer's test key). Do NOT use on a real network.
contract LocalSetup is Script {
    function run() external {
        uint256 deployerPk = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // [0]
        address referee = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // [1]
        address treasury = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65; // [4]
        address owner = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // [0]
        address alice = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // [2]
        address bob = 0x90F79bf6EB2c4f870365E785982E1f101E93b906; // [3]

        vm.startBroadcast(deployerPk);
        MockERC20 token = new MockERC20();
        (WordBreakPools pool,) =
            DeployProxy.deploy(address(token), referee, treasury, 500, 2 days, owner);
        token.mint(alice, 100e18);
        token.mint(bob, 100e18);
        pool.createRound(1, 1e18, uint64(block.timestamp + 1 hours));
        vm.stopBroadcast();

        console.log("TOKEN", address(token));
        console.log("POOL", address(pool));
    }
}
