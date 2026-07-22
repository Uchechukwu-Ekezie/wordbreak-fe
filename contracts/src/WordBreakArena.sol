// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title WordBreakArena
/// @notice Fully on-chain, no-backend "battle royale" word game. Players stake into a room,
///         then eliminate each other round by round until one winner takes the pot.
///
/// Design in one breath:
///  - Anyone can open a room: entry fee, player caps, a join deadline, a per-round timer.
///  - Players pay the entry fee to join (escrowed here, like WordBreakPools).
///  - Once the room fills (or hits its minimum by the join deadline), anyone can start it —
///    the contract itself deals a random letter rack for round 1.
///  - Each round, every still-alive player may submit ONE word built from that round's rack.
///    The word must be composed only of letters the rack actually has, and must be a real
///    word the owner has loaded into the on-chain dictionary.
///  - When the round timer elapses, anyone can call `endRound`: the lowest scorer is
///    eliminated. If there's a tie for lowest, nobody is eliminated — the room just plays
///    another round with a fresh rack until a single lowest scorer emerges.
///  - Unlike WordBreakPools, there is no off-chain referee here at all. Every result is
///    computed and enforced by this contract alone.
///
/// Honesty about tradeoffs this implies:
///  - Rack randomness comes from `block.prevrandao` mixed with the room/round — cheap and
///    backend-free, but a block proposer who is also a player can, in principle, bias which
///    rack they get by choosing whether to include their own transaction in a given block.
///    Acceptable for a casual, low-stakes game; not something to pretend isn't true.
///  - Word *legitimacy* is only as good as the dictionary the owner loads — this contract
///    can't independently verify English, it can only check membership in whatever hash set
///    it was given.
///  - If ties never resolve (apathy, collusion, or just a run of bad racks), a hard cap on
///    consecutive tied rounds forces a deterministic tiebreak: among everyone still sharing
///    the floor, a fixed on-chain rule picks exactly one survivor and eliminates the rest in
///    one shot. The game always narrows to a single winner — never a draw — matching "play
///    rounds until there is a winner." Leans on the same `block.prevrandao` source as rack
///    generation, so it carries the identical honest caveat above.
contract WordBreakArena is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Constants ---

    /// @notice Hard cap on the house rake: 10% (1000 basis points).
    uint96 public constant MAX_RAKE_BPS = 1000;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard cap on players per room — bounds `endRound`'s worst-case scan/elimination
    ///         cost (a full forced-tiebreak wipe), which scales linearly with room size.
    uint16 public constant MAX_PLAYERS_HARD_CAP = 100;

    /// @notice Letters a rack deals out each round.
    uint8 public constant RACK_SIZE = 10;

    /// @notice Shortest word the contract will accept.
    uint8 public constant MIN_WORD_LENGTH = 3;

    /// @notice Consecutive tied (no-elimination) rounds before the forced-tiebreak valve
    ///         fires and wipes everyone still sharing the floor. Deliberately NOT
    ///         owner-adjustable — letting an admin tune elimination fairness would
    ///         reintroduce exactly the trust dependency this contract exists to avoid.
    uint16 internal constant TIE_STREAK_LIMIT = 3;

    /// @dev Classic 100-tile Scrabble letter distribution, so racks aren't all-vowels or
    ///      all-consonants. Embedded in bytecode — no storage cost.
    bytes internal constant LETTER_BAG =
        "AAAAAAAAABBCCDDDDEEEEEEEEEEEEFFGGGHHIIIIIIIIIJKLLLLMMNNNNNNOOOOOOOOPPQRRRRRRSSSSTTTTTTUUUUVVWWXYYZ";

    // --- Types ---

    enum RoomState {
        NonExistent,
        Open,
        Active,
        Cancelled,
        Finished
    }

    struct Room {
        // --- slot 0 (economics/caps frozen at creation) — packs into exactly 32 bytes ---
        uint128 entryFee; // fixed cost to join, in `token` units
        uint64 joinDeadline; // joinRoom() closes after this (unix seconds)
        uint16 maxPlayers; // hard cap on joiners (<= MAX_PLAYERS_HARD_CAP)
        uint16 minPlayers; // must be reached by joinDeadline or the room is cancellable
        uint16 rakeBps; // house rake snapshotted at creation (<= MAX_RAKE_BPS)
        // --- slot 1 (round clock, mutated every round) — packs into exactly 19 bytes ---
        uint32 roundDuration; // seconds per round, frozen at creation
        uint32 currentRound; // 0 before start; 1..N once playing
        uint64 roundEndTime; // submitWord closes / endRound opens after this
        uint16 tiedStreak; // consecutive no-elimination rounds
        RoomState state;
        // --- following slots ---
        address winner; // address(0) until Finished; always set once Finished
        bytes32 rack; // RACK_SIZE ASCII bytes, left-packed, rest zero
        uint256 pot; // total collected, net of refunds
    }

    // --- Storage ---

    /// @notice The stablecoin used for entries and payouts (e.g. cUSD).
    IERC20 public immutable token;

    /// @notice Recipient of the house rake.
    address public treasury;

    /// @notice Default house rake (bps) applied to *newly created* rooms.
    uint96 public rakeBps;

    uint256 public nextRoomId = 1;

    mapping(uint256 roomId => Room) public rooms;

    /// @dev Swap-and-pop roster of still-alive players. Shrinks every elimination, which is
    ///      what keeps `endRound`'s scan cost falling over the life of a room instead of
    ///      staying pinned to however many people ever joined.
    mapping(uint256 roomId => address[]) internal activePlayers;
    mapping(uint256 roomId => mapping(address player => uint256)) internal playerIndex;

    /// @dev Triple-purpose by design: "is this player still alive this round," "did this
    ///      player join," and "has this player not yet claimed a refund." Safe ONLY because
    ///      `claimRefund` is reachable exclusively from `RoomState.Cancelled`, which is only
    ///      ever reached before `startRoom` — i.e. before elimination ever touches this flag.
    ///      If a future change makes refunds reachable after a room has started (e.g.
    ///      cancelling a stalled active room), this reuse breaks and must be split back into
    ///      separate `hasJoined` / `refunded` mappings.
    mapping(uint256 roomId => mapping(address player => bool)) public isActive;

    /// @notice Score for a given room/round/player. Keying by round means every new round
    ///         starts implicitly at 0 with no clearing loop needed.
    mapping(uint256 roomId => mapping(uint256 round => mapping(address player => uint16))) public
        roundScore;

    /// @notice keccak256 of a word's raw uppercase ASCII bytes (`keccak256(bytes("APPLE"))`,
    ///         NOT `keccak256(abi.encode(...))`) — the on-chain dictionary.
    mapping(bytes32 wordHash => bool) public isValidWord;

    /// @notice Pull-payment balances: winnings, refunds, and rake waiting to be withdrawn.
    mapping(address account => uint256) public claimable;

    // --- Events ---

    event RoomCreated(
        uint256 indexed roomId,
        uint128 entryFee,
        uint16 maxPlayers,
        uint16 minPlayers,
        uint64 joinDeadline,
        uint32 roundDuration,
        uint16 rakeBps
    );
    event PlayerJoined(uint256 indexed roomId, address indexed player);
    event RoomCancelled(uint256 indexed roomId);
    event Refunded(uint256 indexed roomId, address indexed player, uint128 amount);
    event RoomStarted(uint256 indexed roomId, bytes32 rack, uint64 roundEndTime);
    event RoundStarted(uint256 indexed roomId, uint32 round, bytes32 rack, uint64 roundEndTime);
    event WordSubmitted(uint256 indexed roomId, address indexed player, uint32 round, uint16 score);
    event TieReplay(uint256 indexed roomId, uint32 round, uint16 minScore, uint256 tiedCount);
    event PlayerEliminated(uint256 indexed roomId, address indexed player, uint32 round);
    event ForcedTiebreak(
        uint256 indexed roomId, uint32 round, uint256 eliminatedCount, address survivor
    );
    event RoomFinished(uint256 indexed roomId, address indexed winner, uint256 payout);
    event Claimed(address indexed account, uint256 amount);
    event WordsLoaded(uint256 count);
    event TreasuryUpdated(address indexed treasury);
    event RakeUpdated(uint96 rakeBps);

    // --- Errors ---

    error ZeroAddress();
    error RakeTooHigh();
    error RoomNotFound();
    error RoomNotOpen();
    error RoomFull();
    error InvalidCaps();
    error InvalidEntryFee();
    error InvalidDeadline();
    error InvalidRoundDuration();
    error JoinDeadlinePassed();
    error AlreadyJoined();
    error RoomNotCancellable();
    error NotJoined();
    error RefundNotAvailable();
    error CannotStartYet();
    error RoomNotActive();
    error RoundNotEnded();
    error NotActivePlayer();
    error AlreadySubmitted();
    error SubmissionWindowClosed();
    error WordTooShort();
    error WordTooLong();
    error InvalidWordCharacters();
    error LetterNotInRack();
    error WordNotInDictionary();
    error NothingToClaim();

    // --- Constructor ---

    constructor(address token_, address owner_, address treasury_, uint96 rakeBps_)
        Ownable(owner_)
    {
        if (token_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (rakeBps_ > MAX_RAKE_BPS) revert RakeTooHigh();
        token = IERC20(token_);
        treasury = treasury_;
        rakeBps = rakeBps_;
    }

    // --- Admin ---

    /// @notice Batch-load valid word hashes into the dictionary.
    /// @dev Each entry MUST be `keccak256(bytes(WORD))` over the raw uppercase ASCII bytes of
    ///      the word — i.e. exactly what Solidity computes for `keccak256(bytes("APPLE"))`, or
    ///      what `ethers`/`viem`'s `keccak256(toUtf8Bytes("APPLE"))` computes off-chain.
    ///      NOT `keccak256(abi.encode("APPLE"))` — that ABI-pads the string and will never
    ///      match, silently failing every submission with no indication why.
    function loadWords(bytes32[] calldata hashes) external onlyOwner {
        uint256 n = hashes.length;
        for (uint256 i; i < n; ++i) {
            isValidWord[hashes[i]] = true;
        }
        emit WordsLoaded(n);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setRakeBps(uint96 rakeBps_) external onlyOwner {
        if (rakeBps_ > MAX_RAKE_BPS) revert RakeTooHigh();
        rakeBps = rakeBps_;
        emit RakeUpdated(rakeBps_);
    }

    // --- Room lifecycle ---

    /// @notice Open a new room. Anyone may call this — room ids are auto-assigned so callers
    ///         can never squat or collide on an id (unlike WordBreakPools' caller-chosen
    ///         `roundId`, which is safe only because only a trusted operator creates rounds
    ///         there).
    function createRoom(
        uint128 entryFee,
        uint16 maxPlayers,
        uint16 minPlayers,
        uint64 joinDeadline,
        uint32 roundDuration
    ) external returns (uint256 roomId) {
        if (entryFee == 0) revert InvalidEntryFee();
        if (joinDeadline <= block.timestamp) revert InvalidDeadline();
        if (roundDuration == 0) revert InvalidRoundDuration();
        if (minPlayers < 2 || maxPlayers < minPlayers || maxPlayers > MAX_PLAYERS_HARD_CAP) {
            revert InvalidCaps();
        }

        roomId = nextRoomId++;
        uint16 roomRake = uint16(rakeBps);

        rooms[roomId] = Room({
            entryFee: entryFee,
            joinDeadline: joinDeadline,
            maxPlayers: maxPlayers,
            minPlayers: minPlayers,
            rakeBps: roomRake,
            roundDuration: roundDuration,
            currentRound: 0,
            roundEndTime: 0,
            tiedStreak: 0,
            state: RoomState.Open,
            winner: address(0),
            rack: bytes32(0),
            pot: 0
        });

        emit RoomCreated(
            roomId, entryFee, maxPlayers, minPlayers, joinDeadline, roundDuration, roomRake
        );
    }

    /// @notice Pay the entry fee and join a room. One entry per address per room.
    /// @dev Caller must have approved this contract for at least `entryFee` of `token`.
    function joinRoom(uint256 roomId) external nonReentrant {
        Room storage r = rooms[roomId];
        if (r.state == RoomState.NonExistent) revert RoomNotFound();
        if (r.state != RoomState.Open) revert RoomNotOpen();
        if (block.timestamp >= r.joinDeadline) revert JoinDeadlinePassed();
        if (isActive[roomId][msg.sender]) revert AlreadyJoined();
        if (activePlayers[roomId].length >= r.maxPlayers) revert RoomFull();

        isActive[roomId][msg.sender] = true;
        playerIndex[roomId][msg.sender] = activePlayers[roomId].length;
        activePlayers[roomId].push(msg.sender);

        uint128 fee = r.entryFee;
        r.pot += fee;

        token.safeTransferFrom(msg.sender, address(this), fee);

        emit PlayerJoined(roomId, msg.sender);
    }

    /// @notice Cancel a room that never reached its minimum player count in time, opening
    ///         refunds for everyone who joined. Permissionless — anyone can trigger it once
    ///         the condition holds, same "nobody's money can get stuck" spirit as
    ///         WordBreakPools' refund safety net.
    function cancelRoom(uint256 roomId) external {
        Room storage r = rooms[roomId];
        if (r.state == RoomState.NonExistent) revert RoomNotFound();
        if (r.state != RoomState.Open) revert RoomNotCancellable();
        if (block.timestamp < r.joinDeadline) revert RoomNotCancellable();
        if (activePlayers[roomId].length >= r.minPlayers) revert RoomNotCancellable();

        r.state = RoomState.Cancelled;
        emit RoomCancelled(roomId);
    }

    /// @notice Reclaim your entry fee from a cancelled room.
    function claimRefund(uint256 roomId) external nonReentrant {
        Room storage r = rooms[roomId];
        if (r.state == RoomState.NonExistent) revert RoomNotFound();
        if (r.state != RoomState.Cancelled) revert RefundNotAvailable();
        if (!isActive[roomId][msg.sender]) revert NotJoined();

        isActive[roomId][msg.sender] = false;
        uint128 fee = r.entryFee;
        r.pot -= fee;

        token.safeTransfer(msg.sender, fee);
        emit Refunded(roomId, msg.sender, fee);
    }

    /// @notice Start the room: locks joining and deals round 1's rack. Permissionless —
    ///         callable once the room is full, or once it has reached `minPlayers` and the
    ///         join deadline has passed.
    function startRoom(uint256 roomId) external {
        Room storage r = rooms[roomId];
        if (r.state == RoomState.NonExistent) revert RoomNotFound();
        if (r.state != RoomState.Open) revert RoomNotOpen();
        uint256 joined = activePlayers[roomId].length;
        bool full = joined >= r.maxPlayers;
        bool readyAfterDeadline = joined >= r.minPlayers && block.timestamp >= r.joinDeadline;
        if (!full && !readyAfterDeadline) revert CannotStartYet();

        r.state = RoomState.Active;
        _startRound(roomId, r);
        emit RoomStarted(roomId, r.rack, r.roundEndTime);
    }

    // --- Gameplay ---

    /// @notice Submit your one word for the current round, built from that round's rack.
    function submitWord(uint256 roomId, bytes calldata word) external {
        Room storage r = rooms[roomId];
        if (r.state != RoomState.Active) revert RoomNotActive();
        if (block.timestamp >= r.roundEndTime) revert SubmissionWindowClosed();
        if (!isActive[roomId][msg.sender]) revert NotActivePlayer();

        uint32 round = r.currentRound;
        if (roundScore[roomId][round][msg.sender] != 0) revert AlreadySubmitted();

        uint256 len = word.length;
        if (len < MIN_WORD_LENGTH) revert WordTooShort();
        if (len > RACK_SIZE) revert WordTooLong();

        _checkLettersInRack(r.rack, word);

        bytes32 wordHash = keccak256(word);
        if (!isValidWord[wordHash]) revert WordNotInDictionary();

        uint16 score = uint16(len);
        roundScore[roomId][round][msg.sender] = score;
        emit WordSubmitted(roomId, msg.sender, round, score);
    }

    /// @notice Close the current round once its timer has elapsed: eliminate the unique
    ///         lowest scorer, replay on a tie, or force a resolution after too many ties in a
    ///         row. Permissionless keeper call — anyone can advance the game.
    function endRound(uint256 roomId) external nonReentrant {
        Room storage r = rooms[roomId];
        if (r.state != RoomState.Active) revert RoomNotActive();
        if (block.timestamp < r.roundEndTime) revert RoundNotEnded();

        uint256 n = activePlayers[roomId].length;
        if (n == 1) {
            _finalizeWinner(roomId, r, activePlayers[roomId][0]);
            return;
        }

        uint32 round = r.currentRound;
        uint16 minScore = type(uint16).max;
        uint256 minCount;
        uint256 candidateIndex;
        for (uint256 i; i < n; ++i) {
            uint16 s = roundScore[roomId][round][activePlayers[roomId][i]];
            if (s < minScore) {
                minScore = s;
                minCount = 1;
                candidateIndex = i;
            } else if (s == minScore) {
                unchecked {
                    minCount += 1;
                }
            }
        }

        if (minCount == 1) {
            r.tiedStreak = 0;
            address eliminated = _eliminate(roomId, candidateIndex);
            emit PlayerEliminated(roomId, eliminated, round);
            if (activePlayers[roomId].length == 1) {
                _finalizeWinner(roomId, r, activePlayers[roomId][0]);
            } else {
                _startRound(roomId, r);
                emit RoundStarted(roomId, r.currentRound, r.rack, r.roundEndTime);
            }
            return;
        }

        // --- tie for lowest: nobody eliminated, unless the streak has run out ---
        uint16 streak = r.tiedStreak + 1;
        if (streak < TIE_STREAK_LIMIT) {
            r.tiedStreak = streak;
            emit TieReplay(roomId, round, minScore, minCount);
            _startRound(roomId, r);
            emit RoundStarted(roomId, r.currentRound, r.rack, r.roundEndTime);
            return;
        }

        // --- forced tiebreak: the streak ran out, so pick exactly one survivor from the
        // floor by a fixed on-chain rule and eliminate the rest. This guarantees the game
        // always narrows to a single winner -- never a draw -- no matter how persistent the
        // tie. Pass 1 (read-only) finds the survivor: whoever hashes lowest wins, an even
        // coin-flip among the tied group. Same honest caveat as rack randomness: it leans on
        // `block.prevrandao`, so a block proposer who is also a tied player could in
        // principle bias their own odds by choosing whether to include this transaction.
        address survivor;
        uint256 bestHash = type(uint256).max;
        for (uint256 i; i < n; ++i) {
            address p = activePlayers[roomId][i];
            if (roundScore[roomId][round][p] == minScore) {
                uint256 h = uint256(keccak256(abi.encode(block.prevrandao, roomId, round, p)));
                if (h < bestHash) {
                    bestHash = h;
                    survivor = p;
                }
            }
        }

        // Pass 2: eliminate every tied player except the survivor. Walk backward so
        // swap-and-pop never disturbs an index this pass hasn't visited yet.
        uint256 eliminatedCount;
        for (uint256 i = n; i > 0;) {
            unchecked {
                --i;
            }
            address p = activePlayers[roomId][i];
            if (roundScore[roomId][round][p] == minScore && p != survivor) {
                _eliminate(roomId, i);
                unchecked {
                    eliminatedCount += 1;
                }
            }
        }
        emit ForcedTiebreak(roomId, round, eliminatedCount, survivor);

        if (activePlayers[roomId].length == 1) {
            _finalizeWinner(roomId, r, activePlayers[roomId][0]);
        } else {
            r.tiedStreak = 0;
            _startRound(roomId, r);
            emit RoundStarted(roomId, r.currentRound, r.rack, r.roundEndTime);
        }
    }

    /// @notice Withdraw everything owed to you (winnings, a refund, or the treasury's rake).
    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // --- Views ---

    function getRoom(uint256 roomId) external view returns (Room memory) {
        if (rooms[roomId].state == RoomState.NonExistent) revert RoomNotFound();
        return rooms[roomId];
    }

    function getActivePlayers(uint256 roomId) external view returns (address[] memory) {
        return activePlayers[roomId];
    }

    function getRoundScore(uint256 roomId, address player) external view returns (uint16) {
        return roundScore[roomId][rooms[roomId].currentRound][player];
    }

    function version() external pure returns (string memory) {
        return "1.0.0";
    }

    // --- Internal: elimination helpers ---

    function _eliminate(uint256 roomId, uint256 index) internal returns (address player) {
        address[] storage list = activePlayers[roomId];
        player = list[index];
        uint256 lastIndex = list.length - 1;
        if (index != lastIndex) {
            address moved = list[lastIndex];
            list[index] = moved;
            playerIndex[roomId][moved] = index;
        }
        list.pop();
        delete playerIndex[roomId][player];
        isActive[roomId][player] = false;
    }

    function _finalizeWinner(uint256 roomId, Room storage r, address winner) internal {
        r.state = RoomState.Finished;
        r.winner = winner;
        uint256 pot = r.pot;
        uint256 rake = (pot * r.rakeBps) / BPS_DENOMINATOR;
        uint256 payout = pot - rake;
        claimable[winner] += payout;
        if (rake != 0) {
            claimable[treasury] += rake;
        }
        emit RoomFinished(roomId, winner, payout);
    }

    /// @dev Deals a fresh rack and opens a new round window. Caller is responsible for
    ///      `r.currentRound` semantics: this increments it.
    function _startRound(uint256 roomId, Room storage r) internal {
        uint32 round = r.currentRound + 1;
        r.currentRound = round;
        r.rack = _generateRack(roomId, round);
        r.roundEndTime = uint64(block.timestamp) + r.roundDuration;
    }

    /// @dev No external oracle: entropy is `block.prevrandao` mixed with the room and round
    ///      counters. See the contract-level NatSpec for the honest randomness caveat.
    function _generateRack(uint256 roomId, uint32 round) internal view returns (bytes32 rack) {
        bytes32 seed = keccak256(abi.encode(block.prevrandao, roomId, round));
        bytes memory bag = LETTER_BAG;
        uint256 bagLen = bag.length;
        for (uint256 i; i < RACK_SIZE; ++i) {
            uint256 idx = uint256(keccak256(abi.encode(seed, i))) % bagLen;
            // Left-packs each letter into its byte slot, matching bytesN's left-aligned
            // storage (byte 0 is the most significant byte).
            rack |= bytes32(bag[idx]) >> (i * 8);
        }
    }

    /// @dev Verifies `word` uses only letters present in `rack`, each at most as many times as
    ///      the rack has it. Fixed-size 26-bucket counter, bounded by RACK_SIZE + word.length
    ///      (both <= RACK_SIZE) — no unbounded loops regardless of input.
    function _checkLettersInRack(bytes32 rack, bytes calldata word) internal pure {
        uint8[26] memory counts;
        for (uint256 i; i < RACK_SIZE; ++i) {
            bytes1 b = rack[i];
            if (b == 0) break;
            counts[uint8(b) - uint8(bytes1("A"))] += 1;
        }
        uint256 len = word.length;
        for (uint256 i; i < len; ++i) {
            bytes1 c = word[i];
            if (c < bytes1("A") || c > bytes1("Z")) revert InvalidWordCharacters();
            uint8 idx = uint8(c) - uint8(bytes1("A"));
            if (counts[idx] == 0) revert LetterNotInRack();
            counts[idx] -= 1;
        }
    }
}
