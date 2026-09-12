package app

import (
	"testing"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

var (
	tokenWETH = addr(0xAA)
	tokenUSDC = addr(0xBB)
	tokenWBTC = addr(0xCC)
)

func addr(b byte) types.Address {
	var a types.Address
	for i := range a {
		a[i] = b
	}
	return a
}

// price builds a fixed-point price from a whole number.
func price(t *testing.T, whole uint64) types.Uint256 {
	t.Helper()
	p := One()
	p.Mul64(whole)
	return p
}

func intent(id, strategy string, side Side, amount uint64) Intent {
	return Intent{
		ID:         id,
		StrategyID: strategy,
		Base:       tokenWETH,
		Quote:      tokenUSDC,
		Side:       side,
		Amount:     types.NewUint256(amount),
		LimitPrice: types.NewUint256(0),
	}
}

func defaultCfg() NettingConfig {
	return NettingConfig{MinContributors: 2, MinResidual: types.NewUint256(0)}
}

func TestNetBatchOffsetsOpposingFlow(t *testing.T) {
	// Strategy A buys 100, strategy B sells 60. Only the 40 difference should
	// ever reach the market; the 60 that crossed is invisible.
	intents := []Intent{
		intent("i1", "alpha", SideBuy, 100),
		intent("i2", "beta", SideSell, 60),
	}

	plan, err := NetBatch(intents, price(t, 3000), defaultCfg())
	if err != nil {
		t.Fatalf("NetBatch: %v", err)
	}

	if !plan.CrossedBase.Eq(*types.NewUint256(60)) {
		t.Fatalf("crossed = %s, want 60", plan.CrossedBase.String())
	}
	if !plan.ResidualBase.Eq(*types.NewUint256(40)) {
		t.Fatalf("residual = %s, want 40", plan.ResidualBase.String())
	}
	if plan.ResidualSide != SideBuy {
		t.Fatalf("residual side = %s, want buy", plan.ResidualSide)
	}
	if plan.FullyInternalised {
		t.Fatal("batch should not be fully internalised")
	}
	if plan.Contributors != 2 {
		t.Fatalf("contributors = %d, want 2", plan.Contributors)
	}
}

func TestNetBatchPerfectCrossSendsNothingOnChain(t *testing.T) {
	// Equal and opposite flow cancels completely: the market sees no order at
	// all, which is the strongest privacy outcome available.
	intents := []Intent{
		intent("i1", "alpha", SideBuy, 250),
		intent("i2", "beta", SideSell, 150),
		intent("i3", "gamma", SideSell, 100),
	}

	plan, err := NetBatch(intents, price(t, 3000), defaultCfg())
	if err != nil {
		t.Fatalf("NetBatch: %v", err)
	}

	if !plan.FullyInternalised {
		t.Fatal("expected batch to be fully internalised")
	}
	if !plan.ResidualBase.IsZero() {
		t.Fatalf("residual = %s, want 0", plan.ResidualBase.String())
	}
	if !plan.CrossedBase.Eq(*types.NewUint256(250)) {
		t.Fatalf("crossed = %s, want 250", plan.CrossedBase.String())
	}
}

// TestNetBatchIndistinguishability is the executable statement of Legate's
// privacy claim. Several completely different sets of strategy intents produce
// byte-identical public output. An observer holding only what the chain reveals
// cannot tell which set produced it, so no individual strategy's order, size or
// direction can be recovered from the residual.
func TestNetBatchIndistinguishability(t *testing.T) {
	refPrice := price(t, 3000)

	worlds := [][]Intent{
		// One large buyer lightly offset.
		{
			intent("a1", "alpha", SideBuy, 140),
			intent("a2", "beta", SideSell, 40),
		},
		// Several buyers against a large seller.
		{
			intent("b1", "alpha", SideBuy, 500),
			intent("b2", "beta", SideBuy, 300),
			intent("b3", "gamma", SideSell, 700),
		},
		// Heavy two-sided flow that nearly cancels.
		{
			intent("c1", "delta", SideBuy, 9000),
			intent("c2", "epsilon", SideSell, 4000),
			intent("c3", "zeta", SideSell, 4900),
		},
	}

	type observable struct {
		side   Side
		amount string
	}

	var seen []observable
	for i, intents := range worlds {
		plan, err := NetBatch(intents, refPrice, defaultCfg())
		if err != nil {
			t.Fatalf("world %d: NetBatch: %v", i, err)
		}
		seen = append(seen, observable{side: plan.ResidualSide, amount: plan.ResidualBase.String()})
	}

	for i := 1; i < len(seen); i++ {
		if seen[i] != seen[0] {
			t.Fatalf("worlds are distinguishable on chain: world 0 = %+v, world %d = %+v", seen[0], i, seen[i])
		}
	}

	if seen[0].amount != "100" || seen[0].side != SideBuy {
		t.Fatalf("unexpected shared observable: %+v", seen[0])
	}
}

func TestNetBatchRejectsInsufficientAnonymity(t *testing.T) {
	// A single strategy with a residual would publish its own order verbatim.
	intents := []Intent{
		intent("i1", "alpha", SideBuy, 100),
		intent("i2", "alpha", SideBuy, 50),
	}

	_, err := NetBatch(intents, price(t, 3000), NettingConfig{MinContributors: 2})
	if err != ErrInsufficientAnonymity {
		t.Fatalf("expected ErrInsufficientAnonymity, got %v", err)
	}
}

// A batch that fully internalises leaks nothing, so the k-anonymity guard does
// not apply: there is no public order to attribute.
func TestNetBatchSingleContributorAllowedWhenFullyInternalised(t *testing.T) {
	intents := []Intent{
		intent("i1", "alpha", SideBuy, 100),
		intent("i2", "alpha", SideSell, 100),
	}

	plan, err := NetBatch(intents, price(t, 3000), NettingConfig{MinContributors: 5})
	if err != nil {
		t.Fatalf("NetBatch: %v", err)
	}
	if !plan.FullyInternalised {
		t.Fatal("expected full internalisation")
	}
}

func TestNetBatchDustResidualIsInternalised(t *testing.T) {
	intents := []Intent{
		intent("i1", "alpha", SideBuy, 1005),
		intent("i2", "beta", SideSell, 1000),
	}

	cfg := NettingConfig{MinContributors: 2, MinResidual: types.NewUint256(10)}
	plan, err := NetBatch(intents, price(t, 3000), cfg)
	if err != nil {
		t.Fatalf("NetBatch: %v", err)
	}

	if !plan.FullyInternalised {
		t.Fatal("dust residual should be internalised")
	}
	if !plan.ResidualBase.IsZero() {
		t.Fatalf("residual = %s, want 0", plan.ResidualBase.String())
	}
}

func TestNetBatchExcludesIntentsBeyondLimitPrice(t *testing.T) {
	refPrice := price(t, 3000)

	buyTooCheap := intent("i1", "alpha", SideBuy, 100)
	buyTooCheap.LimitPrice = ptr(price(t, 2500)) // will not pay 3000

	sellTooDear := intent("i2", "beta", SideSell, 80)
	sellTooDear.LimitPrice = ptr(price(t, 3500)) // will not sell at 3000

	ok := intent("i3", "gamma", SideBuy, 70)
	ok.LimitPrice = ptr(price(t, 3200))

	okSell := intent("i4", "delta", SideSell, 20)
	okSell.LimitPrice = ptr(price(t, 2900))

	plan, err := NetBatch([]Intent{buyTooCheap, sellTooDear, ok, okSell}, refPrice, defaultCfg())
	if err != nil {
		t.Fatalf("NetBatch: %v", err)
	}

	if len(plan.Included) != 2 {
		t.Fatalf("included %d intents, want 2", len(plan.Included))
	}
	if len(plan.Excluded) != 2 {
		t.Fatalf("excluded %d intents, want 2", len(plan.Excluded))
	}
	for _, ex := range plan.Excluded {
		if ex.Reason != ReasonLimitPrice {
			t.Fatalf("intent %s excluded for %s, want limit_price_not_met", ex.ID, ex.Reason)
		}
	}
	if !plan.ResidualBase.Eq(*types.NewUint256(50)) {
		t.Fatalf("residual = %s, want 50", plan.ResidualBase.String())
	}
}

func TestNetBatchLimitPriceBoundariesAreInclusive(t *testing.T) {
	refPrice := price(t, 3000)

	buyAtLimit := intent("i1", "alpha", SideBuy, 10)
	buyAtLimit.LimitPrice = ptr(refPrice)

	sellAtLimit := intent("i2", "beta", SideSell, 10)
	sellAtLimit.LimitPrice = ptr(refPrice)

	plan, err := NetBatch([]Intent{buyAtLimit, sellAtLimit}, refPrice, defaultCfg())
	if err != nil {
		t.Fatalf("NetBatch: %v", err)
	}
	if len(plan.Included) != 2 {
		t.Fatalf("included %d, want 2 (limits should be inclusive)", len(plan.Included))
	}
}

func TestNetBatchExcludesMalformedIntents(t *testing.T) {
	zero := intent("i1", "alpha", SideBuy, 0)

	wrongPair := intent("i2", "beta", SideSell, 50)
	wrongPair.Base = tokenWBTC

	missing := intent("i3", "gamma", SideBuy, 10)
	missing.Amount = nil

	good1 := intent("i4", "delta", SideBuy, 100)
	good2 := intent("i5", "epsilon", SideSell, 30)

	plan, err := NetBatch([]Intent{zero, wrongPair, missing, good1, good2}, price(t, 3000), defaultCfg())
	if err != nil {
		t.Fatalf("NetBatch: %v", err)
	}

	if len(plan.Included) != 2 {
		t.Fatalf("included %d, want 2", len(plan.Included))
	}

	reasons := map[string]ExclusionReason{}
	for _, ex := range plan.Excluded {
		reasons[ex.ID] = ex.Reason
	}
	if reasons["i1"] != ReasonZeroAmount {
		t.Fatalf("i1 reason = %s", reasons["i1"])
	}
	if reasons["i2"] != ReasonWrongPair {
		t.Fatalf("i2 reason = %s", reasons["i2"])
	}
	if reasons["i3"] != ReasonMissingField {
		t.Fatalf("i3 reason = %s", reasons["i3"])
	}
}

// Conservation: every unit of included flow is either crossed internally or
// carried by the residual. Nothing is created or lost during netting.
func TestNetBatchConservesVolume(t *testing.T) {
	intents := []Intent{
		intent("i1", "alpha", SideBuy, 800),
		intent("i2", "beta", SideBuy, 150),
		intent("i3", "gamma", SideSell, 400),
		intent("i4", "delta", SideSell, 90),
	}

	plan, err := NetBatch(intents, price(t, 3000), defaultCfg())
	if err != nil {
		t.Fatalf("NetBatch: %v", err)
	}

	// crossed + residual must equal the larger side, and crossed the smaller.
	larger, smaller := plan.TotalBuy, plan.TotalSell
	if larger.Cmp(smaller) < 0 {
		larger, smaller = smaller, larger
	}

	sum, err := Add(plan.CrossedBase, plan.ResidualBase)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if !sum.Eq(larger) {
		t.Fatalf("crossed+residual = %s, want %s", sum.String(), larger.String())
	}
	if !plan.CrossedBase.Eq(smaller) {
		t.Fatalf("crossed = %s, want %s", plan.CrossedBase.String(), smaller.String())
	}
}

func TestNetBatchRejectsZeroPriceAndEmptyInput(t *testing.T) {
	if _, err := NetBatch([]Intent{intent("i1", "alpha", SideBuy, 1)}, types.Uint256{}, defaultCfg()); err != ErrZeroPrice {
		t.Fatalf("expected ErrZeroPrice, got %v", err)
	}
	if _, err := NetBatch(nil, price(t, 3000), defaultCfg()); err != ErrEmptyBatch {
		t.Fatalf("expected ErrEmptyBatch, got %v", err)
	}
	// All intents unusable is also an empty batch.
	bad := intent("i1", "alpha", SideBuy, 0)
	if _, err := NetBatch([]Intent{bad}, price(t, 3000), defaultCfg()); err != ErrEmptyBatch {
		t.Fatalf("expected ErrEmptyBatch, got %v", err)
	}
}

func ptr(v types.Uint256) *types.Uint256 { return &v }
