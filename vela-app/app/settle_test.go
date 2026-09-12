package app

import (
	"testing"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

func planFrom(t *testing.T, intents []Intent, refPrice types.Uint256) *BatchPlan {
	t.Helper()
	plan, err := NetBatch(intents, refPrice, defaultCfg())
	if err != nil {
		t.Fatalf("NetBatch: %v", err)
	}
	return plan
}

// sumSide totals the base and quote across one side of a settlement.
func sumSide(t *testing.T, s *Settlement, side Side) (base, quote types.Uint256) {
	t.Helper()
	for _, f := range s.Fills {
		if f.Side != side {
			continue
		}
		var err error
		if base, err = Add(base, f.Base); err != nil {
			t.Fatalf("Add: %v", err)
		}
		if quote, err = Add(quote, f.Quote); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}
	return base, quote
}

// assertConserved checks that the vault neither created nor destroyed value.
// Whatever the buyers received in base must equal what the sellers gave plus
// what the market supplied, and the same must hold for quote in the opposite
// direction.
func assertConserved(t *testing.T, plan *BatchPlan, s *Settlement) {
	t.Helper()

	buyBase, buyQuote := sumSide(t, s, SideBuy)
	sellBase, sellQuote := sumSide(t, s, SideSell)

	var wantBase, wantQuote types.Uint256
	var err error

	if plan.ResidualSide == SideBuy {
		if wantBase, err = Add(sellBase, s.MarketBase); err != nil {
			t.Fatalf("Add: %v", err)
		}
		if wantQuote, err = Add(sellQuote, s.MarketQuote); err != nil {
			t.Fatalf("Add: %v", err)
		}
		if !buyBase.Eq(wantBase) {
			t.Fatalf("base not conserved: buyers got %s, sellers+market supplied %s", buyBase.String(), wantBase.String())
		}
		if !buyQuote.Eq(wantQuote) {
			t.Fatalf("quote not conserved: buyers paid %s, sellers+market received %s", buyQuote.String(), wantQuote.String())
		}
		return
	}

	if wantBase, err = Add(buyBase, s.MarketBase); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if wantQuote, err = Add(buyQuote, s.MarketQuote); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if !sellBase.Eq(wantBase) {
		t.Fatalf("base not conserved: sellers gave %s, buyers+market absorbed %s", sellBase.String(), wantBase.String())
	}
	if !sellQuote.Eq(wantQuote) {
		t.Fatalf("quote not conserved: sellers received %s, buyers+market paid %s", sellQuote.String(), wantQuote.String())
	}
}

// The clearing price must be exactly what the market gave, since that is the
// only price at which the pool's books balance.
func TestSettleClearingPriceIsTheMarketPrice(t *testing.T) {
	refPrice := price(t, 3_000)
	plan := planFrom(t, []Intent{
		intent("i1", "alpha", SideBuy, 100),
		intent("i2", "beta", SideSell, 60),
	}, refPrice)

	// The market filled the 40 residual at 3100, worse than the reference.
	marketQuote, err := ApplyPrice(u64(40), price(t, 3_100))
	if err != nil {
		t.Fatalf("ApplyPrice: %v", err)
	}

	s, err := SettleBatch(plan, "batch-1", MarketFill{Base: u64(40), Quote: marketQuote, Success: true})
	if err != nil {
		t.Fatalf("SettleBatch: %v", err)
	}

	if !s.ClearingPrice.Eq(price(t, 3_100)) {
		t.Fatalf("clearing price = %s, want 3100e18", s.ClearingPrice.String())
	}
	assertConserved(t, plan, s)
}

func TestSettleConservesWithBuyResidual(t *testing.T) {
	refPrice := price(t, 3_000)
	plan := planFrom(t, []Intent{
		intent("i1", "alpha", SideBuy, 800),
		intent("i2", "beta", SideBuy, 150),
		intent("i3", "gamma", SideSell, 400),
		intent("i4", "delta", SideSell, 90),
	}, refPrice)

	// residual = 950 - 490 = 460
	if !plan.ResidualBase.Eq(u64(460)) || plan.ResidualSide != SideBuy {
		t.Fatalf("unexpected plan: side=%s residual=%s", plan.ResidualSide, plan.ResidualBase.String())
	}

	marketQuote, err := ApplyPrice(u64(460), refPrice)
	if err != nil {
		t.Fatalf("ApplyPrice: %v", err)
	}

	s, err := SettleBatch(plan, "batch-1", MarketFill{Base: u64(460), Quote: marketQuote, Success: true})
	if err != nil {
		t.Fatalf("SettleBatch: %v", err)
	}

	assertConserved(t, plan, s)

	// Sellers are fully filled; they are the smaller side.
	sellBase, _ := sumSide(t, s, SideSell)
	if !sellBase.Eq(u64(490)) {
		t.Fatalf("sellers filled %s, want 490", sellBase.String())
	}
	if !s.Unfilled.IsZero() {
		t.Fatalf("unfilled = %s, want 0", s.Unfilled.String())
	}
}

func TestSettleConservesWithSellResidual(t *testing.T) {
	refPrice := price(t, 3_000)
	plan := planFrom(t, []Intent{
		intent("i1", "alpha", SideSell, 700),
		intent("i2", "beta", SideSell, 200),
		intent("i3", "gamma", SideBuy, 300),
	}, refPrice)

	if plan.ResidualSide != SideSell || !plan.ResidualBase.Eq(u64(600)) {
		t.Fatalf("unexpected plan: side=%s residual=%s", plan.ResidualSide, plan.ResidualBase.String())
	}

	marketQuote, err := ApplyPrice(u64(600), refPrice)
	if err != nil {
		t.Fatalf("ApplyPrice: %v", err)
	}

	s, err := SettleBatch(plan, "batch-1", MarketFill{Base: u64(600), Quote: marketQuote, Success: true})
	if err != nil {
		t.Fatalf("SettleBatch: %v", err)
	}

	assertConserved(t, plan, s)

	// Buyers are the smaller side and are fully filled.
	buyBase, _ := sumSide(t, s, SideBuy)
	if !buyBase.Eq(u64(300)) {
		t.Fatalf("buyers filled %s, want 300", buyBase.String())
	}
}

// When the market fills less than the residual, the shortfall lands on the
// larger side pro-rata and is reported.
func TestSettlePartialFillIsProRataAcrossTheLargerSide(t *testing.T) {
	refPrice := price(t, 3_000)
	plan := planFrom(t, []Intent{
		intent("i1", "alpha", SideBuy, 600),
		intent("i2", "beta", SideBuy, 200),
		intent("i3", "gamma", SideSell, 100),
	}, refPrice)

	// residual is 700; the market only manages 350.
	marketQuote, err := ApplyPrice(u64(350), refPrice)
	if err != nil {
		t.Fatalf("ApplyPrice: %v", err)
	}

	s, err := SettleBatch(plan, "batch-1", MarketFill{Base: u64(350), Quote: marketQuote, Success: true})
	if err != nil {
		t.Fatalf("SettleBatch: %v", err)
	}

	assertConserved(t, plan, s)

	if !s.Unfilled.Eq(u64(350)) {
		t.Fatalf("unfilled = %s, want 350", s.Unfilled.String())
	}

	// Buyers share crossed (100) + market (350) = 450, split 600:200.
	byID := fillsByID(s)
	if !byID["i1"].Base.Eq(u64(337)) && !byID["i1"].Base.Eq(u64(338)) {
		t.Fatalf("i1 base = %s, want ~337.5", byID["i1"].Base.String())
	}
	total, err := Add(byID["i1"].Base, byID["i2"].Base)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if !total.Eq(u64(450)) {
		t.Fatalf("buyer fills total %s, want exactly 450", total.String())
	}

	// The seller is on the smaller side and is untouched by the shortfall.
	if !byID["i3"].Base.Eq(u64(100)) {
		t.Fatalf("i3 base = %s, want 100", byID["i3"].Base.String())
	}
}

// Internal matching has no external dependency, so a reverted market call still
// lets the crossed volume settle. That is a real benefit of netting, not just a
// privacy device.
func TestSettleFailedMarketLegStillSettlesTheCross(t *testing.T) {
	refPrice := price(t, 3_000)
	plan := planFrom(t, []Intent{
		intent("i1", "alpha", SideBuy, 500),
		intent("i2", "beta", SideSell, 300),
	}, refPrice)

	// The trigger reports a revert. Anything it claims moved is ignored.
	s, err := SettleBatch(plan, "batch-1", MarketFill{Base: u64(200), Quote: u64(999), Success: false})
	if err != nil {
		t.Fatalf("SettleBatch: %v", err)
	}

	if !s.MarketBase.IsZero() || !s.MarketQuote.IsZero() {
		t.Fatalf("failed leg should move nothing, got base=%s quote=%s", s.MarketBase.String(), s.MarketQuote.String())
	}
	if !s.ClearingPrice.Eq(refPrice) {
		t.Fatalf("clearing price = %s, want the reference price", s.ClearingPrice.String())
	}

	assertConserved(t, plan, s)

	byID := fillsByID(s)
	if !byID["i2"].Base.Eq(u64(300)) {
		t.Fatalf("seller should still be filled by the cross, got %s", byID["i2"].Base.String())
	}
	if !byID["i1"].Base.Eq(u64(300)) {
		t.Fatalf("buyer should receive the crossed 300, got %s", byID["i1"].Base.String())
	}
	if !s.Unfilled.Eq(u64(200)) {
		t.Fatalf("unfilled = %s, want 200", s.Unfilled.String())
	}
}

func TestSettleFullyInternalisedUsesReferencePrice(t *testing.T) {
	refPrice := price(t, 3_000)
	plan := planFrom(t, []Intent{
		intent("i1", "alpha", SideBuy, 250),
		intent("i2", "beta", SideSell, 150),
		intent("i3", "gamma", SideSell, 100),
	}, refPrice)

	if !plan.FullyInternalised {
		t.Fatal("expected a fully internalised plan")
	}

	s, err := SettleBatch(plan, "batch-1", MarketFill{Success: true})
	if err != nil {
		t.Fatalf("SettleBatch: %v", err)
	}

	if !s.ClearingPrice.Eq(refPrice) {
		t.Fatalf("clearing price = %s, want reference", s.ClearingPrice.String())
	}
	assertConserved(t, plan, s)

	buyBase, buyQuote := sumSide(t, s, SideBuy)
	sellBase, sellQuote := sumSide(t, s, SideSell)
	if !buyBase.Eq(sellBase) || !buyQuote.Eq(sellQuote) {
		t.Fatalf("internal cross must match exactly: base %s/%s quote %s/%s",
			buyBase.String(), sellBase.String(), buyQuote.String(), sellQuote.String())
	}
}

func TestSettleRejectsImpossibleFills(t *testing.T) {
	refPrice := price(t, 3_000)
	plan := planFrom(t, []Intent{
		intent("i1", "alpha", SideBuy, 100),
		intent("i2", "beta", SideSell, 60),
	}, refPrice)

	t.Run("more base than requested", func(t *testing.T) {
		_, err := SettleBatch(plan, "b", MarketFill{Base: u64(999), Quote: u64(1), Success: true})
		if err != ErrOverfilled {
			t.Fatalf("expected ErrOverfilled, got %v", err)
		}
	})

	t.Run("quote with no base", func(t *testing.T) {
		_, err := SettleBatch(plan, "b", MarketFill{Base: types.Uint256{}, Quote: u64(1), Success: true})
		if err != ErrQuoteWithoutBase {
			t.Fatalf("expected ErrQuoteWithoutBase, got %v", err)
		}
	})

	t.Run("nil plan", func(t *testing.T) {
		if _, err := SettleBatch(nil, "b", MarketFill{}); err != ErrNoSuchBatch {
			t.Fatalf("expected ErrNoSuchBatch, got %v", err)
		}
	})
}

// The on-chain slippage bound is the real protection, but if it ever fails the
// enclave must notice rather than settle a bad price silently.
func TestSettleFlagsALimitBreach(t *testing.T) {
	refPrice := price(t, 3_000)

	buyer := intent("i1", "alpha", SideBuy, 100)
	buyer.LimitPrice = ptr(price(t, 3_050)) // will not pay above 3050

	plan := planFrom(t, []Intent{buyer, intent("i2", "beta", SideSell, 60)}, refPrice)

	// The market executes at 3200, worse than the buyer's limit.
	marketQuote, err := ApplyPrice(u64(40), price(t, 3_200))
	if err != nil {
		t.Fatalf("ApplyPrice: %v", err)
	}

	s, err := SettleBatch(plan, "batch-1", MarketFill{Base: u64(40), Quote: marketQuote, Success: true})
	if err != nil {
		t.Fatalf("SettleBatch: %v", err)
	}
	if !s.LimitBreached {
		t.Fatal("expected the limit breach to be flagged")
	}
}

// Determinism is a correctness requirement, not a nicety: a settlement that
// varied between runs would produce a different state root each time.
func TestSettleIsDeterministic(t *testing.T) {
	refPrice := price(t, 3_000)
	build := func() *Settlement {
		plan := planFrom(t, []Intent{
			intent("i1", "alpha", SideBuy, 700),
			intent("i2", "beta", SideBuy, 301),
			intent("i3", "gamma", SideSell, 199),
			intent("i4", "delta", SideSell, 97),
		}, refPrice)
		mq, err := ApplyPrice(u64(505), refPrice)
		if err != nil {
			t.Fatalf("ApplyPrice: %v", err)
		}
		s, err := SettleBatch(plan, "batch-1", MarketFill{Base: u64(505), Quote: mq, Success: true})
		if err != nil {
			t.Fatalf("SettleBatch: %v", err)
		}
		return s
	}

	first := build()
	for i := 0; i < 25; i++ {
		next := build()
		if len(next.Fills) != len(first.Fills) {
			t.Fatalf("fill count differs between runs")
		}
		for j := range first.Fills {
			if first.Fills[j] != next.Fills[j] {
				t.Fatalf("run %d differs at fill %d: %+v vs %+v", i, j, first.Fills[j], next.Fills[j])
			}
		}
	}
}

func TestDistributeSumsToExactlyTheTotal(t *testing.T) {
	cases := []struct {
		name    string
		total   uint64
		weights []uint64
	}{
		{"even split", 100, []uint64{1, 1, 1, 1}},
		{"awkward remainder", 100, []uint64{1, 1, 1}},
		{"lopsided", 1_000_000, []uint64{999_999, 1}},
		{"single recipient", 7, []uint64{5}},
		{"many tiny", 10, []uint64{1, 1, 1, 1, 1, 1, 1}},
		{"zero total", 0, []uint64{3, 4}},
		{"some zero weights", 50, []uint64{0, 10, 0, 40}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			weights := make([]types.Uint256, len(tc.weights))
			for i, w := range tc.weights {
				weights[i] = u64(w)
			}

			parts, err := distribute(u64(tc.total), weights)
			if err != nil {
				t.Fatalf("distribute: %v", err)
			}

			var sum types.Uint256
			for _, p := range parts {
				if sum, err = Add(sum, p); err != nil {
					t.Fatalf("Add: %v", err)
				}
			}
			if !sum.Eq(u64(tc.total)) {
				t.Fatalf("parts sum to %s, want %d", sum.String(), tc.total)
			}

			// A recipient with no claim must never receive dust.
			for i, w := range tc.weights {
				if w == 0 && !parts[i].IsZero() {
					t.Fatalf("zero-weight recipient %d got %s", i, parts[i].String())
				}
			}
		})
	}
}

