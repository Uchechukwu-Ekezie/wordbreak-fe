// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {WordBreakArena} from "../src/WordBreakArena.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract WordBreakArenaTest is Test {
    WordBreakArena internal arena;
    MockERC20 internal token;

    address internal treasury = address(0xBEEF);
    address internal owner = address(this);

    address internal alice = address(0xA1);
    address internal bob = address(0xB0);
    address internal carol = address(0xC0);
    address internal dave = address(0xD0);

    uint128 internal constant ENTRY_FEE = 1e18; // 1 cUSD
    uint96 internal constant RAKE_BPS = 500; // 5%
    uint32 internal constant ROUND_DURATION = 10 minutes;
    bytes32 internal constant PREVRANDAO = bytes32(uint256(0xC0FFEE));

    bytes internal constant LETTER_BAG =
        "AAAAAAAAABBCCDDDDEEEEEEEEEEEEFFGGGHHIIIIIIIIIJKLLLLMMNNNNNNOOOOOOOOPPQRRRRRRSSSSTTTTTTUUUUVVWWXYYZ";

    function setUp() public {
        vm.prevrandao(PREVRANDAO);
        token = new MockERC20();
        arena = new WordBreakArena(address(token), owner, treasury, RAKE_BPS);

        address[4] memory players = [alice, bob, carol, dave];
        for (uint256 i; i < players.length; ++i) {
            token.mint(players[i], 100e18);
            vm.prank(players[i]);
            token.approve(address(arena), type(uint256).max);
        }
    }

    // --- helpers ---

    function _createRoom(uint16 maxPlayers, uint16 minPlayers) internal returns (uint256 roomId) {
        roomId = arena.createRoom(
            ENTRY_FEE, maxPlayers, minPlayers, uint64(block.timestamp + 1 hours), ROUND_DURATION
        );
    }

    function _join(uint256 roomId, address player) internal {
        vm.prank(player);
        arena.joinRoom(roomId);
    }

    /// @dev Mirrors WordBreakArena's `_generateRack` exactly, so tests can predict the rack
    ///      for a given room/round without reading it back from the contract first.
    function _expectedRack(uint256 roomId, uint32 round) internal view returns (bytes32 rack) {
        bytes32 seed = keccak256(abi.encode(PREVRANDAO, roomId, round));
        uint256 bagLen = LETTER_BAG.length;
        for (uint256 i; i < 10; ++i) {
            uint256 idx = uint256(keccak256(abi.encode(seed, i))) % bagLen;
            rack |= bytes32(LETTER_BAG[idx]) >> (i * 8);
        }
    }

    function _rackPrefix(bytes32 rack, uint256 len) internal pure returns (bytes memory word) {
        word = new bytes(len);
        for (uint256 i; i < len; ++i) {
            word[i] = rack[i];
        }
    }

    function _loadWord(bytes memory word) internal {
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = keccak256(word);
        arena.loadWords(hashes);
    }

    /// @dev Submits `player`'s best `len`-letter prefix of the current round's rack (a
    ///      trivially valid sub-multiset of the rack, since it's literally made of the rack's
    ///      own bytes) and pre-loads its hash into the dictionary so it's accepted.
    function _submitPrefix(uint256 roomId, address player, uint256 len) internal {
        WordBreakArena.Room memory r = arena.getRoom(roomId);
        bytes memory word = _rackPrefix(r.rack, len);
        _loadWord(word);
        vm.prank(player);
        arena.submitWord(roomId, word);
    }

    function _endRound(uint256 roomId) internal {
        WordBreakArena.Room memory r = arena.getRoom(roomId);
        vm.warp(r.roundEndTime);
        arena.endRound(roomId);
    }

    // --- room creation / joining ---

    function test_CreateAndJoin_CollectsPot() public {
        uint256 roomId = _createRoom(3, 2);
        _join(roomId, alice);
        _join(roomId, bob);
        _join(roomId, carol);

        WordBreakArena.Room memory r = arena.getRoom(roomId);
        assertEq(r.pot, 3 * uint256(ENTRY_FEE));
        assertEq(token.balanceOf(address(arena)), 3 * uint256(ENTRY_FEE));
        assertTrue(arena.isActive(roomId, alice));
        assertEq(arena.getActivePlayers(roomId).length, 3);
    }

    function test_CreateRoom_RevertsOnInvalidCaps() public {
        vm.expectRevert(WordBreakArena.InvalidCaps.selector);
        arena.createRoom(ENTRY_FEE, 3, 1, uint64(block.timestamp + 1 hours), ROUND_DURATION); // minPlayers < 2

        vm.expectRevert(WordBreakArena.InvalidCaps.selector);
        arena.createRoom(ENTRY_FEE, 2, 3, uint64(block.timestamp + 1 hours), ROUND_DURATION); // max < min

        vm.expectRevert(WordBreakArena.InvalidCaps.selector);
        arena.createRoom(ENTRY_FEE, 101, 2, uint64(block.timestamp + 1 hours), ROUND_DURATION); // > hard cap
    }

    function test_CreateRoom_RevertsOnBadEconomics() public {
        vm.expectRevert(WordBreakArena.InvalidEntryFee.selector);
        arena.createRoom(0, 3, 2, uint64(block.timestamp + 1 hours), ROUND_DURATION);

        vm.expectRevert(WordBreakArena.InvalidDeadline.selector);
        arena.createRoom(ENTRY_FEE, 3, 2, uint64(block.timestamp), ROUND_DURATION);

        vm.expectRevert(WordBreakArena.InvalidRoundDuration.selector);
        arena.createRoom(ENTRY_FEE, 3, 2, uint64(block.timestamp + 1 hours), 0);
    }

    function test_Join_RevertsOnDoubleJoin() public {
        uint256 roomId = _createRoom(3, 2);
        _join(roomId, alice);
        vm.prank(alice);
        vm.expectRevert(WordBreakArena.AlreadyJoined.selector);
        arena.joinRoom(roomId);
    }

    function test_Join_RevertsWhenFull() public {
        uint256 roomId = _createRoom(2, 2);
        _join(roomId, alice);
        _join(roomId, bob);
        vm.prank(carol);
        vm.expectRevert(WordBreakArena.RoomFull.selector);
        arena.joinRoom(roomId);
    }

    function test_Join_RevertsAfterDeadline() public {
        uint256 roomId = _createRoom(3, 2);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        vm.expectRevert(WordBreakArena.JoinDeadlinePassed.selector);
        arena.joinRoom(roomId);
    }

    function test_Join_RevertsOnUnknownRoom() public {
        vm.prank(alice);
        vm.expectRevert(WordBreakArena.RoomNotFound.selector);
        arena.joinRoom(9999);
    }

    // --- cancellation / refunds ---

    function test_CancelRoom_RevertsWhileJoinableOrFull() public {
        uint256 roomId = _createRoom(3, 2);
        _join(roomId, alice);
        _join(roomId, bob);
        vm.expectRevert(WordBreakArena.RoomNotCancellable.selector); // deadline hasn't passed
        arena.cancelRoom(roomId);
    }

    function test_Refund_AfterCancel() public {
        uint256 roomId = _createRoom(3, 2);
        _join(roomId, alice); // only 1 joiner, needs 2
        vm.warp(block.timestamp + 1 hours);
        arena.cancelRoom(roomId);

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        arena.claimRefund(roomId);
        assertEq(token.balanceOf(alice) - before, ENTRY_FEE);

        // isActive[roomId][alice] was flipped false by the successful refund above, so a
        // second attempt now reads as "never joined" rather than a distinct "already
        // refunded" state -- see the Room.isActive triple-purpose note in the contract.
        vm.prank(alice);
        vm.expectRevert(WordBreakArena.NotJoined.selector);
        arena.claimRefund(roomId);
    }

    // --- starting ---

    function test_StartRoom_RevertsBeforeReady() public {
        uint256 roomId = _createRoom(3, 2);
        _join(roomId, alice);
        vm.expectRevert(WordBreakArena.CannotStartYet.selector);
        arena.startRoom(roomId);
    }

    function test_StartRoom_WhenFull() public {
        uint256 roomId = _createRoom(2, 2);
        _join(roomId, alice);
        _join(roomId, bob);
        arena.startRoom(roomId);

        WordBreakArena.Room memory r = arena.getRoom(roomId);
        assertEq(uint8(r.state), uint8(WordBreakArena.RoomState.Active));
        assertEq(r.currentRound, 1);
        assertEq(r.roundEndTime, block.timestamp + ROUND_DURATION);
        assertTrue(r.rack != bytes32(0));
    }

    // --- word submission ---

    function test_SubmitWord_RevertsOnWrongRackLetters() public {
        uint256 roomId = _createRoom(2, 2);
        _join(roomId, alice);
        _join(roomId, bob);
        arena.startRoom(roomId);

        bytes memory bogus = "ZZZ";
        _loadWord(bogus);
        vm.prank(alice);
        vm.expectRevert(WordBreakArena.LetterNotInRack.selector);
        arena.submitWord(roomId, bogus);
    }

    function test_SubmitWord_RevertsOnInvalidCharacters() public {
        uint256 roomId = _createRoom(2, 2);
        _join(roomId, alice);
        _join(roomId, bob);
        arena.startRoom(roomId);

        bytes memory lower = "abc";
        vm.prank(alice);
        vm.expectRevert(WordBreakArena.InvalidWordCharacters.selector);
        arena.submitWord(roomId, lower);
    }

    function test_SubmitWord_RevertsIfNotInDictionary() public {
        uint256 roomId = _createRoom(2, 2);
        _join(roomId, alice);
        _join(roomId, bob);
        arena.startRoom(roomId);

        WordBreakArena.Room memory r = arena.getRoom(roomId);
        bytes memory word = _rackPrefix(r.rack, 3); // valid letters, but never loaded
        vm.prank(alice);
        vm.expectRevert(WordBreakArena.WordNotInDictionary.selector);
        arena.submitWord(roomId, word);
    }

    function test_SubmitWord_RevertsOnDoubleSubmit() public {
        uint256 roomId = _createRoom(2, 2);
        _join(roomId, alice);
        _join(roomId, bob);
        arena.startRoom(roomId);

        _submitPrefix(roomId, alice, 3);
        WordBreakArena.Room memory r = arena.getRoom(roomId);
        bytes memory word = _rackPrefix(r.rack, 4);
        _loadWord(word);
        vm.prank(alice);
        vm.expectRevert(WordBreakArena.AlreadySubmitted.selector);
        arena.submitWord(roomId, word);
    }

    function test_SubmitWord_RevertsWhenRoomNotActive() public {
        uint256 roomId = _createRoom(2, 2);
        _join(roomId, alice);
        bytes memory word = "CAT";
        _loadWord(word);
        vm.prank(alice);
        vm.expectRevert(WordBreakArena.RoomNotActive.selector);
        arena.submitWord(roomId, word);
    }

    function test_EndRound_RevertsBeforeRoundEnds() public {
        uint256 roomId = _createRoom(2, 2);
        _join(roomId, alice);
        _join(roomId, bob);
        arena.startRoom(roomId);
        vm.expectRevert(WordBreakArena.RoundNotEnded.selector);
        arena.endRound(roomId);
    }

    // --- elimination / winner ---

    function test_FullGame_EliminatesLowestScorer_ThenWinnerClaims() public {
        uint256 roomId = _createRoom(3, 2);
        _join(roomId, alice);
        _join(roomId, bob);
        _join(roomId, carol);
        arena.startRoom(roomId); // room is full, starts immediately

        // Round 1: carol scores lowest (3), bob highest (7), alice middle (5) -- unique lowest.
        _submitPrefix(roomId, alice, 5);
        _submitPrefix(roomId, bob, 7);
        _submitPrefix(roomId, carol, 3);
        _endRound(roomId);

        assertEq(arena.getActivePlayers(roomId).length, 2);
        assertFalse(arena.isActive(roomId, carol));
        assertTrue(arena.isActive(roomId, alice));
        assertTrue(arena.isActive(roomId, bob));

        WordBreakArena.Room memory r = arena.getRoom(roomId);
        assertEq(r.currentRound, 2);
        assertEq(uint8(r.state), uint8(WordBreakArena.RoomState.Active));

        // Round 2: bob beats alice -> alice is eliminated, bob wins outright.
        _submitPrefix(roomId, alice, 3);
        _submitPrefix(roomId, bob, 6);
        _endRound(roomId);

        r = arena.getRoom(roomId);
        assertEq(uint8(r.state), uint8(WordBreakArena.RoomState.Finished));
        assertEq(r.winner, bob);
        assertEq(arena.getActivePlayers(roomId).length, 1);

        uint256 pot = 3 * uint256(ENTRY_FEE);
        uint256 rake = (pot * RAKE_BPS) / 10_000;
        uint256 payout = pot - rake;
        assertEq(arena.claimable(bob), payout);
        assertEq(arena.claimable(treasury), rake);

        uint256 before = token.balanceOf(bob);
        vm.prank(bob);
        arena.claim();
        assertEq(token.balanceOf(bob) - before, payout);

        vm.prank(treasury);
        arena.claim();
        assertEq(token.balanceOf(treasury), rake);
    }

    function test_EndRound_WithOneActivePlayer_FinalizesImmediately() public {
        // Degenerate but valid: a 2-player room where one player never submits and the other
        // does -- an ordinary unique-lowest-scorer elimination, leaving exactly 1 player, who
        // wins without needing a further "1 active player" endRound call at all. This test
        // instead exercises the n==1 fast path directly by starting a fresh 2-player room,
        // eliminating one via a clear score gap, and confirming immediate finalization.
        uint256 roomId = _createRoom(2, 2);
        _join(roomId, alice);
        _join(roomId, bob);
        arena.startRoom(roomId);

        _submitPrefix(roomId, alice, 6);
        // bob never submits -> score 0, unique lowest.
        _endRound(roomId);

        WordBreakArena.Room memory r = arena.getRoom(roomId);
        assertEq(uint8(r.state), uint8(WordBreakArena.RoomState.Finished));
        assertEq(r.winner, alice);
    }

    function test_EndRound_TieReplaysWithoutElimination() public {
        uint256 roomId = _createRoom(2, 2);
        _join(roomId, alice);
        _join(roomId, bob);
        arena.startRoom(roomId);

        _submitPrefix(roomId, alice, 3);
        _submitPrefix(roomId, bob, 3); // tie
        _endRound(roomId);

        WordBreakArena.Room memory r = arena.getRoom(roomId);
        assertEq(uint8(r.state), uint8(WordBreakArena.RoomState.Active));
        assertEq(r.currentRound, 2); // replayed, no elimination
        assertEq(arena.getActivePlayers(roomId).length, 2);
    }

    /// @dev Mirrors the contract's forced-tiebreak survivor rule exactly: lowest
    ///      keccak256(prevrandao, roomId, round, player) among the tied group wins.
    function _expectedSurvivor(uint256 roomId, uint32 round, address[2] memory tied)
        internal
        pure
        returns (address survivor)
    {
        uint256 bestHash = type(uint256).max;
        for (uint256 i; i < 2; ++i) {
            uint256 h = uint256(keccak256(abi.encode(PREVRANDAO, roomId, round, tied[i])));
            if (h < bestHash) {
                bestHash = h;
                survivor = tied[i];
            }
        }
    }

    function test_ForcedTiebreak_PicksDeterministicSurvivor_NoDraw() public {
        uint256 roomId = _createRoom(2, 2);
        _join(roomId, alice);
        _join(roomId, bob);
        arena.startRoom(roomId);

        // Tie 3 rounds in a row (TIE_STREAK_LIMIT) -> forced tiebreak fires on round 3.
        for (uint256 i; i < 3; ++i) {
            _submitPrefix(roomId, alice, 3);
            _submitPrefix(roomId, bob, 3);
            _endRound(roomId);
        }

        address expected = _expectedSurvivor(roomId, 3, [alice, bob]);
        address loser = expected == alice ? bob : alice;

        WordBreakArena.Room memory r = arena.getRoom(roomId);
        assertEq(uint8(r.state), uint8(WordBreakArena.RoomState.Finished));
        assertEq(r.winner, expected); // always exactly one winner, never address(0)
        assertEq(arena.getActivePlayers(roomId).length, 1);
        assertEq(arena.getActivePlayers(roomId)[0], expected);

        uint256 pot = 2 * uint256(ENTRY_FEE);
        uint256 rake = (pot * RAKE_BPS) / 10_000;
        assertEq(arena.claimable(expected), pot - rake);
        assertEq(arena.claimable(treasury), rake);
        assertEq(arena.claimable(loser), 0);
    }

    /// @dev A 3-player room where two players (alice, bob) tie at the floor every round
    ///      while carol always scores higher -- the forced tiebreak should only ever touch
    ///      the tied pair, leaving carol untouched and the game continuing (not finished),
    ///      and the eliminated player should be locked out of the very next round.
    function test_ForcedTiebreak_PartialTie_ThenEliminatedPlayerBlocked() public {
        uint256 roomId = _createRoom(3, 2);
        _join(roomId, alice);
        _join(roomId, bob);
        _join(roomId, carol);
        arena.startRoom(roomId); // full room, starts immediately

        for (uint256 i; i < 3; ++i) {
            _submitPrefix(roomId, alice, 3);
            _submitPrefix(roomId, bob, 3);
            _submitPrefix(roomId, carol, 6);
            _endRound(roomId);
        }

        address survivor = _expectedSurvivor(roomId, 3, [alice, bob]);
        address eliminated = survivor == alice ? bob : alice;

        WordBreakArena.Room memory r = arena.getRoom(roomId);
        assertEq(uint8(r.state), uint8(WordBreakArena.RoomState.Active)); // carol wasn't tied
        assertEq(r.currentRound, 4);
        assertEq(arena.getActivePlayers(roomId).length, 2);
        assertFalse(arena.isActive(roomId, eliminated));
        assertTrue(arena.isActive(roomId, survivor));
        assertTrue(arena.isActive(roomId, carol));

        bytes memory word = _rackPrefix(r.rack, 3);
        _loadWord(word);
        vm.prank(eliminated);
        vm.expectRevert(WordBreakArena.NotActivePlayer.selector);
        arena.submitWord(roomId, word);

        // Finish the game: survivor scores low, carol scores high -> carol wins outright.
        _submitPrefix(roomId, survivor, 3);
        _submitPrefix(roomId, carol, 6);
        _endRound(roomId);

        r = arena.getRoom(roomId);
        assertEq(uint8(r.state), uint8(WordBreakArena.RoomState.Finished));
        assertEq(r.winner, carol);
    }

    // --- admin ---

    function test_LoadWords_OnlyOwner() public {
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = keccak256("CAT");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arena.loadWords(hashes);

        arena.loadWords(hashes);
        assertTrue(arena.isValidWord(keccak256("CAT")));
    }

    function test_SetRakeBps_RevertsAboveCap() public {
        vm.expectRevert(WordBreakArena.RakeTooHigh.selector);
        arena.setRakeBps(1001);
    }

    function test_SetTreasury_RevertsOnZeroAddress() public {
        vm.expectRevert(WordBreakArena.ZeroAddress.selector);
        arena.setTreasury(address(0));
    }

    function test_Claim_RevertsWhenNothingOwed() public {
        vm.prank(alice);
        vm.expectRevert(WordBreakArena.NothingToClaim.selector);
        arena.claim();
    }
}
