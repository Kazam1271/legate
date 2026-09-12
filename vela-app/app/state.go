package app

import (
	"errors"
	"sort"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

var (
	ErrUnknownStrategy   = errors.New("unknown strategy")
	ErrStrategyExists    = errors.New("strategy already exists")
	ErrNotManager        = errors.New("sender is not the strategy manager")
	ErrStrategyHalted    = errors.New("strategy is halted")
	ErrTokenNotAllowed   = errors.New("token is not in the strategy mandate")
	ErrOrderTooLarge     = errors.New("intent exceeds the mandate's maximum order size")
	ErrPositionTooLarge  = errors.New("intent would exceed the mandate's maximum position")
	ErrInsufficientFunds = errors.New("insufficient balance")
	ErrNoSuchAccount     = errors.New("unknown account")
	ErrMissingPrice      = errors.New("no price supplied for a held token")
	ErrNothingToValue    = errors.New("strategy has no net asset value")
)

// Mandate is the risk envelope a strategy is allowed to operate inside. It is
// enforced by the enclave on every intent, so a compromised or buggy strategist
// client cannot exceed it. Depositors rely on this, not on trusting the
// strategist.
type Mandate struct {
	// AllowedTokens restricts which assets the strategy may hold or trade.
	AllowedTokens []types.Address `json:"allowedTokens"`
	// MaxOrderBase caps a single intent, in base units. Zero means unlimited.
	MaxOrderBase *types.Uint256 `json:"maxOrderBase"`
	// MaxPositionBase caps the holding of any one token. Zero means unlimited.
	MaxPositionBase *types.Uint256 `json:"maxPositionBase"`
}

// Allows reports whether a token may be held or traded under this mandate.
func (m *Mandate) Allows(token types.Address) bool {
	for _, t := range m.AllowedTokens {
		if t == token {
			return true
		}
	}
	return false
}

// Strategy is one trading strategy inside the pool. Its balances and share
// count are confidential: they exist only inside the enclave, and depositors
// learn only the attested NAV.
type Strategy struct {
	ID      string        `json:"id"`
	Manager types.Address `json:"manager"`
	Mandate Mandate       `json:"mandate"`

	// Balances holds this strategy's share of pooled custody, keyed by token
	// hex. The quote asset is held here alongside traded assets.
	Balances map[string]*types.Uint256 `json:"balances"`

	// TotalShares is the number of depositor shares issued against this
	// strategy. Share value is NAV/TotalShares.
	TotalShares *types.Uint256 `json:"totalShares"`

	// Halted stops a strategy accepting new intents, e.g. after a risk breach.
	Halted bool `json:"halted"`
}

// Balance returns the strategy's holding of a token, or zero.
func (s *Strategy) Balance(token types.Address) types.Uint256 {
	if b, ok := s.Balances[token.Hex()]; ok && b != nil {
		return *b
	}
	return types.Uint256{}
}

// setBalance writes a token balance, dropping the entry when it reaches zero so
// state does not grow without bound.
func (s *Strategy) setBalance(token types.Address, v types.Uint256) {
	if v.IsZero() {
		delete(s.Balances, token.Hex())
		return
	}
	cp := v
	s.Balances[token.Hex()] = &cp
}

// credit adds to a token balance.
func (s *Strategy) credit(token types.Address, amount types.Uint256) error {
	next, err := Add(s.Balance(token), amount)
	if err != nil {
		return err
	}
	s.setBalance(token, next)
	return nil
}

// debit subtracts from a token balance, failing rather than going negative.
func (s *Strategy) debit(token types.Address, amount types.Uint256) error {
	cur := s.Balance(token)
	if cur.Cmp(amount) < 0 {
		return ErrInsufficientFunds
	}
	next, err := Sub(cur, amount)
	if err != nil {
		return err
	}
	s.setBalance(token, next)
	return nil
}

// Account is a depositor's position in the pool. Which strategies they back,
// and in what size, is confidential.
type Account struct {
	Address types.Address `json:"address"`

	// Unallocated is deposited value not yet assigned to a strategy, keyed by
	// token hex.
	Unallocated map[string]*types.Uint256 `json:"unallocated"`

	// Shares maps strategy ID to shares held.
	Shares map[string]*types.Uint256 `json:"shares"`
}

// ShareBalance returns the account's shares in a strategy, or zero.
func (a *Account) ShareBalance(strategyID string) types.Uint256 {
	if s, ok := a.Shares[strategyID]; ok && s != nil {
		return *s
	}
	return types.Uint256{}
}

func (a *Account) setShares(strategyID string, v types.Uint256) {
	if v.IsZero() {
		delete(a.Shares, strategyID)
		return
	}
	cp := v
	a.Shares[strategyID] = &cp
}

// UnallocatedBalance returns idle deposited value in a token, or zero.
func (a *Account) UnallocatedBalance(token types.Address) types.Uint256 {
	if b, ok := a.Unallocated[token.Hex()]; ok && b != nil {
		return *b
	}
	return types.Uint256{}
}

func (a *Account) setUnallocated(token types.Address, v types.Uint256) {
	if v.IsZero() {
		delete(a.Unallocated, token.Hex())
		return
	}
	cp := v
	a.Unallocated[token.Hex()] = &cp
}

// OpenBatch is a batch that has been sent to market and is awaiting settlement
// through trusted_request. Keeping the plan here is what lets settlement be
// idempotent: the entry is deleted on first settlement, so a replayed
// TRUSTPROCESS finds nothing and errors instead of paying out twice.
type OpenBatch struct {
	ID   string    `json:"id"`
	Plan BatchPlan `json:"plan"`
}

// ApplicationInternalState is the whole confidential state of the vault. Vela
// hands it to the guest as JSON on every call and encrypts the result with the
// enclave's AES key before it is stored, so nothing here is ever in the clear
// outside the enclave.
type ApplicationInternalState struct {
	AppID uint64 `json:"appId"`

	// TriggerAddress is the companion contract that executes orders. Stamped
	// into every withdrawal so the platform routes funds to it.
	TriggerAddress string `json:"triggerAddress"`

	// QuoteToken is the asset deposits and NAV are denominated in.
	QuoteToken types.Address `json:"quoteToken"`

	Config NettingConfig `json:"config"`

	Strategies map[string]*Strategy `json:"strategies"`
	Accounts   map[string]*Account  `json:"accounts"`

	// Pending holds intents accepted but not yet netted.
	Pending []Intent `json:"pending"`

	// Open holds batches awaiting settlement, keyed by batch ID.
	Open map[string]*OpenBatch `json:"open"`

	// BatchNonce derives deterministic batch IDs. The enclave has no clock and
	// no randomness, so every identifier must come from state.
	BatchNonce uint64 `json:"batchNonce"`

	// IntentNonce derives deterministic intent IDs, for the same reason.
	IntentNonce uint64 `json:"intentNonce"`
}

// NewState builds an empty state.
func NewState(appID uint64, trigger string, quote types.Address, cfg NettingConfig) *ApplicationInternalState {
	return &ApplicationInternalState{
		AppID:          appID,
		TriggerAddress: trigger,
		QuoteToken:     quote,
		Config:         cfg,
		Strategies:     make(map[string]*Strategy),
		Accounts:       make(map[string]*Account),
		Open:           make(map[string]*OpenBatch),
	}
}

// Strategy looks up a strategy by ID.
func (st *ApplicationInternalState) Strategy(id string) (*Strategy, error) {
	s, ok := st.Strategies[id]
	if !ok || s == nil {
		return nil, ErrUnknownStrategy
	}
	return s, nil
}

// Account returns an account, creating it on first use.
func (st *ApplicationInternalState) Account(addr types.Address) *Account {
	a, ok := st.Accounts[addr.Hex()]
	if ok && a != nil {
		return a
	}
	a = &Account{
		Address:     addr,
		Unallocated: make(map[string]*types.Uint256),
		Shares:      make(map[string]*types.Uint256),
	}
	st.Accounts[addr.Hex()] = a
	return a
}

// SortedStrategyIDs returns strategy IDs in a stable order.
//
// Go randomises map iteration order. Inside a Vela guest that is not merely
// untidy: any output that depends on iteration order would differ between runs,
// producing a different state root and breaking consensus with the chain. Every
// traversal whose order can reach the output must go through a sort like this.
func (st *ApplicationInternalState) SortedStrategyIDs() []string {
	ids := make([]string, 0, len(st.Strategies))
	for id := range st.Strategies {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// SortedAccountKeys returns account keys in a stable order, for the same reason.
func (st *ApplicationInternalState) SortedAccountKeys() []string {
	keys := make([]string, 0, len(st.Accounts))
	for k := range st.Accounts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// sortedBalanceKeys returns a strategy's token keys in a stable order.
func sortedBalanceKeys(m map[string]*types.Uint256) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// PriceSet maps token hex to a fixed-point price quoted in the vault's quote
// asset. The enclave cannot fetch prices itself, so they are supplied with the
// request that needs them.
type PriceSet map[string]types.Uint256

// Price returns the price of a token, or false if absent. The quote asset is
// always worth exactly one unit of itself.
func (p PriceSet) Price(token types.Address, quote types.Address) (types.Uint256, bool) {
	if token == quote {
		return One(), true
	}
	v, ok := p[token.Hex()]
	return v, ok
}

// NAV values a strategy's holdings in quote terms.
//
// Every held token must have a price. Silently skipping an unpriced holding
// would understate NAV and hand new depositors shares too cheaply, so a missing
// price is an error rather than a zero.
func (st *ApplicationInternalState) NAV(s *Strategy, prices PriceSet) (types.Uint256, error) {
	var total types.Uint256

	for _, key := range sortedBalanceKeys(s.Balances) {
		bal := s.Balances[key]
		if bal == nil || bal.IsZero() {
			continue
		}

		token, err := types.HexToAddress(key)
		if err != nil {
			return types.Uint256{}, err
		}

		price, ok := prices.Price(token, st.QuoteToken)
		if !ok {
			return types.Uint256{}, ErrMissingPrice
		}

		value, err := ApplyPrice(*bal, price)
		if err != nil {
			return types.Uint256{}, err
		}

		total, err = Add(total, value)
		if err != nil {
			return types.Uint256{}, err
		}
	}

	return total, nil
}
