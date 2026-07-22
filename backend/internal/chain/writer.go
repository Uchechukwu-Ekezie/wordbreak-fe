// Writer gives the backend the ability to broadcast transactions against WordBreakPools —
// createRound (to open a staked multiplayer room or a daily pool on-chain), settle (to pay
// out once a round ends), and recordScore (to log one played game's score immediately,
// independent of settlement). This is separate from the referee signer: the signer only
// produces off-chain EIP-712 signatures and never needs gas; the Writer holds a funded
// operator key that actually sends transactions. createRound requires the caller to be the
// pool's owner or referee (enforced by the contract); settle and recordScore have no such
// restriction because the EIP-712 signature itself is the authorization, so the Writer can be
// any funded account.
//
// All Transact calls go through a single mutex: go-ethereum's bind package assigns each
// transaction's nonce by querying the pending nonce at send time, so two goroutines racing to
// broadcast from the same operator key can fetch the same nonce and collide. recordScore can
// fire far more often than createRound/settle ever did (once per play, not once per round), so
// this is the call path where that race actually becomes likely rather than theoretical.
package chain

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

const writeABIJSON = `[
  {"type":"function","name":"createRound","stateMutability":"nonpayable",
   "inputs":[{"name":"roundId","type":"uint256"},{"name":"entryFee","type":"uint128"},{"name":"endTime","type":"uint64"}],
   "outputs":[]},
  {"type":"function","name":"settle","stateMutability":"nonpayable",
   "inputs":[{"name":"roundId","type":"uint256"},{"name":"winners","type":"address[]"},
             {"name":"amounts","type":"uint256[]"},{"name":"signature","type":"bytes"}],
   "outputs":[]},
  {"type":"function","name":"recordScore","stateMutability":"nonpayable",
   "inputs":[{"name":"roundId","type":"uint256"},{"name":"player","type":"address"},
             {"name":"score","type":"uint256"},{"name":"attempt","type":"uint256"},
             {"name":"signature","type":"bytes"}],
   "outputs":[]}
]`

// Writer broadcasts write transactions against a deployed WordBreakPools.
type Writer struct {
	mu      sync.Mutex // serializes every Transact call -- see the package doc comment
	bound   *bind.BoundContract
	eth     *ethclient.Client
	auth    *bind.TransactOpts
	address common.Address
}

// NewWriter dials the RPC and prepares a keyed transactor for contractAddr. privHex is the
// operator key: for createRound it must be the pool's owner or referee.
func NewWriter(rpcURL, contractAddr, privHex string, chainID int64) (*Writer, error) {
	if !common.IsHexAddress(contractAddr) {
		return nil, fmt.Errorf("invalid contract address: %q", contractAddr)
	}
	key, err := crypto.HexToECDSA(strings.TrimPrefix(privHex, "0x"))
	if err != nil {
		return nil, fmt.Errorf("invalid operator private key: %w", err)
	}
	eth, err := ethclient.Dial(rpcURL)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", rpcURL, err)
	}
	parsed, err := abi.JSON(strings.NewReader(writeABIJSON))
	if err != nil {
		return nil, fmt.Errorf("parse abi: %w", err)
	}
	auth, err := bind.NewKeyedTransactorWithChainID(key, big.NewInt(chainID))
	if err != nil {
		return nil, fmt.Errorf("transactor: %w", err)
	}
	bound := bind.NewBoundContract(common.HexToAddress(contractAddr), parsed, eth, eth, eth)
	return &Writer{
		bound:   bound,
		eth:     eth,
		auth:    auth,
		address: crypto.PubkeyToAddress(key.PublicKey),
	}, nil
}

// Address is the operator address that broadcasts these transactions.
func (w *Writer) Address() common.Address { return w.address }

// CreateRound opens a round on-chain and blocks until the transaction is mined.
func (w *Writer) CreateRound(ctx context.Context, roundID *big.Int, entryFee *big.Int, endTime uint64) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	opts := *w.auth
	opts.Context = ctx
	tx, err := w.bound.Transact(&opts, "createRound", roundID, entryFee, endTime)
	if err != nil {
		return fmt.Errorf("createRound: %w", err)
	}
	_, err = bind.WaitMined(ctx, w.eth, tx)
	if err != nil {
		return fmt.Errorf("createRound: waiting for confirmation: %w", err)
	}
	return nil
}

// Settle submits a referee-signed result and blocks until the transaction is mined.
func (w *Writer) Settle(ctx context.Context, roundID *big.Int, winners []common.Address, amounts []*big.Int, sig []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	opts := *w.auth
	opts.Context = ctx
	tx, err := w.bound.Transact(&opts, "settle", roundID, winners, amounts, sig)
	if err != nil {
		return fmt.Errorf("settle: %w", err)
	}
	_, err = bind.WaitMined(ctx, w.eth, tx)
	if err != nil {
		return fmt.Errorf("settle: waiting for confirmation: %w", err)
	}
	return nil
}

// RecordScore submits a referee-signed score for one play and blocks until the transaction is
// mined. attempt must match the contract's current on-chain scoreCount(roundId, player) --
// callers should read that (via chain.Client.ScoreCount) immediately before signing, under the
// same care needed for any nonce: stale attempt values fail with WordBreakPools.InvalidAttempt.
func (w *Writer) RecordScore(ctx context.Context, roundID *big.Int, player common.Address, score, attempt *big.Int, sig []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	opts := *w.auth
	opts.Context = ctx
	tx, err := w.bound.Transact(&opts, "recordScore", roundID, player, score, attempt, sig)
	if err != nil {
		return fmt.Errorf("recordScore: %w", err)
	}
	_, err = bind.WaitMined(ctx, w.eth, tx)
	if err != nil {
		return fmt.Errorf("recordScore: waiting for confirmation: %w", err)
	}
	return nil
}

// Close releases the RPC connection.
func (w *Writer) Close() { w.eth.Close() }
