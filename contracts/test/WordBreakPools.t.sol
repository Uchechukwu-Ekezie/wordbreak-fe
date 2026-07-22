// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {WordBreakPools} from "../src/WordBreakPools.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {DeployProxy} from "../script/lib/DeployProxy.sol";
import {WordBreakPoolsV2Mock} from "./mocks/WordBreakPoolsV2Mock.sol";

contract WordBreakPoolsTest is Test {
    WordBreakPools internal pool;
    address internal implementation;
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
        (pool, implementation) =
            DeployProxy.deploy(address(token), referee, treasury, RAKE_BPS, REFUND_DELAY, owner);

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

    function _signScore(uint256 roundId, address player, uint256 score, uint256 attempt)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = pool.scoreDigest(roundId, player, score, attempt);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(refereePk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Signs and records the next score for `player` in `roundId`, using whatever attempt
    ///      index the contract currently expects -- mirrors how the backend would call it after
    ///      every play, without the test needing to track the counter by hand.
    function _recordNextScore(uint256 roundId, address player, uint256 score) internal {
        uint256 attempt = pool.scoreCount(roundId, player);
        pool.recordScore(
            roundId, player, score, attempt, _signScore(roundId, player, score, attempt)
        );
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

    // --- per-player scores (recorded immediately, independent of settlement) ---

    function test_RecordScore_SucceedsAsSoonAsPlayerFinishes() public {
        _createRound();
        _enterAll();
        // Alice finishes well before entry even closes, let alone settlement -- recordScore
        // has no dependency on endTime or on the round being settled.
        _recordNextScore(ROUND_ID, alice, 42);

        assertEq(pool.scoreCount(ROUND_ID, alice), 1);
        assertEq(pool.getScores(ROUND_ID, alice)[0], 42);
        // Recording a score never touches the pot or anyone's claimable balance.
        assertEq(pool.getRound(ROUND_ID).pot, 3 * uint256(ENTRY_FEE));
        assertEq(pool.claimable(alice), 0);
    }

    function test_RecordScore_KeepsEveryAttemptNotJustTheBest() public {
        _createRound();
        _enterAll();

        _recordNextScore(ROUND_ID, alice, 10); // a weak first attempt...
        _recordNextScore(ROUND_ID, alice, 42); // ...then a much better one later the same day

        uint256[] memory scores = pool.getScores(ROUND_ID, alice);
        assertEq(scores.length, 2);
        assertEq(scores[0], 10);
        assertEq(scores[1], 42);
        assertEq(pool.scoreCount(ROUND_ID, alice), 2);
    }

    function test_RecordScore_RevertsIfNeverEntered() public {
        _createRound();
        bytes memory sig = _signScore(ROUND_ID, alice, 10, 0);
        vm.expectRevert(WordBreakPools.NotEntered.selector);
        pool.recordScore(ROUND_ID, alice, 10, 0, sig);
    }

    function test_RecordScore_RevertsOnWrongAttemptIndex() public {
        _createRound();
        _enterAll();
        // attempt 0 hasn't been recorded yet, so attempt 1 is out of order.
        bytes memory sig = _signScore(ROUND_ID, alice, 10, 1);
        vm.expectRevert(WordBreakPools.InvalidAttempt.selector);
        pool.recordScore(ROUND_ID, alice, 10, 1, sig);
    }

    function test_RecordScore_RevertsOnReplayedSignatureAfterNewAttempt() public {
        _createRound();
        _enterAll();
        bytes memory sig0 = _signScore(ROUND_ID, alice, 10, 0);
        pool.recordScore(ROUND_ID, alice, 10, 0, sig0);

        // a fresh attempt has since landed (attempt 1) -- replaying the attempt-0 signature
        // must fail rather than silently re-recording it as attempt 0 again.
        vm.expectRevert(WordBreakPools.InvalidAttempt.selector);
        pool.recordScore(ROUND_ID, alice, 10, 0, sig0);
    }

    function test_RecordScore_RevertsOnBadSignature() public {
        _createRound();
        _enterAll();
        // signed by someone other than the referee
        (, uint256 impostorPk) = makeAddrAndKey("impostor");
        bytes32 digest = pool.scoreDigest(ROUND_ID, alice, 10, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(impostorPk, digest);
        bytes memory badSig = abi.encodePacked(r, s, v);

        vm.expectRevert(WordBreakPools.BadSignature.selector);
        pool.recordScore(ROUND_ID, alice, 10, 0, badSig);
    }

    function test_RecordScore_RevertsOnUnknownRound() public {
        bytes memory sig = _signScore(9999, alice, 10, 0);
        vm.expectRevert(WordBreakPools.RoundNotFound.selector);
        pool.recordScore(9999, alice, 10, 0, sig);
    }

    function test_RecordScore_WorksAfterSettlementToo() public {
        _createRound();
        _enterAll();
        vm.warp(endTime);

        address[] memory winners = new address[](1);
        winners[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 2e18;
        pool.settle(ROUND_ID, winners, amounts, _sign(ROUND_ID, winners, amounts));

        // A late score submission for a different entrant is still just a data record --
        // settlement being done doesn't lock it out.
        _recordNextScore(ROUND_ID, bob, 7);
        assertEq(pool.getScores(ROUND_ID, bob)[0], 7);
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
    /// @dev The digest is bound to `address(this)` (the PROXY, per EIP-712 `verifyingContract`)
    ///      via `_hashTypedDataV4`, so we deploy the proxy itself at a fixed CREATE2 address —
    ///      the implementation's address is irrelevant to the digest.
    function test_LogCanonicalDigest() public {
        // Deploy at a FIXED address + chainId so the Go test can reproduce the domain exactly.
        vm.chainId(42220);
        address impl = address(new WordBreakPools(address(token)));
        bytes memory initData = abi.encodeCall(
            WordBreakPools.initialize, (referee, treasury, RAKE_BPS, REFUND_DELAY, owner)
        );
        ERC1967Proxy proxy = new ERC1967Proxy{salt: bytes32(uint256(1))}(impl, initData);
        WordBreakPools fixedPool = WordBreakPools(address(proxy));

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

    /// @dev Same fixed-address trick as `test_LogCanonicalDigest`, for `scoreDigest`. Logs the
    ///      digest so the Go referee signer's ScoreDigest can be cross-checked byte-for-byte.
    ///      Run: forge test --match-test test_LogCanonicalScoreDigest -vv
    function test_LogCanonicalScoreDigest() public {
        vm.chainId(42220);
        address impl = address(new WordBreakPools(address(token)));
        bytes memory initData = abi.encodeCall(
            WordBreakPools.initialize, (referee, treasury, RAKE_BPS, REFUND_DELAY, owner)
        );
        ERC1967Proxy proxy = new ERC1967Proxy{salt: bytes32(uint256(1))}(impl, initData);
        WordBreakPools fixedPool = WordBreakPools(address(proxy));

        bytes32 digest =
            fixedPool.scoreDigest(20260716, 0x00000000000000000000000000000000000000A1, 42, 0);
        console.log("XCHECK_SCORE_POOL", address(fixedPool));
        console.log("XCHECK_SCORE_CHAINID", block.chainid);
        console.log("XCHECK_SCORE_DIGEST");
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

    // --- upgradeability (UUPS) ---

    function test_Upgrade_CannotInitializeTwice() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        pool.initialize(referee, treasury, RAKE_BPS, REFUND_DELAY, owner);
    }

    function test_Upgrade_ImplementationCannotBeInitializedDirectly() public {
        // The bare implementation (never behind a proxy) had _disableInitializers() run in
        // its constructor — initialize() must revert there too, closing the classic UUPS
        // "anyone calls initialize on the implementation and takes it over" footgun.
        WordBreakPools bareImpl = WordBreakPools(implementation);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bareImpl.initialize(referee, treasury, RAKE_BPS, REFUND_DELAY, owner);
    }

    function test_Upgrade_OnlyOwnerCanAuthorize() public {
        WordBreakPoolsV2Mock v2 = new WordBreakPoolsV2Mock(address(token));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.upgradeToAndCall(address(v2), "");
    }

    /// @dev The actual proof: create a round + collect a real deposit on V1, upgrade to V2,
    ///      then confirm (a) that round's state is byte-identical after the upgrade, (b) the
    ///      pot is still fully claimable through the *unchanged* V1 functions, and (c) the new
    ///      V2-only feature is now live at the same address. This is what "upgradeable" has to
    ///      mean in practice — not just that the call succeeds.
    function test_Upgrade_PreservesStateAndAddsNewFeature() public {
        _createRound();
        vm.prank(alice);
        pool.enter(ROUND_ID);

        WordBreakPools.Round memory before = pool.getRound(ROUND_ID);
        assertEq(before.pot, ENTRY_FEE);
        assertEq(before.entrants, 1);
        assertTrue(pool.hasEntered(ROUND_ID, alice));

        WordBreakPoolsV2Mock v2 = new WordBreakPoolsV2Mock(address(token));
        pool.upgradeToAndCall(address(v2), "");

        // Old state, read through the SAME storage slots, is untouched by the upgrade.
        WordBreakPools.Round memory afterUpgrade = pool.getRound(ROUND_ID);
        assertEq(afterUpgrade.pot, before.pot);
        assertEq(afterUpgrade.entrants, before.entrants);
        assertTrue(pool.hasEntered(ROUND_ID, alice));
        assertEq(pool.owner(), owner);
        assertEq(pool.referee(), referee);

        // The old round can still be settled normally post-upgrade — V1 logic is intact.
        vm.warp(endTime);
        address[] memory winners = new address[](1);
        winners[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = (ENTRY_FEE * (10_000 - RAKE_BPS)) / 10_000;
        bytes memory sig = _sign(ROUND_ID, winners, amounts);
        pool.settle(ROUND_ID, winners, amounts, sig);
        assertEq(pool.claimable(alice), amounts[0]);

        // The new V2-only feature is live, at the SAME proxy address.
        WordBreakPoolsV2Mock poolV2 = WordBreakPoolsV2Mock(address(pool));
        assertEq(poolV2.newFeature(), 0);
        poolV2.setNewFeature(42);
        assertEq(poolV2.newFeature(), 42);
        assertEq(poolV2.version(), "2.0.0");
    }
}
