package app

import (
	"errors"
	"sort"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

var (
	ErrNoSuchBatch      = errors.New("unknown or already-settled batch")
	ErrOverfilled       = errors.New("market reported a larger fill than was requested")
	ErrQuoteWithoutBase = errors.New("market reported quote moved with no base filled")
	ErrNoWeights        = errors.New("cannot distribute across zero total weight")
)

// MarketFill is what the trigger contract reports back about the residual order
// after it has executed. It arrives through trusted_request as clear text: the
// trigger produced it on chain, so it is not encrypted to the enclave.
type MarketFill struct {
	// Base is how much of the base asset actually traded.
	Base types.Uint256 `json:"base"`
	// Quote is how much of the quote asset changed hands for it.
	Quote types.Uint256 `json:"quote"`
	// Success is false when the on-chain call reverted, in which case the
	// platform swept the full amount back and nothing traded.
	Success bool `json:"success"`
}

// Fill is one intent's outcome.
type Fill struct {
	IntentID   string        `json:"intentId"`
	StrategyID string        `json:"strategyId"`
	Side       Side          `json:"side"`
	Base       types.Uint256 `json:"base"`  // base units received (buy) or given up (sell)
	Quote      types.Uint256 `json:"quote"` // quote units paid (buy) or received (sell)
}

// Settlement is the complete result of a batch.
type Settlement struct {
	BatchID string `json:"batchId"`

	// ClearingPrice is the price every participant settles at.
	ClearingPrice types.Uint256 `json:"clearingPrice"`

	// CrossedBase is the volume that matched internally and never went to
	// market. MarketBase and MarketQuote are the market leg as executed.
	CrossedBase types.Uint256 `json:"crossedBase"`
	MarketBase  types.Uint256 `json:"marketBase"`
	MarketQuote types.Uint256 `json:"marketQuote"`

	Fills []Fill `json:"fills"`

	// Unfilled is base volume the larger side wanted but did not get, because
	// the market filled less than the residual.
	Unfilled types.Uint256 `json:"unfilled"`

	// LimitBreached is set when the realised price is worse than the tightest
	// limit price in the batch. The trigger's on-chain slippage bound is what
	// actually prevents this; the flag exists to surface a failure of it, since
	// by the time the enclave sees the fill the trade has already happened.
	LimitBreached bool `json:"limitBreached"`
}

// SettleBatch turns an executed market fill into per-intent fills.
//
// The clearing price is the price the market actually gave, and every
// participant settles at it — including the volume that crossed internally and
// never reached the market. That is not an arbitrary choice: it is the only
// price at which the pool's books balance exactly. With a clearing price P, the
// net quote the pool must find is filledBase * P, and the quote it actually
// paid or received is filledQuote, so P = filledQuote / filledBase.
//
// Settling everyone at one price is also a privacy property. If crossed and
// market-executed participants received different prices, each could tell from
// their own fill which group they were in, and so learn something about the
// rest of the batch.
//
// When the market leg fails or is empty, the crossed volume still settles, at
// the reference price. Internal matching has no external dependency, so a failed
// market call costs the crossed participants nothing.
func SettleBatch(plan *BatchPlan, batchID string, fill MarketFill) (*Settlement, error) {
	if plan == nil {
		return nil, ErrNoSuchBatch
	}

	marketBase := fill.Base
	marketQuote := fill.Quote

	// A reverted call moved nothing, whatever it reported.
	if !fill.Success {
		marketBase = types.Uint256{}
		marketQuote = types.Uint256{}
	}
	if marketBase.IsZero() && !marketQuote.IsZero() {
		return nil, ErrQuoteWithoutBase
	}
	if marketBase.Cmp(plan.ResidualBase) > 0 {
		return nil, ErrOverfilled
	}

	settlement := &Settlement{
		BatchID:     batchID,
		CrossedBase: plan.CrossedBase,
		MarketBase:  marketBase,
		MarketQuote: marketQuote,
	}

	// Derive the clearing price.
	if marketBase.IsZero() {
		settlement.ClearingPrice = plan.RefPrice
	} else {
		p, err := UnapplyPrice(marketQuote, marketBase)
		if err != nil {
			return nil, err
		}
		settlement.ClearingPrice = p
	}

	buys, sells := splitBySide(plan.Included)

	// The smaller side is fully satisfied by the cross; the larger side shares
	// the cross plus whatever the market supplied.
	var larger, smaller []Intent
	if plan.ResidualSide == SideBuy {
		larger, smaller = buys, sells
	} else {
		larger, smaller = sells, buys
	}

	largerAvailable, err := Add(plan.CrossedBase, marketBase)
	if err != nil {
		return nil, err
	}

	smallerFills := fullFills(smaller)
	largerFills, err := proRataFills(larger, largerAvailable)
	if err != nil {
		return nil, err
	}

	largerWanted := totalAmount(larger)
	unfilled, err := Sub(largerWanted, largerAvailable)
	if err != nil {
		return nil, err
	}
	settlement.Unfilled = unfilled

	// Price the two sides so that quote is conserved to the last unit.
	//
	// The side that did not need the market settles cleanly at the clearing
	// price. The side that did absorbs the integer remainder of the market's
	// execution, because that remainder is a property of their leg. The
	// difference is at most a few units.
	sideFills, err := priceSides(settlement.ClearingPrice, marketQuote, largerFills, smallerFills)
	if err != nil {
		return nil, err
	}
	settlement.Fills = sideFills

	settlement.LimitBreached = breachesAnyLimit(plan.Included, settlement.ClearingPrice)

	return settlement, nil
}

// splitBySide separates intents, preserving a deterministic order.
func splitBySide(intents []Intent) (buys, sells []Intent) {
	ordered := make([]Intent, len(intents))
	copy(ordered, intents)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ID < ordered[j].ID })

	for _, in := range ordered {
		if in.Side == SideBuy {
			buys = append(buys, in)
		} else {
			sells = append(sells, in)
		}
	}
	return buys, sells
}

