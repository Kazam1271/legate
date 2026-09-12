package app

import (
	"errors"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

// Side is the direction of an intent, expressed in base-asset terms.
type Side uint8

const (
	// SideBuy acquires the base asset, paying in the quote asset.
	SideBuy Side = 0
	// SideSell disposes of the base asset, receiving the quote asset.
	SideSell Side = 1
)

func (s Side) String() string {
	if s == SideBuy {
		return "buy"
	}
	return "sell"
}

// Opposite returns the other side.
func (s Side) Opposite() Side {
	if s == SideBuy {
		return SideSell
	}
	return SideBuy
}

var (
	// ErrEmptyBatch is returned when a batch contains no executable intents.
	ErrEmptyBatch = errors.New("batch contains no executable intents")
	// ErrInsufficientAnonymity is returned when too few distinct strategies
	// contributed to a batch for netting to hide any of them.
	ErrInsufficientAnonymity = errors.New("batch has too few contributing strategies to preserve privacy")
	// ErrZeroPrice is returned when a reference price of zero is supplied.
	ErrZeroPrice = errors.New("reference price must be non-zero")
	// ErrMixedPair is returned when a batch mixes token pairs.
	ErrMixedPair = errors.New("all intents in a batch must share one token pair")
)

// Intent is a single strategy's desired trade. It arrives encrypted and is only
// ever in the clear inside the enclave. Amounts are denominated in the base
// asset for both sides, which is what makes opposing flow directly nettable.
type Intent struct {
	// ID is unique within a batch and is used to report fills back.
	ID string `json:"id"`
	// StrategyID identifies the contributing strategy. Never leaves the enclave.
	StrategyID string `json:"strategyId"`

	Base  types.Address `json:"base"`
	Quote types.Address `json:"quote"`

	Side   Side           `json:"side"`
	Amount *types.Uint256 `json:"amount"` // base units

	// LimitPrice is the worst acceptable price in fixed point (quote per base).
	// For a buy this is a maximum, for a sell a minimum. Zero means no limit.
	LimitPrice *types.Uint256 `json:"limitPrice"`
}

// NettingConfig carries the privacy and hygiene parameters for batch formation.
type NettingConfig struct {
	// MinContributors is the k in the k-anonymity guarantee: a batch whose
	// residual goes on chain must contain intents from at least this many
	// distinct strategies, so the public order can never be attributed to one.
	MinContributors int `json:"minContributors"`

	// MinResidual suppresses dust residuals. A residual at or below this is
	// treated as fully internalised rather than sent to the market.
	MinResidual *types.Uint256 `json:"minResidual"`
}

// ExclusionReason explains why an intent did not make it into a batch.
type ExclusionReason string

const (
	ReasonLimitPrice   ExclusionReason = "limit_price_not_met"
	ReasonZeroAmount   ExclusionReason = "zero_amount"
	ReasonWrongPair    ExclusionReason = "wrong_pair"
	ReasonMissingField ExclusionReason = "missing_field"
)

// ExcludedIntent records an intent that was dropped during batch formation.
type ExcludedIntent struct {
	ID     string          `json:"id"`
	Reason ExclusionReason `json:"reason"`
}

// BatchPlan is the result of netting. Only ResidualSide and ResidualBase ever
// become publicly visible; everything else stays inside the enclave.
type BatchPlan struct {
	Base  types.Address `json:"base"`
	Quote types.Address `json:"quote"`

	RefPrice types.Uint256 `json:"refPrice"`

	TotalBuy  types.Uint256 `json:"totalBuy"`
	TotalSell types.Uint256 `json:"totalSell"`

	// CrossedBase is volume matched strategy-against-strategy inside the
	// enclave. It never touches the market: no slippage, no fee, no footprint.
	CrossedBase types.Uint256 `json:"crossedBase"`

	// ResidualSide and ResidualBase describe the single order sent to market.
	ResidualSide Side          `json:"residualSide"`
	ResidualBase types.Uint256 `json:"residualBase"`

	// FullyInternalised is true when the batch cleared entirely against itself
	// and nothing at all was sent on chain.
	FullyInternalised bool `json:"fullyInternalised"`

	Included     []Intent         `json:"included"`
	Excluded     []ExcludedIntent `json:"excluded"`
	Contributors int              `json:"contributors"`
}

// NetBatch matches opposing intents against each other at a reference price and
// returns the single residual order that must be executed on the market.
//
// This is the heart of Legate's privacy model. An observer of the chain sees
// one order of size |buy - sell| on behalf of the pool. They cannot recover the
// individual strategy orders that produced it, because many different sets of
// intents net to the same residual. Volume that crosses internally is not
// merely hidden, it never reaches the market at all.
//
// The guarantee is only real when several strategies contribute: with a single
// contributor the residual is that strategy's order. MinContributors enforces
// this, and NetBatch refuses to produce a marketable plan below it.
func NetBatch(intents []Intent, refPrice types.Uint256, cfg NettingConfig) (*BatchPlan, error) {
	if refPrice.IsZero() {
		return nil, ErrZeroPrice
	}
	if len(intents) == 0 {
		return nil, ErrEmptyBatch
	}

	base := intents[0].Base
	quote := intents[0].Quote

	plan := &BatchPlan{
		Base:     base,
		Quote:    quote,
		RefPrice: refPrice,
	}

	contributors := make(map[string]struct{})
	var totalBuy, totalSell types.Uint256

	for _, in := range intents {
		switch {
		case in.Amount == nil || in.LimitPrice == nil:
			plan.Excluded = append(plan.Excluded, ExcludedIntent{ID: in.ID, Reason: ReasonMissingField})
			continue
		case in.Base != base || in.Quote != quote:
			plan.Excluded = append(plan.Excluded, ExcludedIntent{ID: in.ID, Reason: ReasonWrongPair})
			continue
		case in.Amount.IsZero():
			plan.Excluded = append(plan.Excluded, ExcludedIntent{ID: in.ID, Reason: ReasonZeroAmount})
			continue
		case !limitSatisfied(in, refPrice):
			plan.Excluded = append(plan.Excluded, ExcludedIntent{ID: in.ID, Reason: ReasonLimitPrice})
			continue
		}

		var err error
		if in.Side == SideBuy {
			totalBuy, err = Add(totalBuy, *in.Amount)
		} else {
			totalSell, err = Add(totalSell, *in.Amount)
		}
		if err != nil {
			return nil, err
		}

		contributors[in.StrategyID] = struct{}{}
		plan.Included = append(plan.Included, in)
	}

	if len(plan.Included) == 0 {
		return nil, ErrEmptyBatch
	}

	plan.TotalBuy = totalBuy
	plan.TotalSell = totalSell
	plan.Contributors = len(contributors)
	plan.CrossedBase = Min(totalBuy, totalSell)

	// The residual is the imbalance: the only part the market ever sees.
	var residual types.Uint256
	var err error
	if totalBuy.Cmp(totalSell) >= 0 {
		plan.ResidualSide = SideBuy
		residual, err = Sub(totalBuy, totalSell)
	} else {
		plan.ResidualSide = SideSell
		residual, err = Sub(totalSell, totalBuy)
	}
	if err != nil {
		return nil, err
	}

	// Dust residuals are internalised rather than broadcast: a tiny public
	// order is both uneconomic and unusually identifying.
	dust := residual.IsZero()
	if !dust && cfg.MinResidual != nil {
		dust = residual.Cmp(*cfg.MinResidual) <= 0
	}
	if dust {
		plan.ResidualBase = types.Uint256{}
		plan.FullyInternalised = true
		return plan, nil
	}

	plan.ResidualBase = residual

	// A residual that would go to market must be hidden behind enough
	// contributors to be unattributable.
	if plan.Contributors < cfg.MinContributors {
		return nil, ErrInsufficientAnonymity
	}

	return plan, nil
}

// ErrNoPriceBound is returned when a batch would go to market with nothing
// bounding its execution price.
var ErrNoPriceBound = errors.New("batch has no price bound: set limit prices or a slippage tolerance")

const bpsDenominator = 10_000

// QuoteLimitFor computes the bound the trigger contract must enforce on chain.
//
// For a buy it is the most quote that may be spent; for a sell the least that
// must be received. This is the real protection against a bad fill: the enclave
// checks limit prices against the reference price before execution, but only
// learns the realised price afterwards, when the trade has already happened.
//
// The bound is taken from the tightest participant limit in the *whole* batch,
// not just the side going to market. Everyone settles at one clearing price, so
// a bad fill on the residual can breach the limit of someone who only crossed.
func QuoteLimitFor(plan *BatchPlan, slippageBps uint32) (types.Uint256, error) {
	bound, ok := priceBound(plan, slippageBps)
	if !ok {
		return types.Uint256{}, ErrNoPriceBound
	}
	return ApplyPrice(plan.ResidualBase, bound)
}

// priceBound returns the worst price the batch may execute at, and whether any
// bound exists at all.
func priceBound(plan *BatchPlan, slippageBps uint32) (types.Uint256, bool) {
	buying := plan.ResidualSide == SideBuy

	var bound types.Uint256
	found := false

	// Buyers cap the price from above, sellers floor it from below. Take the
	// tightest limit stated by anyone in the batch.
	for _, in := range plan.Included {
		if in.LimitPrice == nil || in.LimitPrice.IsZero() {
			continue
		}
		if buying && in.Side != SideBuy {
			continue
		}
		if !buying && in.Side != SideSell {
			continue
		}
		if !found {
			bound, found = *in.LimitPrice, true
			continue
		}
		if buying && in.LimitPrice.Cmp(bound) < 0 {
			bound = *in.LimitPrice // lowest ceiling wins
		}
		if !buying && in.LimitPrice.Cmp(bound) > 0 {
			bound = *in.LimitPrice // highest floor wins
		}
	}

	// A slippage tolerance around the reference price applies as well, and the
	// tighter of the two wins.
	if slippageBps > 0 {
		if tol, err := toleranceBound(plan.RefPrice, slippageBps, buying); err == nil {
			if !found {
				return tol, true
			}
			if buying && tol.Cmp(bound) < 0 {
				bound = tol
			}
			if !buying && tol.Cmp(bound) > 0 {
				bound = tol
			}
		}
	}

	return bound, found
}

// toleranceBound applies a basis-point tolerance to the reference price.
func toleranceBound(refPrice types.Uint256, bps uint32, buying bool) (types.Uint256, error) {
	factor := types.NewUint256(uint64(bpsDenominator))
	if buying {
		factor.Add64(uint64(bps))
	} else {
		if uint64(bps) >= bpsDenominator {
			return types.Uint256{}, ErrNoPriceBound
		}
		factor = types.NewUint256(uint64(bpsDenominator - uint64(bps)))
	}
	return MulDiv(refPrice, *factor, *types.NewUint256(bpsDenominator))
}

// limitSatisfied reports whether an intent's limit price permits execution at
// the reference price. A zero limit means the intent is unconditional.
func limitSatisfied(in Intent, refPrice types.Uint256) bool {
	if in.LimitPrice.IsZero() {
		return true
	}
	if in.Side == SideBuy {
		// A buyer accepts any price at or below their limit.
		return refPrice.Cmp(*in.LimitPrice) <= 0
	}
	// A seller accepts any price at or above their limit.
	return refPrice.Cmp(*in.LimitPrice) >= 0
}
