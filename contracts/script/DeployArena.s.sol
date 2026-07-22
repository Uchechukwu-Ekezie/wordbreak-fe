// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {WordBreakArena} from "../src/WordBreakArena.sol";

/// @notice Deploys WordBreakArena directly (no proxy — this contract is not upgradeable).
///         Configure via env vars:
///   TOKEN       - entry token address. Defaults to CELO ERC-20 if unset.
///   TREASURY    - rake recipient (required)
///   RAKE_BPS    - house rake in basis points (default 500 = 5%)
///   OWNER       - contract owner, can load words / update treasury+rake (defaults to deployer)
///
/// Known token addresses:
///   CELO ERC-20  All Celo networks: 0x471EcE3750Da237f93B8E339c536989b8978a438
///   cUSD (USDm)  Mainnet  (42220):  0x765DE816845861e75A25fCA122bb6898B8B1282a
///   cUSD         Sepolia (11142220): 0xEF4d55D6dE8e8d73232827Cd1e9b2F2dBb45bC80
contract DeployArena is Script {
    // CELO ERC-20 is the same address on all Celo networks (token duality — same as native CELO)
    address constant CELO_ERC20 = 0x471EcE3750Da237f93B8E339c536989b8978a438;

    function run() external returns (WordBreakArena arena) {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        address token    = vm.envOr("TOKEN", CELO_ERC20);
        address treasury = vm.envAddress("TREASURY");
        uint96  rakeBps  = uint96(vm.envOr("RAKE_BPS", uint256(500)));
        address owner    = vm.envOr("OWNER", deployer);

        require(token != address(0), "TOKEN unset and no default for this chain");

        vm.startBroadcast(deployerPk);
        arena = new WordBreakArena(token, owner, treasury, rakeBps);
        vm.stopBroadcast();

        console.log("WordBreakArena:", address(arena));
        console.log("  token:   ", token);
        console.log("  treasury:", treasury);
        console.log("  rakeBps: ", rakeBps);
        console.log("  owner:   ", owner);
    }
}