func totalAmount(intents []Intent) types.Uint256 {
	var total types.Uint256
	for _, in := range intents {
		if in.Amount == nil {
			continue
		}
		next, err := Add(total, *in.Amount)
		if err != nil {
			return total
		}
		total = next
	}
	return total
}

// fullFills gives every intent exactly what it asked for.
func fullFills(intents []Intent) []Fill {
	fills := make([]Fill, 0, len(intents))
	for _, in := range intents {
		amount := types.Uint256{}
		if in.Amount != nil {
			amount = *in.Amount
		}
		fills = append(fills, Fill{
			IntentID:   in.ID,
			StrategyID: in.StrategyID,
			Side:       in.Side,
			Base:       amount,
		})
	}
	return fills
}

// proRataFills splits `available` across intents in proportion to their size.
func proRataFills(intents []Intent, available types.Uint256) ([]Fill, error) {
	weights := make([]types.Uint256, len(intents))
	for i, in := range intents {
		if in.Amount != nil {
			weights[i] = *in.Amount
		}
	}

	shares, err := distribute(available, weights)
	if err != nil {
		return nil, err
	}

	fills := make([]Fill, 0, len(intents))
	for i, in := range intents {
		fills = append(fills, Fill{
			IntentID:   in.ID,
			StrategyID: in.StrategyID,
			Side:       in.Side,
			Base:       shares[i],
		})
	}
	return fills, nil
}

// distribute splits a total across weights so the parts sum to exactly the
// total, with no unit created or lost.
//
// Proportional shares round down, which leaves a remainder smaller than the
// number of recipients. Those leftover units are handed out one each, in order,
// which is deterministic and bounded. The enclave has no randomness to break
// ties with, and any order-dependence that reached the output would change the
// state root, so a fixed rule is required rather than merely tidy.
func distribute(total types.Uint256, weights []types.Uint256) ([]types.Uint256, error) {
	out := make([]types.Uint256, len(weights))
	if len(weights) == 0 || total.IsZero() {
		return out, nil
	}

	var sum types.Uint256
	for _, w := range weights {
		next, err := Add(sum, w)
		if err != nil {
			return nil, err
		}
		sum = next
	}
	if sum.IsZero() {
		return nil, ErrNoWeights
	}

	var allocated types.Uint256
	for i, w := range weights {
		share, err := MulDiv(total, w, sum)
		if err != nil {
			return nil, err
		}
		out[i] = share

		next, err := Add(allocated, share)
		if err != nil {
			return nil, err
		}
		allocated = next
	}

	remainder, err := Sub(total, allocated)
	if err != nil {
		return nil, err
	}

	one := *types.NewUint256(1)
	for i := 0; i < len(out) && !remainder.IsZero(); i++ {
		// Only recipients with a claim receive dust.
		if weights[i].IsZero() {
			continue
		}
		bumped, err := Add(out[i], one)
		if err != nil {
			return nil, err
		}
		out[i] = bumped

		remainder, err = Sub(remainder, one)
		if err != nil {
			return nil, err
		}
	}

	return out, nil
}