func TestDistributeRejectsZeroWeight(t *testing.T) {
	if _, err := distribute(u64(10), []types.Uint256{{}, {}}); err != ErrNoWeights {
		t.Fatalf("expected ErrNoWeights, got %v", err)
	}
}

// Settlement must land in the ledger without creating or destroying holdings.
func TestApplySettlementMovesBalances(t *testing.T) {
	st := newTestState(t)
	if _, err := st.RegisterStrategy("beta", managerB, Mandate{
		AllowedTokens: []types.Address{tokenUSDC, tokenWETH},
	}); err != nil {
		t.Fatalf("RegisterStrategy: %v", err)
	}

	alpha := fundStrategy(t, st, "alpha", 1_000_000, 0) // buyer holds quote
	beta, _ := st.Strategy("beta")
	if err := beta.credit(tokenWETH, u64(60)); err != nil { // seller holds base
		t.Fatalf("credit: %v", err)
	}

	refPrice := price(t, 3_000)
	plan := planFrom(t, []Intent{
		intent("i1", "alpha", SideBuy, 100),
		intent("i2", "beta", SideSell, 60),
	}, refPrice)

	marketQuote, err := ApplyPrice(u64(40), refPrice)
	if err != nil {
		t.Fatalf("ApplyPrice: %v", err)
	}
	s, err := SettleBatch(plan, "batch-1", MarketFill{Base: u64(40), Quote: marketQuote, Success: true})
	if err != nil {
		t.Fatalf("SettleBatch: %v", err)
	}

	if err := st.ApplySettlement(plan, s); err != nil {
		t.Fatalf("ApplySettlement: %v", err)
	}

	// The buyer holds the full 100 base it asked for.
	if !alpha.Balance(tokenWETH).Eq(u64(100)) {
		t.Fatalf("buyer base = %s, want 100", alpha.Balance(tokenWETH).String())
	}
	// The seller has parted with all 60.
	if !beta.Balance(tokenWETH).IsZero() {
		t.Fatalf("seller base = %s, want 0", beta.Balance(tokenWETH).String())
	}

	byID := fillsByID(s)
	spent, err := Sub(u64(1_000_000), alpha.Balance(tokenUSDC))
	if err != nil {
		t.Fatalf("Sub: %v", err)
	}
	if !spent.Eq(byID["i1"].Quote) {
		t.Fatalf("buyer spent %s, fill says %s", spent.String(), byID["i1"].Quote.String())
	}
	if !beta.Balance(tokenUSDC).Eq(byID["i2"].Quote) {
		t.Fatalf("seller received %s, fill says %s", beta.Balance(tokenUSDC).String(), byID["i2"].Quote.String())
	}
}

func TestApplySettlementFailsOnUnknownStrategy(t *testing.T) {
	st := newTestState(t)
	plan := &BatchPlan{Base: tokenWETH, Quote: tokenUSDC}
	s := &Settlement{Fills: []Fill{{
		IntentID: "i1", StrategyID: "ghost", Side: SideBuy, Base: u64(1), Quote: u64(1),
	}}}

	if err := st.ApplySettlement(plan, s); err != ErrUnknownStrategy {
		t.Fatalf("expected ErrUnknownStrategy, got %v", err)
	}
}

func fillsByID(s *Settlement) map[string]Fill {
	out := make(map[string]Fill, len(s.Fills))
	for _, f := range s.Fills {
		out[f.IntentID] = f
	}
	return out
}
