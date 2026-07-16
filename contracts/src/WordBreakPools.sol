// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title WordBreakPools
/// @notice Escrow for WordBreak prize-pool rounds (the daily paid challenge).
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
contract WordBreakPools is Ownable, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Constants ---

    /// @notice Hard cap on the house rake: 10% (1000 basis points).
    uint96 public constant MAX_RAKE_BPS = 1000;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    bytes32 private constant SETTLEMENT_TYPEHASH =
        keccak256("Settlement(uint256 roundId,address[] winners,uint256[] amounts)");

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

    /// @notice The stablecoin used for entries and payouts (e.g. cUSD).
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

    // --- Constructor ---

    constructor(
        address token_,
        address referee_,
        address treasury_,
        uint96 rakeBps_,
        uint32 refundDelay_,
        address owner_
    ) Ownable(owner_) EIP712("WordBreakPools", "1") {
        if (token_ == address(0) || referee_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (rakeBps_ > MAX_RAKE_BPS) revert RakeTooHigh();

        token = IERC20(token_);
        referee = referee_;
        treasury = treasury_;
        rakeBps = rakeBps_;
        refundDelay = refundDelay_;
    }

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

    /// @notice Open a new round. `roundId` is chosen by the caller (e.g. a YYYYMMDD date key)
    ///         so the daily is deterministic and easy to reference off-chain.
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
