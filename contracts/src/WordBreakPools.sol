// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
// ReentrancyGuard is `@custom:stateless` as of OZ 5.6 — it keys its lock off a fixed
// keccak-derived slot rather than constructor-assigned storage, so it self-initializes
// correctly on first use through a proxy. OZ no longer ships (or needs) a separate
// ReentrancyGuardUpgradeable for this reason; the plain, non-upgradeable import is correct
// here even though the rest of this contract is upgradeable.
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {
    EIP712Upgradeable
} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";

/// @title WordBreakPools
/// @notice Escrow for WordBreak prize-pool rounds (the daily paid challenge + staked
///         multiplayer rooms).
///
/// Design in one breath:
///  - Players pay a fixed entry fee (in an ERC-20 stablecoin, e.g. cUSD) to join a round.
///  - Fees pool inside this contract — the operator never custodies funds personally.
///  - When entry closes, the off-chain **referee** (the backend that actually scores the
///    game) signs an EIP-712 result naming winners and amounts. The contract verifies that
///    signature and credits each winner; the house rake goes to the treasury.
///  - Winners pull their funds with `claim()`.
///  - Safety net: if the referee never settles (backend disappears), every entrant can
///    reclaim their exact stake with `claimRefund()` after a grace period. Nobody's money
///    can get stuck.
///
/// Trust model (be honest): for the MVP the referee is a *trusted oracle* — it decides who
/// won. The contract's job is to (a) hold the money trustlessly, (b) guarantee the referee
/// can only ever distribute what a round actually collected, and (c) guarantee refunds if
/// the referee goes dark. It does NOT verify the word game itself on-chain.
///
/// Upgradeability (UUPS): this contract sits behind an ERC1967 proxy, so new features (new
/// round types, on-chain leaderboard hashes, etc.) can be added post-deployment without a
/// migration — `_authorizeUpgrade` is `onlyOwner`. Existing state (rounds, balances) survives
/// every upgrade untouched; only the logic changes. Being honest about the tradeoff: this
/// means the owner key can change *any* contract logic, including the payout rules — an
/// upgradeable contract is only as trustworthy as who controls that key. Before real money
/// flows at scale, move ownership to a timelock and/or multisig rather than a single EOA.
contract WordBreakPools is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuard,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // --- Constants ---

    /// @notice Hard cap on the house rake: 10% (1000 basis points).
    uint96 public constant MAX_RAKE_BPS = 1000;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    bytes32 private constant SETTLEMENT_TYPEHASH =
        keccak256("Settlement(uint256 roundId,address[] winners,uint256[] amounts)");

    /// @dev Deliberately separate from SETTLEMENT_TYPEHASH: a score is recorded once per play,
    ///      immediately, well before the round's overall settlement (which only ever happens
    ///      once, later, after entry closes, for the round as a whole). `attempt` is a
    ///      per-(round,player) nonce — it must equal that player's current attempt count, so a
    ///      given signature can only ever be applied once and attempts land in order.
    bytes32 private constant SCORE_TYPEHASH =
        keccak256("Score(uint256 roundId,address player,uint256 score,uint256 attempt)");

    // --- Types ---

    struct Round {
        // --- slot 0 (economics frozen at creation) — packs into exactly 32 bytes ---
        uint128 entryFee; // fixed cost to enter, in `token` units
        uint64 endTime; // entry closes / earliest settle time (unix seconds)
        uint32 refundDelay; // grace (s) after endTime before this round is refundable
        uint16 rakeBps; // house rake for this round (<= MAX_RAKE_BPS)
        bool settled; // referee result applied
        bool cancelled; // admin cancelled -> refunds open
        // --- following slots ---
        uint256 pot; // total collected, net of any refunds
        uint256 entrants; // number of paying entrants
    }

    // --- Storage ---
    // NOTE ON UPGRADES: never reorder, retype, or delete these — only append new variables
    // above `__gap`, shrinking `__gap` by the same number of slots you add. Reordering or
    // deleting corrupts every existing proxy's storage.

    /// @notice The stablecoin used for entries and payouts (e.g. cUSD). Set once at
    ///         implementation-deploy time (immutable — baked into bytecode, not proxy
    ///         storage), so this pool is permanently pinned to one token even across upgrades.
    IERC20 public immutable token;

    /// @notice Backend signer whose EIP-712 signature settles rounds.
    address public referee;

    /// @notice Recipient of the house rake (and any rounding dust).
    address public treasury;

    /// @notice Default house rake (bps) applied to *newly created* rounds.
    uint96 public rakeBps;

    /// @notice Default grace (s) after `endTime` before a *newly created* round is refundable.
    /// @dev Both `rakeBps` and `refundDelay` are snapshotted into each round at creation, so
    ///      changing them never alters the economics of a round that's already open.
    uint32 public refundDelay;

    mapping(uint256 roundId => Round) public rounds;
    mapping(uint256 roundId => bool) public roundExists;
    mapping(uint256 roundId => mapping(address player => bool)) public hasEntered;
    mapping(uint256 roundId => mapping(address player => bool)) public refunded;

    /// @notice Pull-payment balances: winnings + rake waiting to be withdrawn.
    mapping(address account => uint256) public claimable;

    /// @notice Every score a player has ever submitted for a round, in play order — one entry
    ///         per game played, not just their best. Recorded immediately after each play,
    ///         independent of `settle()`, which only ever runs once, later, for the round as a
    ///         whole. Purely a historical record: recording a score never touches `pot` or
    ///         `claimable`, so it can't affect payouts either way.
    mapping(uint256 roundId => mapping(address player => uint256[])) internal playerScores;

    /// @dev Reserved storage so future versions can append new variables without shifting
    ///      the layout of anything above. Shrink this array (never grow it) as slots are used.
    uint256[49] private __gap;

    // --- Events ---

    event RoundCreated(
        uint256 indexed roundId,
        uint128 entryFee,
        uint64 endTime,
        uint16 rakeBps,
        uint32 refundDelay
    );
    event Entered(uint256 indexed roundId, address indexed player, uint128 entryFee);
    event Settled(
        uint256 indexed roundId, uint256 winnerCount, uint256 paidToWinners, uint256 rake
    );
    event RoundCancelled(uint256 indexed roundId);
    event Refunded(uint256 indexed roundId, address indexed player, uint128 amount);
    event ScoreRecorded(
        uint256 indexed roundId, address indexed player, uint256 attempt, uint256 score
    );
    event Claimed(address indexed account, uint256 amount);
    event RefereeUpdated(address indexed referee);
    event TreasuryUpdated(address indexed treasury);
    event RakeUpdated(uint96 rakeBps);
    event RefundDelayUpdated(uint32 refundDelay);

    // --- Errors ---

    error ZeroAddress();
    error RakeTooHigh();
    error RoundAlreadyExists();
    error RoundNotFound();
    error RoundClosed();
    error EntryClosed();
    error EntryStillOpen();
    error TooLateToSettle();
    error AlreadyEntered();
    error NotEntered();
    error AlreadyRefunded();
    error RefundNotAvailable();
    error InvalidAttempt();
    error InvalidEntryFee();
    error InvalidEndTime();
    error LengthMismatch();
    error NoWinners();
    error PayoutExceedsPot();
    error BadSignature();
    error NothingToClaim();
    error NotOperator();

    // --- Modifiers ---

    /// @dev Owner or referee may create/cancel rounds (the backend needs to open dailies).
    modifier onlyOperator() {
        if (msg.sender != owner() && msg.sender != referee) revert NotOperator();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address token_) {
        if (token_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        // Prevents anyone from calling initialize() directly on the implementation contract
        // (as opposed to through the proxy) — a well-known UUPS footgun otherwise.
        _disableInitializers();
    }

    /// @notice Runs once, at proxy deployment, in place of a constructor.
    function initialize(
        address referee_,
        address treasury_,
        uint96 rakeBps_,
        uint32 refundDelay_,
        address owner_
    ) public initializer {
        if (referee_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (rakeBps_ > MAX_RAKE_BPS) revert RakeTooHigh();

        __Ownable_init(owner_);
        __EIP712_init("WordBreakPools", "1");
        // UUPSUpgradeable in this OZ version is stateless (a thin re-export of the base
        // contract) — no __UUPSUpgradeable_init() exists or is needed.

        referee = referee_;
        treasury = treasury_;
        rakeBps = rakeBps_;
        refundDelay = refundDelay_;
    }

    /// @dev Only the owner may authorize an upgrade. See the contract-level NatSpec for the
    ///      centralization tradeoff this implies.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // --- Admin ---

    function setReferee(address referee_) external onlyOwner {
        if (referee_ == address(0)) revert ZeroAddress();
        referee = referee_;
        emit RefereeUpdated(referee_);
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

    function setRefundDelay(uint32 refundDelay_) external onlyOwner {
        refundDelay = refundDelay_;
        emit RefundDelayUpdated(refundDelay_);
    }

    // --- Round lifecycle ---

    /// @notice Open a new round. `roundId` is chosen by the caller (e.g. a YYYYMMDD date key,
    ///         or a random id for a multiplayer stake) so it's deterministic and easy to
    ///         reference off-chain.
    function createRound(uint256 roundId, uint128 entryFee, uint64 endTime) external onlyOperator {
        if (roundExists[roundId]) revert RoundAlreadyExists();
        if (entryFee == 0) revert InvalidEntryFee();
        if (endTime <= block.timestamp) revert InvalidEndTime();

        // Freeze this round's economics now, so later admin changes to the defaults can't
        // move the rake or refund window out from under players who've already paid in.
        uint16 roundRake = uint16(rakeBps);
        uint32 roundRefundDelay = refundDelay;

        roundExists[roundId] = true;
        rounds[roundId] = Round({
            entryFee: entryFee,
            endTime: endTime,
            refundDelay: roundRefundDelay,
            rakeBps: roundRake,
            settled: false,
            cancelled: false,
            pot: 0,
            entrants: 0
        });

        emit RoundCreated(roundId, entryFee, endTime, roundRake, roundRefundDelay);
    }

    /// @notice Pay the entry fee and join a round. One entry per address per round.
    /// @dev Caller must have approved this contract for at least `entryFee` of `token`.
    function enter(uint256 roundId) external nonReentrant {
        if (!roundExists[roundId]) revert RoundNotFound();
        Round storage r = rounds[roundId];
        if (r.settled || r.cancelled) revert RoundClosed();
        if (block.timestamp >= r.endTime) revert EntryClosed();
        if (hasEntered[roundId][msg.sender]) revert AlreadyEntered();

        hasEntered[roundId][msg.sender] = true;
        uint128 fee = r.entryFee;
        r.pot += fee;
        unchecked {
            r.entrants += 1;
        }

        // Standard stablecoins (cUSD/USDT) are not fee-on-transfer, so the fixed `entryFee`
        // is exactly what lands here. Note: Celo gas paid in a fee-currency (CIP-64) is
        // debited out-of-band and does NOT affect this transfer amount.
        token.safeTransferFrom(msg.sender, address(this), fee);

        emit Entered(roundId, msg.sender, fee);
    }

    /// @notice Apply the referee's signed result: credit winners, send rake to treasury.
    /// @param winners Addresses that placed, in any order.
    /// @param amounts Payout to each winner (same length/order as `winners`).
    /// @param signature EIP-712 signature by `referee` over (roundId, winners, amounts).
    /// @dev Winners are credited (pull-payment); they withdraw via `claim()`. The treasury
    ///      receives everything the winners didn't (rake + any dust), so no funds strand.
    function settle(
        uint256 roundId,
        address[] calldata winners,
        uint256[] calldata amounts,
        bytes calldata signature
    ) external nonReentrant {
        if (!roundExists[roundId]) revert RoundNotFound();
        Round storage r = rounds[roundId];
        if (r.settled || r.cancelled) revert RoundClosed();
        if (block.timestamp < r.endTime) revert EntryStillOpen();
        // Settle window closes when the refund grace opens, so a round can never be both
        // settled and refundable. Past this point the referee is presumed dead → refunds only.
        if (block.timestamp > uint256(r.endTime) + r.refundDelay) revert TooLateToSettle();
        uint256 n = winners.length;
        if (n != amounts.length) revert LengthMismatch();
        if (n == 0) revert NoWinners();

        _verifyResult(roundId, winners, amounts, signature);

        uint256 pot = r.pot;
        uint256 rake = (pot * r.rakeBps) / BPS_DENOMINATOR;
        uint256 maxToWinners = pot - rake;

        uint256 sum;
        for (uint256 i; i < n; ++i) {
            sum += amounts[i];
        }
        if (sum > maxToWinners) revert PayoutExceedsPot();

        r.settled = true;

        for (uint256 i; i < n; ++i) {
            claimable[winners[i]] += amounts[i];
        }
        // Treasury gets the remainder (>= rake). Guarantees the whole pot is accounted for.
        uint256 treasuryCut = pot - sum;
        if (treasuryCut != 0) {
            claimable[treasury] += treasuryCut;
        }

        emit Settled(roundId, n, sum, treasuryCut);
    }

    /// @notice Admin-cancel a round, opening refunds for all entrants.
    function cancelRound(uint256 roundId) external onlyOperator {
        if (!roundExists[roundId]) revert RoundNotFound();
        Round storage r = rounds[roundId];
        if (r.settled || r.cancelled) revert RoundClosed();
        r.cancelled = true;
        emit RoundCancelled(roundId);
    }

    /// @notice Reclaim your stake if a round was cancelled, or if the referee never settled
    ///         it within `refundDelay` after entry closed. This is the anti-rug guarantee.
    function claimRefund(uint256 roundId) external nonReentrant {
        if (!roundExists[roundId]) revert RoundNotFound();
        Round storage r = rounds[roundId];
        if (!hasEntered[roundId][msg.sender]) revert NotEntered();
        if (refunded[roundId][msg.sender]) revert AlreadyRefunded();

        bool refundable =
            r.cancelled || (!r.settled && block.timestamp > uint256(r.endTime) + r.refundDelay);
        if (!refundable) revert RefundNotAvailable();

        refunded[roundId][msg.sender] = true;
        uint128 fee = r.entryFee;
        r.pot -= fee;

        token.safeTransfer(msg.sender, fee);
        emit Refunded(roundId, msg.sender, fee);
    }

    /// @notice Record one game's score for a round, right after a player finishes playing it —
    ///         independent of and well before `settle()`, which only ever runs once, later,
    ///         for the round as a whole. Every play gets its own entry (see `playerScores`),
    ///         not just a player's best. Purely a historical record: it never touches `pot` or
    ///         `claimable`, so a bad or malicious call can't move money either way; the only
    ///         thing it risks is a wrong number in the on-chain record, which is exactly why
    ///         it's still gated by the referee's signature rather than open to anyone.
    /// @dev Permissionless caller, signature-gated authorization — same pattern as `settle()`.
    ///      `attempt` must equal this player's current attempt count for this round (i.e. the
    ///      index this call would append at) — it's a nonce, so a given signature can only ever
    ///      be applied once, attempts land in strict order, and a stale signature can't be
    ///      replayed after a newer attempt has already been recorded.
    function recordScore(
        uint256 roundId,
        address player,
        uint256 score,
        uint256 attempt,
        bytes calldata signature
    ) external {
        if (!roundExists[roundId]) revert RoundNotFound();
        if (!hasEntered[roundId][player]) revert NotEntered();
        if (attempt != playerScores[roundId][player].length) revert InvalidAttempt();

        bytes32 digest = _scoreDigest(roundId, player, score, attempt);
        address signer = ECDSA.recover(digest, signature);
        if (signer != referee) revert BadSignature();

        playerScores[roundId][player].push(score);
        emit ScoreRecorded(roundId, player, attempt, score);
    }

    /// @notice Withdraw everything owed to you (winnings and/or rake).
    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // --- Views ---

    function getRound(uint256 roundId) external view returns (Round memory) {
        if (!roundExists[roundId]) revert RoundNotFound();
        return rounds[roundId];
    }

    /// @notice The EIP-712 digest a referee must sign for a given result. Exposed so the
    ///         backend can cross-check its signing against on-chain hashing.
    function settlementDigest(
        uint256 roundId,
        address[] calldata winners,
        uint256[] calldata amounts
    ) external view returns (bytes32) {
        return _settlementDigest(roundId, winners, amounts);
    }

    /// @notice The EIP-712 digest a referee must sign for a player's score. Exposed so the
    ///         backend can cross-check its signing against on-chain hashing.
    function scoreDigest(uint256 roundId, address player, uint256 score, uint256 attempt)
        external
        view
        returns (bytes32)
    {
        return _scoreDigest(roundId, player, score, attempt);
    }

    /// @notice Every score a player has submitted for a round, in play order.
    function getScores(uint256 roundId, address player) external view returns (uint256[] memory) {
        return playerScores[roundId][player];
    }

    /// @notice How many scores a player has submitted for a round so far — also the
    ///         `attempt` index their next `recordScore` call must use.
    function scoreCount(uint256 roundId, address player) external view returns (uint256) {
        return playerScores[roundId][player].length;
    }

    /// @notice The running implementation version, for off-chain tooling to sanity-check
    ///         which logic a given proxy is currently pointed at. Bump on each upgrade.
    function version() external pure virtual returns (string memory) {
        return "1.1.0";
    }

    // --- Internal ---

    function _verifyResult(
        uint256 roundId,
        address[] calldata winners,
        uint256[] calldata amounts,
        bytes calldata signature
    ) internal view {
        bytes32 digest = _settlementDigest(roundId, winners, amounts);
        address signer = ECDSA.recover(digest, signature);
        if (signer != referee) revert BadSignature();
    }

    function _scoreDigest(uint256 roundId, address player, uint256 score, uint256 attempt)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(SCORE_TYPEHASH, roundId, player, score, attempt));
        return _hashTypedDataV4(structHash);
    }

    function _settlementDigest(
        uint256 roundId,
        address[] calldata winners,
        uint256[] calldata amounts
    ) internal view returns (bytes32) {
        // EIP-712 arrays hash as keccak of the concatenated 32-byte-encoded elements, which
        // is exactly abi.encodePacked over the (padded) array — matches ethers/viem
        // signTypedData for address[] and uint256[].
        bytes32 structHash = keccak256(
            abi.encode(
                SETTLEMENT_TYPEHASH,
                roundId,
                keccak256(abi.encodePacked(winners)),
                keccak256(abi.encodePacked(amounts))
            )
        );
        return _hashTypedDataV4(structHash);
    }
}
