package app

import (
	"encoding/binary"
	"encoding/hex"
	"errors"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

var (
	ErrBuyNeedsLimitPrice = errors.New("a buy intent must carry a limit price so its cost can be bounded")
	ErrStrategyWipedOut   = errors.New("strategy has shares outstanding but no value")
	ErrZeroAmount         = errors.New("amount must be non-zero")
	ErrWrongQuoteToken    = errors.New("allocation must be in the vault's quote token")
)

// RegisterStrategy creates a strategy with a fixed risk mandate.
//
// The mandate is enforced by the enclave on every intent, so it binds the
// strategist rather than merely describing their intentions.
func (st *ApplicationInternalState) RegisterStrategy(id string, manager types.Address, mandate Mandate) (*Strategy, error) {
	if id == "" {
		return nil, ErrUnknownStrategy
	}
	if _, exists := st.Strategies[id]; exists {
		return nil, ErrStrategyExists
	}

	s := &Strategy{
		ID:          id,
		Manager:     manager,
		Mandate:     mandate,
		Balances:    make(map[string]*types.Uint256),
		TotalShares: types.NewUint256(0),
	}
	st.Strategies[id] = s
	return s, nil
}

// Deposit credits an incoming on-chain transfer to the sender's idle balance.
//
// This is called from Vela's `deposit` export, which knows only the sender,
// token and amount. Which strategy the money backs is chosen separately by
// Allocate, which is what keeps depositor-to-strategy linkage private: the
// public deposit reveals only that someone funded the pool.
func (st *ApplicationInternalState) Deposit(depositor types.Address, token types.Address, amount types.Uint256) error {
	if amount.IsZero() {
		return ErrZeroAmount
	}

	acct := st.Account(depositor)
	next, err := Add(acct.UnallocatedBalance(token), amount)
	if err != nil {
		return err
	}
	acct.setUnallocated(token, next)
	return nil
}

// Allocate moves idle quote balance into a strategy and issues shares for it.
//
// Shares are priced off the strategy's net asset value at the moment of
// allocation, so an incoming depositor neither dilutes nor is diluted by
// existing holders.
func (st *ApplicationInternalState) Allocate(
	depositor types.Address,
	strategyID string,
	amount types.Uint256,
	prices PriceSet,
) (types.Uint256, error) {
	if amount.IsZero() {
		return types.Uint256{}, ErrZeroAmount
	}

	s, err := st.Strategy(strategyID)
	if err != nil {
		return types.Uint256{}, err
	}
	if s.Halted {
		return types.Uint256{}, ErrStrategyHalted
	}
	if !s.Mandate.Allows(st.QuoteToken) {
		return types.Uint256{}, ErrTokenNotAllowed
	}

	acct := st.Account(depositor)
	idle := acct.UnallocatedBalance(st.QuoteToken)
	if idle.Cmp(amount) < 0 {
		return types.Uint256{}, ErrInsufficientFunds
	}

	// Value the strategy before the new money lands.
	navBefore, err := st.NAV(s, prices)
	if err != nil {
		return types.Uint256{}, err
	}

	var issued types.Uint256
	switch {
	case s.TotalShares.IsZero():
		// First money in sets the share price at one-to-one.
		issued = amount
	case navBefore.IsZero():
		// Shares exist but the strategy is worth nothing. Issuing against a
		// zero NAV would divide by zero and hand the newcomer everything, so
		// refuse and let the strategy be wound down instead.
		return types.Uint256{}, ErrStrategyWipedOut
	default:
		issued, err = MulDiv(amount, *s.TotalShares, navBefore)
		if err != nil {
			return types.Uint256{}, err
		}
		if issued.IsZero() {
			// The deposit is too small to buy even one share unit.
			return types.Uint256{}, ErrZeroAmount
		}
	}

	// Move the money and mint the shares.
	remaining, err := Sub(idle, amount)
	if err != nil {
		return types.Uint256{}, err
	}
	acct.setUnallocated(st.QuoteToken, remaining)

	if err := s.credit(st.QuoteToken, amount); err != nil {
		return types.Uint256{}, err
	}

	newTotal, err := Add(*s.TotalShares, issued)
	if err != nil {
		return types.Uint256{}, err
	}
	s.TotalShares = &newTotal

	held, err := Add(acct.ShareBalance(strategyID), issued)
	if err != nil {
		return types.Uint256{}, err
	}
	acct.setShares(strategyID, held)

	return issued, nil
}

// Redeem burns shares and returns their value to the depositor's idle balance.
//
// Redemption is paid from the strategy's quote holdings. If the strategy is
// fully invested there may not be enough, in which case the caller must wait
// for a position to be unwound rather than forcing a liquidation mid-batch.
func (st *ApplicationInternalState) Redeem(
	depositor types.Address,
	strategyID string,
	shares types.Uint256,
	prices PriceSet,
) (types.Uint256, error) {
	if shares.IsZero() {
		return types.Uint256{}, ErrZeroAmount
	}

	s, err := st.Strategy(strategyID)
	if err != nil {
		return types.Uint256{}, err
	}

	acct, ok := st.Accounts[depositor.Hex()]
	if !ok || acct == nil {
		return types.Uint256{}, ErrNoSuchAccount
	}

	held := acct.ShareBalance(strategyID)
	if held.Cmp(shares) < 0 {
		return types.Uint256{}, ErrInsufficientFunds
	}
	if s.TotalShares.IsZero() {
		return types.Uint256{}, ErrNothingToValue
	}

	nav, err := st.NAV(s, prices)
	if err != nil {
		return types.Uint256{}, err
	}

	value, err := MulDiv(shares, nav, *s.TotalShares)
	if err != nil {
		return types.Uint256{}, err
	}

	// Paid out of quote holdings only; positions are not force-sold here.
	if s.Balance(st.QuoteToken).Cmp(value) < 0 {
		return types.Uint256{}, ErrInsufficientFunds
	}
	if err := s.debit(st.QuoteToken, value); err != nil {
		return types.Uint256{}, err
	}

	remainingShares, err := Sub(held, shares)
	if err != nil {
		return types.Uint256{}, err
	}
	acct.setShares(strategyID, remainingShares)

	newTotal, err := Sub(*s.TotalShares, shares)
	if err != nil {
		return types.Uint256{}, err
	}
	s.TotalShares = &newTotal

	idle, err := Add(acct.UnallocatedBalance(st.QuoteToken), value)
	if err != nil {
		return types.Uint256{}, err
	}
	acct.setUnallocated(st.QuoteToken, idle)

	return value, nil
}

// SubmitIntent validates an intent against its strategy's mandate and queues it
// for the next batch.
//
// Every check here is a check the depositor is relying on. The strategist's own
// client cannot be trusted to enforce its own limits, so the enclave does it.
func (st *ApplicationInternalState) SubmitIntent(sender types.Address, in Intent) (Intent, error) {
	s, err := st.Strategy(in.StrategyID)
	if err != nil {
		return Intent{}, err
	}
	if s.Manager != sender {
		return Intent{}, ErrNotManager
	}
	if s.Halted {
		return Intent{}, ErrStrategyHalted
	}
	if in.Amount == nil || in.Amount.IsZero() {
		return Intent{}, ErrZeroAmount
	}
	if in.LimitPrice == nil {
		return Intent{}, ErrBuyNeedsLimitPrice
	}
	if !s.Mandate.Allows(in.Base) || !s.Mandate.Allows(in.Quote) {
		return Intent{}, ErrTokenNotAllowed
	}
	if in.Quote != st.QuoteToken {
		return Intent{}, ErrWrongQuoteToken
	}

	if s.Mandate.MaxOrderBase != nil && !s.Mandate.MaxOrderBase.IsZero() {
		if in.Amount.Cmp(*s.Mandate.MaxOrderBase) > 0 {
			return Intent{}, ErrOrderTooLarge
		}
	}

	if in.Side == SideBuy {
		if err := st.checkBuyAffordable(s, in); err != nil {
			return Intent{}, err
		}
	} else if err := st.checkSellCovered(s, in); err != nil {
		return Intent{}, err
	}

	st.IntentNonce++
	in.ID = deterministicID("intent", st.IntentNonce)
	st.Pending = append(st.Pending, in)

	return in, nil
}

// checkBuyAffordable bounds the cost of a buy by its limit price and confirms
// the strategy can cover it alongside everything else it already has queued.
//
// A buy must carry a limit price precisely so this bound exists: without one,
// the cost is unknown until execution and the strategy could commit to more
// than it holds.
func (st *ApplicationInternalState) checkBuyAffordable(s *Strategy, in Intent) error {
	if in.LimitPrice.IsZero() {
		return ErrBuyNeedsLimitPrice
	}

	cost, err := ApplyPrice(*in.Amount, *in.LimitPrice)
	if err != nil {
		return err
	}

	committed, err := st.pendingBuyCost(s.ID)
	if err != nil {
		return err
	}

	total, err := Add(committed, cost)
	if err != nil {
		return err
	}

	if s.Balance(st.QuoteToken).Cmp(total) < 0 {
		return ErrInsufficientFunds
	}

	if s.Mandate.MaxPositionBase != nil && !s.Mandate.MaxPositionBase.IsZero() {
		queued, err := st.pendingBuyBase(s.ID, in.Base)
		if err != nil {
			return err
		}
		projected, err := Add(s.Balance(in.Base), queued)
		if err != nil {
			return err
		}
		projected, err = Add(projected, *in.Amount)
		if err != nil {
			return err
		}
		if projected.Cmp(*s.Mandate.MaxPositionBase) > 0 {
			return ErrPositionTooLarge
		}
	}

	return nil
}

// checkSellCovered confirms the strategy actually holds what it is offering,
// counting anything already queued. The vault does not permit shorting.
func (st *ApplicationInternalState) checkSellCovered(s *Strategy, in Intent) error {
	queued, err := st.pendingSellBase(s.ID, in.Base)
	if err != nil {
		return err
	}

	total, err := Add(queued, *in.Amount)
	if err != nil {
		return err
	}

	if s.Balance(in.Base).Cmp(total) < 0 {
		return ErrInsufficientFunds
	}
	return nil
}

// pendingBuyCost sums the worst-case cost of a strategy's queued buys.
func (st *ApplicationInternalState) pendingBuyCost(strategyID string) (types.Uint256, error) {
	var total types.Uint256
	for i := range st.Pending {
		p := &st.Pending[i]
		if p.StrategyID != strategyID || p.Side != SideBuy || p.Amount == nil || p.LimitPrice == nil {
			continue
		}
		cost, err := ApplyPrice(*p.Amount, *p.LimitPrice)
		if err != nil {
			return types.Uint256{}, err
		}
		total, err = Add(total, cost)
		if err != nil {
			return types.Uint256{}, err
		}
	}
	return total, nil
}

// pendingBuyBase sums a strategy's queued buy quantity for one token.
func (st *ApplicationInternalState) pendingBuyBase(strategyID string, base types.Address) (types.Uint256, error) {
	return st.pendingBase(strategyID, base, SideBuy)
}

// pendingSellBase sums a strategy's queued sell quantity for one token.
func (st *ApplicationInternalState) pendingSellBase(strategyID string, base types.Address) (types.Uint256, error) {
	return st.pendingBase(strategyID, base, SideSell)
}

func (st *ApplicationInternalState) pendingBase(strategyID string, base types.Address, side Side) (types.Uint256, error) {
	var total types.Uint256
	for i := range st.Pending {
		p := &st.Pending[i]
		if p.StrategyID != strategyID || p.Side != side || p.Base != base || p.Amount == nil {
			continue
		}
		var err error
		total, err = Add(total, *p.Amount)
		if err != nil {
			return types.Uint256{}, err
		}
	}
	return total, nil
}

// deterministicID builds an identifier from a monotonic counter.
//
// The enclave has no clock and no source of randomness, so identifiers must be
// derived from state. A counter also makes replay obvious: the same input
// always produces the same ID.
func deterministicID(prefix string, nonce uint64) string {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], nonce)
	return prefix + "-" + hex.EncodeToString(buf[:])
}
