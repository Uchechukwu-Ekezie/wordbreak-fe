// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {WordBreakPools} from "../src/WordBreakPools.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract WordBreakPoolsTest is Test {
    WordBreakPools internal pool;
    MockERC20 internal token;

    uint256 internal refereePk = 0xA11CE;
    address internal referee;
    address internal treasury = address(0xBEEF);
    address internal owner = address(this);

    address internal alice = address(0xA1);
    address internal bob = address(0xB0);
    address internal carol = address(0xC0);

    uint128 internal constant ENTRY_FEE = 1e18; // 1 cUSD
    uint96 internal constant RAKE_BPS = 500; // 5%
    uint32 internal constant REFUND_DELAY = 1 days;
    uint256 internal constant ROUND_ID = 20260716; // date-key style
    uint64 internal endTime;

    function setUp() public {
        referee = vm.addr(refereePk);
        token = new MockERC20();
        pool = new WordBreakPools(address(token), referee, treasury, RAKE_BPS, REFUND_DELAY, owner);

        endTime = uint64(block.timestamp + 1 hours);

        for (uint256 i; i < 3; ++i) {
            address p = [alice, bob, carol][i];
            token.mint(p, 100e18);
            vm.prank(p);
            token.approve(address(pool), type(uint256).max);
        }
    }

    // --- helpers ---

    function _createRound() internal {
        pool.createRound(ROUND_ID, ENTRY_FEE, endTime);
    }

    function _enterAll() internal {
        vm.prank(alice);
        pool.enter(ROUND_ID);
        vm.prank(bob);
        pool.enter(ROUND_ID);
        vm.prank(carol);
        pool.enter(ROUND_ID);
    }

    function _sign(uint256 roundId, address[] memory winners, uint256[] memory amounts)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = pool.settlementDigest(roundId, winners, amounts);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(refereePk, digest);
        return abi.encodePacked(r, s, v);
    }

    // --- entry ---

    function test_CreateAndEnter_CollectsPot() public {
        _createRound();
        _enterAll();

        WordBreakPools.Round memory r = pool.getRound(ROUND_ID);
        assertEq(r.pot, 3 * uint256(ENTRY_FEE));
        assertEq(r.entrants, 3);
        assertEq(token.balanceOf(address(pool)), 3 * uint256(ENTRY_FEE));
        assertTrue(pool.hasEntered(ROUND_ID, alice));
    }

    function test_Enter_RevertsOnDoubleEntry() public {
        _createRound();
        vm.prank(alice);
        pool.enter(ROUND_ID);
        vm.prank(alice);
        vm.expectRevert(WordBreakPools.AlreadyEntered.selector);
        pool.enter(ROUND_ID);
    }

    function test_Enter_RevertsAfterEntryCloses() public {
        _createRound();
        vm.warp(endTime);
        vm.prank(alice);
        vm.expectRevert(WordBreakPools.EntryClosed.selector);
        pool.enter(ROUND_ID);
    }

    function test_Enter_RevertsOnUnknownRound() public {
        vm.prank(alice);
        vm.expectRevert(WordBreakPools.RoundNotFound.selector);
        pool.enter(9999);
    }

    // --- settlement ---

    function test_Settle_PaysWinnersAndTreasury() public {
        _createRound();
        _enterAll();
        vm.warp(endTime);

        uint256 pot = 3 * uint256(ENTRY_FEE);
        uint256 rake = (pot * RAKE_BPS) / 10_000; // 0.15e18
        uint256 toWinners = pot - rake; // 2.85e18

        address[] memory winners = new address[](2);
        winners[0] = alice;
        winners[1] = bob;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 2e18;
        amounts[1] = toWinners - 2e18; // 0.85e18

        bytes memory sig = _sign(ROUND_ID, winners, amounts);
        pool.settle(ROUND_ID, winners, amounts, sig);

        assertEq(pool.claimable(alice), amounts[0]);
        assertEq(pool.claimable(bob), amounts[1]);
        assertEq(pool.claimable(treasury), rake);

        // winner withdraws
        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        pool.claim();
        assertEq(token.balanceOf(alice) - before, amounts[0]);
        assertEq(pool.claimable(alice), 0);

        // treasury withdraws rake
        vm.prank(treasury);
        pool.claim();
        assertEq(token.balanceOf(treasury), rake);
    }

    function test_Settle_RevertsOnBadSignature() public {
        _createRound();
        _enterAll();
        vm.warp(endTime);

        address[] memory winners = new address[](1);
        winners[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1e18;

        // sign with a different key
        bytes32 digest = pool.settlementDigest(ROUND_ID, winners, amounts);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(WordBreakPools.BadSignature.selector);
        pool.settle(ROUND_ID, winners, amounts, sig);
    }

    function test_Settle_RevertsIfPayoutExceedsPot() public {
        _createRound();
        _enterAll();
        vm.warp(endTime);

        address[] memory winners = new address[](1);
        winners[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 3e18; // > pot - rake

        bytes memory sig = _sign(ROUND_ID, winners, amounts);
        vm.expectRevert(WordBreakPools.PayoutExceedsPot.selector);
        pool.settle(ROUND_ID, winners, amounts, sig);
    }

    function test_Settle_RevertsBeforeEntryCloses() public {
        _createRound();
        _enterAll();

        address[] memory winners = new address[](1);
        winners[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1e18;

        bytes memory sig = _sign(ROUND_ID, winners, amounts);
        vm.expectRevert(WordBreakPools.EntryStillOpen.selector);
        pool.settle(ROUND_ID, winners, amounts, sig);
    }

    function test_Settle_RevertsOnDoubleSettle() public {
        _createRound();
        _enterAll();
        vm.warp(endTime);

        address[] memory winners = new address[](1);
        winners[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 2e18;

        bytes memory sig = _sign(ROUND_ID, winners, amounts);
        pool.settle(ROUND_ID, winners, amounts, sig);

        vm.expectRevert(WordBreakPools.RoundClosed.selector);
        pool.settle(ROUND_ID, winners, amounts, sig);
    }

    // --- refunds (anti-rug) ---

    function test_Refund_AfterCancel() public {
        _createRound();
        _enterAll();

        pool.cancelRound(ROUND_ID);

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        pool.claimRefund(ROUND_ID);
        assertEq(token.balanceOf(alice) - before, ENTRY_FEE);

        // no double refund
        vm.prank(alice);
        vm.expectRevert(WordBreakPools.AlreadyRefunded.selector);
        pool.claimRefund(ROUND_ID);
    }

    function test_Refund_AfterGraceWhenUnsettled() public {
        _createRound();
        _enterAll();

        // referee never settles; warp past endTime + refundDelay
        vm.warp(uint256(endTime) + REFUND_DELAY + 1);

        uint256 before = token.balanceOf(bob);
        vm.prank(bob);
        pool.claimRefund(ROUND_ID);
        assertEq(token.balanceOf(bob) - before, ENTRY_FEE);
    }

    function test_Refund_NotAvailableWhileLive() public {
        _createRound();
        _enterAll();

        vm.prank(alice);
        vm.expectRevert(WordBreakPools.RefundNotAvailable.selector);
        pool.claimRefund(ROUND_ID);
    }

    function test_Refund_NotAvailableAfterSettle() public {
        _createRound();
        _enterAll();
        vm.warp(endTime);

        address[] memory winners = new address[](1);
        winners[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 2e18;
        bytes memory sig = _sign(ROUND_ID, winners, amounts);
        pool.settle(ROUND_ID, winners, amounts, sig);

        vm.warp(uint256(endTime) + REFUND_DELAY + 1);
        vm.prank(bob); // a loser trying to refund after settlement
        vm.expectRevert(WordBreakPools.RefundNotAvailable.selector);
        pool.claimRefund(ROUND_ID);
    }

    function test_Settle_RevertsAfterGracePeriod() public {
        _createRound();
        _enterAll();
        // referee is late — past the refund grace, settlement must be locked out
        vm.warp(uint256(endTime) + REFUND_DELAY + 1);

        address[] memory winners = new address[](1);
        winners[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 2e18;

        bytes memory sig = _sign(ROUND_ID, winners, amounts);
        vm.expectRevert(WordBreakPools.TooLateToSettle.selector);
        pool.settle(ROUND_ID, winners, amounts, sig);
    }

    function test_Settle_SucceedsAtGraceBoundary() public {
        _createRound();
        _enterAll();
        // exactly at endTime + refundDelay is still the referee's window (refund is `>`)
        vm.warp(uint256(endTime) + REFUND_DELAY);

        address[] memory winners = new address[](1);
        winners[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 2e18;

        bytes memory sig = _sign(ROUND_ID, winners, amounts);
        pool.settle(ROUND_ID, winners, amounts, sig);
        assertEq(pool.claimable(alice), 2e18);

        // and refund is NOT available at this instant (windows are mutually exclusive)
        vm.prank(bob);
        vm.expectRevert(WordBreakPools.RefundNotAvailable.selector);
        pool.claimRefund(ROUND_ID);
    }

    // --- EIP-712 encoding: independent digest reconstruction ---
    // The `_sign` helper signs whatever `pool.settlementDigest` returns, so it can't catch an
    // encoding bug. This rebuilds the digest from raw EIP-712 fields — explicitly padding each
    // array element to 32 bytes and hand-building the domain separator — and asserts it matches
    // the contract. If they agree, a standard viem/ethers `signTypedData` (same spec) produces
    // the same digest, so backend-signed results are guaranteed acceptable.
    function test_SettlementDigest_MatchesEip712Spec() public view {
        address[] memory winners = new address[](2);
        winners[0] = alice;
        winners[1] = bob;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 2e18;
        amounts[1] = 0.85e18;

        bytes32 fromContract = pool.settlementDigest(ROUND_ID, winners, amounts);
        bytes32 spec = _specDigest(ROUND_ID, winners, amounts);
        assertEq(fromContract, spec, "digest diverges from EIP-712 spec");
    }

    /// @dev Logs the canonical digest so the Go referee signer can cross-check byte-for-byte.
    ///      Run: forge test --match-test test_LogCanonicalDigest -vv
    function test_LogCanonicalDigest() public {
        // Deploy at a FIXED address + chainId so the Go test can reproduce the domain exactly.
        vm.chainId(42220);
        WordBreakPools fixedPool = new WordBreakPools{salt: bytes32(uint256(1))}(
            address(token), referee, treasury, RAKE_BPS, REFUND_DELAY, owner
        );

        address[] memory winners = new address[](2);
        winners[0] = 0x00000000000000000000000000000000000000A1;
        winners[1] = 0x00000000000000000000000000000000000000B0;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 2 ether;
        amounts[1] = 0.85 ether;

        bytes32 digest = fixedPool.settlementDigest(20260716, winners, amounts);
        console.log("XCHECK_POOL", address(fixedPool));
        console.log("XCHECK_CHAINID", block.chainid);
        console.log("XCHECK_DIGEST");
        console.logBytes32(digest);
    }

    function _specDigest(uint256 roundId, address[] memory winners, uint256[] memory amounts)
        internal
        view
        returns (bytes32)
    {
        // Per EIP-712, a dynamic array hashes as keccak256 of its elements each encoded to
        // 32 bytes and concatenated — built here without the abi.encodePacked shortcut.
        bytes memory wEnc;
        for (uint256 i; i < winners.length; ++i) {
            wEnc = bytes.concat(wEnc, bytes32(uint256(uint160(winners[i]))));
        }
        bytes memory aEnc;
        for (uint256 i; i < amounts.length; ++i) {
            aEnc = bytes.concat(aEnc, bytes32(amounts[i]));
        }

        bytes32 typeHash =
            keccak256("Settlement(uint256 roundId,address[] winners,uint256[] amounts)");
        bytes32 structHash =
            keccak256(abi.encode(typeHash, roundId, keccak256(wEnc), keccak256(aEnc)));

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("WordBreakPools")),
                keccak256(bytes("1")),
                block.chainid,
                address(pool)
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }

    // --- per-round economics are frozen at creation ---

    function test_Economics_RakeFrozenAtCreation() public {
        _createRound(); // rake snapshotted at 5%
        _enterAll(); // pot = 3e18

        // owner cranks the global rake to the 10% cap AFTER players paid in
        pool.setRakeBps(1000);

        vm.warp(endTime);
        uint256 pot = 3 * uint256(ENTRY_FEE);
        uint256 rakeAt5 = (pot * RAKE_BPS) / 10_000; // 0.15e18

        // A payout sized to the *original* 5% rake must still be valid. If the round had
        // picked up the new 10% rake, maxToWinners would be lower and this would revert.
        address[] memory winners = new address[](1);
        winners[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = pot - rakeAt5; // 2.85e18

        bytes memory sig = _sign(ROUND_ID, winners, amounts);
        pool.settle(ROUND_ID, winners, amounts, sig);

        assertEq(pool.claimable(alice), pot - rakeAt5);
        assertEq(pool.claimable(treasury), rakeAt5); // 5%, not 10%
    }

    function test_Economics_RefundDelayFrozenAtCreation() public {
        _createRound(); // refundDelay snapshotted at 1 day
        _enterAll();

        // owner extends the global refund delay AFTER players paid in
        pool.setRefundDelay(10 days);

        // Past the round's ORIGINAL 1-day grace, refunds must be open — the later global
        // change must not trap entrants for 10 days.
        vm.warp(uint256(endTime) + REFUND_DELAY + 1);

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        pool.claimRefund(ROUND_ID);
        assertEq(token.balanceOf(alice) - before, ENTRY_FEE);
    }

    // --- access control ---

    function test_CreateRound_OnlyOperator() public {
        vm.prank(alice);
        vm.expectRevert(WordBreakPools.NotOperator.selector);
        pool.createRound(ROUND_ID, ENTRY_FEE, endTime);
    }

    function test_CreateRound_RefereeCanCreate() public {
        vm.prank(referee);
        pool.createRound(ROUND_ID, ENTRY_FEE, endTime);
        assertTrue(pool.roundExists(ROUND_ID));
    }

    function test_SetRake_RevertsAboveCap() public {
        vm.expectRevert(WordBreakPools.RakeTooHigh.selector);
        pool.setRakeBps(1001);
    }

    function test_SetReferee_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.setReferee(address(0x1234));
    }
}