// priceSides assigns quote amounts so that quote is conserved exactly:
// what buyers pay equals what sellers receive plus what the market took (or
// minus what the market paid us).
func priceSides(
	clearingPrice types.Uint256,
	marketQuote types.Uint256,
	largerFills, smallerFills []Fill,
) ([]Fill, error) {
	// The smaller side settles cleanly at the clearing price.
	var smallerTotal types.Uint256
	for i := range smallerFills {
		q, err := ApplyPrice(smallerFills[i].Base, clearingPrice)
		if err != nil {
			return nil, err
		}
		smallerFills[i].Quote = q

		next, err := Add(smallerTotal, q)
		if err != nil {
			return nil, err
		}
		smallerTotal = next
	}

	// The larger side's total is pinned by conservation, and the arithmetic is
	// the same in both directions. With a buy residual, buyers fund the sellers
	// plus the market purchase. With a sell residual, sellers are paid by the
	// buyers plus the proceeds of the market sale.
	largerTotal, err := Add(smallerTotal, marketQuote)
	if err != nil {
		return nil, err
	}

	weights := make([]types.Uint256, len(largerFills))
	for i := range largerFills {
		weights[i] = largerFills[i].Base
	}

	quotes, err := distribute(largerTotal, weights)
	if err != nil && err != ErrNoWeights {
		return nil, err
	}
	if err == nil {
		for i := range largerFills {
			largerFills[i].Quote = quotes[i]
		}
	}

	all := make([]Fill, 0, len(largerFills)+len(smallerFills))
	all = append(all, largerFills...)
	all = append(all, smallerFills...)
	sort.Slice(all, func(i, j int) bool { return all[i].IntentID < all[j].IntentID })
	return all, nil
}

// breachesAnyLimit reports whether the realised price is worse than any
// participant's stated limit.
func breachesAnyLimit(intents []Intent, clearingPrice types.Uint256) bool {
	for _, in := range intents {
		if in.LimitPrice == nil || in.LimitPrice.IsZero() {
			continue
		}
		if !limitSatisfied(in, clearingPrice) {
			return true
		}
	}
	return false
}

// ErrTriggerOverspent means the trigger reported spending more quote than it was
// given. Its on-chain bound makes that impossible, so reaching it means the
// trigger is not behaving as deployed.
var ErrTriggerOverspent = errors.New("trigger reported spending more than its quote bound")

// CreditSweep mirrors the tokens the trigger's sweep returns to the endpoint.
//
// When a batch goes to market the endpoint hands the trigger one token, and after
// executing, the trigger sweeps back everything it holds: whatever of that token
// went unspent, plus whatever it bought. The endpoint re-credits all of it to the
// app. A failed leg is the same arithmetic with nothing traded — everything sent
// comes straight back.
//
// This assumes the sweep succeeded. A token whose transfer back fails stays in
// the trigger, and the mirror would then overstate custody. That needs a token
// that refuses transfers, and is recorded as a known gap.
func (st *ApplicationInternalState) CreditSweep(plan *BatchPlan, quoteLimit types.Uint256, s *Settlement) error {
	if plan.ResidualSide == SideBuy {
		if s.MarketQuote.Cmp(quoteLimit) > 0 {
			return ErrTriggerOverspent
		}
		unspent, err := Sub(quoteLimit, s.MarketQuote)
		if err != nil {
			return err
		}
		if err := st.addCustody(plan.Quote, unspent); err != nil {
			return err
		}
		return st.addCustody(plan.Base, s.MarketBase)
	}

	unsold, err := Sub(plan.ResidualBase, s.MarketBase)
	if err != nil {
		return err
	}
	if err := st.addCustody(plan.Base, unsold); err != nil {
		return err
	}
	return st.addCustody(plan.Quote, s.MarketQuote)
}

// ApplySettlement moves the settled amounts through the confidential ledger.
//
// Base and quote move in opposite directions per side. A buy consumes quote the
// strategy already holds — its affordability was checked against the intent's
// limit price when the intent was accepted, which is why that limit is required.
func (st *ApplicationInternalState) ApplySettlement(plan *BatchPlan, s *Settlement) error {
	for _, f := range s.Fills {
		if f.Base.IsZero() && f.Quote.IsZero() {
			continue
		}

		strat, err := st.Strategy(f.StrategyID)
		if err != nil {
			return err
		}

		if f.Side == SideBuy {
			if err := strat.debit(st.QuoteToken, f.Quote); err != nil {
				return err
			}
			if err := strat.credit(plan.Base, f.Base); err != nil {
				return err
			}
			continue
		}

		if err := strat.debit(plan.Base, f.Base); err != nil {
			return err
		}
		if err := strat.credit(st.QuoteToken, f.Quote); err != nil {
			return err
		}
	}
	return nil
}
