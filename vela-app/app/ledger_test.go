package app

import (
	"testing"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

var (
	managerA   = addr(0x11)
	managerB   = addr(0x12)
	depositor  = addr(0x21)
	depositor2 = addr(0x22)
)

// newTestState builds a vault quoted in USDC with one registered strategy that
// may trade WETH.
func newTestState(t *testing.T) *ApplicationInternalState {
	t.Helper()

	st := NewState(1, addr(0x99).Hex(), tokenUSDC, NettingConfig{
		MinContributors: 2,
		MinResidual:     types.NewUint256(0),
	})

	_, err := st.RegisterStrategy("alpha", managerA, Mandate{
		AllowedTokens:   []types.Address{tokenUSDC, tokenWETH},
		MaxOrderBase:    types.NewUint256(1_000),
		MaxPositionBase: types.NewUint256(5_000),
	})
	if err != nil {
		t.Fatalf("RegisterStrategy: %v", err)
	}
	return st
}

// pricesAt builds a price set where WETH trades at the given whole-number price.
func pricesAt(t *testing.T, wethPrice uint64) PriceSet {
	t.Helper()
	return PriceSet{tokenWETH.Hex(): price(t, wethPrice)}
}

func TestRegisterStrategyRejectsDuplicate(t *testing.T) {
	st := newTestState(t)
	_, err := st.RegisterStrategy("alpha", managerB, Mandate{})
	if err != ErrStrategyExists {
		t.Fatalf("expected ErrStrategyExists, got %v", err)
	}
}

func TestDepositCreditsIdleBalance(t *testing.T) {
	st := newTestState(t)

	if err := st.Deposit(depositor, tokenUSDC, u64(1_000)); err != nil {
		t.Fatalf("Deposit: %v", err)
	}

	got := st.Account(depositor).UnallocatedBalance(tokenUSDC)
	if !got.Eq(u64(1_000)) {
		t.Fatalf("idle balance = %s, want 1000", got.String())
	}

	if err := st.Deposit(depositor, tokenUSDC, types.Uint256{}); err != ErrZeroAmount {
		t.Fatalf("expected ErrZeroAmount, got %v", err)
	}
}

func TestAllocateBootstrapsSharesOneToOne(t *testing.T) {
	st := newTestState(t)
	if err := st.Deposit(depositor, tokenUSDC, u64(1_000)); err != nil {
		t.Fatalf("Deposit: %v", err)
	}

	issued, err := st.Allocate(depositor, "alpha", u64(1_000), pricesAt(t, 3_000))
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	if !issued.Eq(u64(1_000)) {
		t.Fatalf("issued = %s, want 1000", issued.String())
	}

	s, _ := st.Strategy("alpha")
	if !s.Balance(tokenUSDC).Eq(u64(1_000)) {
		t.Fatalf("strategy quote balance = %s, want 1000", s.Balance(tokenUSDC).String())
	}
	if !st.Account(depositor).UnallocatedBalance(tokenUSDC).IsZero() {
		t.Fatal("idle balance should be spent")
	}
}

// The central invariant of the share system: a new depositor must neither
// dilute nor be diluted. After a second allocation, the first depositor's
// claim on the strategy must be worth what it was worth before.
func TestAllocateDoesNotDiluteExistingHolders(t *testing.T) {
	st := newTestState(t)
	prices := pricesAt(t, 100)

	// First depositor seeds the strategy with 1000 quote.
	if err := st.Deposit(depositor, tokenUSDC, u64(1_000)); err != nil {
		t.Fatalf("Deposit: %v", err)
	}
	if _, err := st.Allocate(depositor, "alpha", u64(1_000), prices); err != nil {
		t.Fatalf("Allocate: %v", err)
	}

	s, _ := st.Strategy("alpha")

	// The strategy doubles in value: 600 quote becomes 16 WETH worth 1600 at a
	// price of 100, taking NAV from 1000 to 2000.
	if err := s.debit(tokenUSDC, u64(600)); err != nil {
		t.Fatalf("debit: %v", err)
	}
	if err := s.credit(tokenWETH, u64(16)); err != nil {
		t.Fatalf("credit: %v", err)
	}

	navBefore, err := st.NAV(s, prices)
	if err != nil {
		t.Fatalf("NAV: %v", err)
	}
	sharesBefore := *s.TotalShares
	firstHolderShares := st.Account(depositor).ShareBalance("alpha")

	valueBefore, err := MulDiv(firstHolderShares, navBefore, sharesBefore)
	if err != nil {
		t.Fatalf("MulDiv: %v", err)
	}

	// A second depositor joins.
	if err := st.Deposit(depositor2, tokenUSDC, u64(400)); err != nil {
		t.Fatalf("Deposit: %v", err)
	}
	if _, err := st.Allocate(depositor2, "alpha", u64(400), prices); err != nil {
		t.Fatalf("Allocate: %v", err)
	}

	navAfter, err := st.NAV(s, prices)
	if err != nil {
		t.Fatalf("NAV: %v", err)
	}
	valueAfter, err := MulDiv(firstHolderShares, navAfter, *s.TotalShares)
	if err != nil {
		t.Fatalf("MulDiv: %v", err)
	}

	if !valueAfter.Eq(valueBefore) {
		t.Fatalf("first holder value changed: before %s, after %s", valueBefore.String(), valueAfter.String())
	}

	// And the newcomer's claim is worth what they paid.
	newcomerShares := st.Account(depositor2).ShareBalance("alpha")
	newcomerValue, err := MulDiv(newcomerShares, navAfter, *s.TotalShares)
	if err != nil {
		t.Fatalf("MulDiv: %v", err)
	}
	if !newcomerValue.Eq(u64(400)) {
		t.Fatalf("newcomer value = %s, want 400", newcomerValue.String())
	}
}

func TestAllocateRejections(t *testing.T) {
	prices := pricesAt(t, 3_000)

	t.Run("insufficient idle balance", func(t *testing.T) {
		st := newTestState(t)
		if err := st.Deposit(depositor, tokenUSDC, u64(100)); err != nil {
			t.Fatalf("Deposit: %v", err)
		}
		if _, err := st.Allocate(depositor, "alpha", u64(500), prices); err != ErrInsufficientFunds {
			t.Fatalf("expected ErrInsufficientFunds, got %v", err)
		}
	})

	t.Run("unknown strategy", func(t *testing.T) {
		st := newTestState(t)
		if _, err := st.Allocate(depositor, "nope", u64(1), prices); err != ErrUnknownStrategy {
			t.Fatalf("expected ErrUnknownStrategy, got %v", err)
		}
	})

	t.Run("halted strategy", func(t *testing.T) {
		st := newTestState(t)
		s, _ := st.Strategy("alpha")
		s.Halted = true
		if err := st.Deposit(depositor, tokenUSDC, u64(100)); err != nil {
			t.Fatalf("Deposit: %v", err)
		}
		if _, err := st.Allocate(depositor, "alpha", u64(100), prices); err != ErrStrategyHalted {
			t.Fatalf("expected ErrStrategyHalted, got %v", err)
		}
	})

	// Shares outstanding against zero value would divide by zero and hand the
	// newcomer the entire strategy.
	t.Run("wiped out strategy", func(t *testing.T) {
		st := newTestState(t)
		s, _ := st.Strategy("alpha")
		total := u64(1_000)
		s.TotalShares = &total // shares exist, but no balances

		if err := st.Deposit(depositor, tokenUSDC, u64(100)); err != nil {
			t.Fatalf("Deposit: %v", err)
		}
		if _, err := st.Allocate(depositor, "alpha", u64(100), prices); err != ErrStrategyWipedOut {
			t.Fatalf("expected ErrStrategyWipedOut, got %v", err)
		}
	})
}

func TestNAVRequiresPriceForEveryHolding(t *testing.T) {
	st := newTestState(t)
	s, _ := st.Strategy("alpha")
	if err := s.credit(tokenWETH, u64(10)); err != nil {
		t.Fatalf("credit: %v", err)
	}

	if _, err := st.NAV(s, PriceSet{}); err != ErrMissingPrice {
		t.Fatalf("expected ErrMissingPrice, got %v", err)
	}
}

func TestNAVValuesQuoteAndPositions(t *testing.T) {
	st := newTestState(t)
	s, _ := st.Strategy("alpha")

	if err := s.credit(tokenUSDC, u64(500)); err != nil {
		t.Fatalf("credit: %v", err)
	}
	if err := s.credit(tokenWETH, u64(3)); err != nil {
		t.Fatalf("credit: %v", err)
	}

	nav, err := st.NAV(s, pricesAt(t, 1_000))
	if err != nil {
		t.Fatalf("NAV: %v", err)
	}
	// 500 quote + 3 WETH * 1000 = 3500
	if !nav.Eq(u64(3_500)) {
		t.Fatalf("NAV = %s, want 3500", nav.String())
	}
}

func TestRedeemReturnsProportionalValue(t *testing.T) {
	st := newTestState(t)
	prices := pricesAt(t, 3_000)

	if err := st.Deposit(depositor, tokenUSDC, u64(1_000)); err != nil {
		t.Fatalf("Deposit: %v", err)
	}
	if _, err := st.Allocate(depositor, "alpha", u64(1_000), prices); err != nil {
		t.Fatalf("Allocate: %v", err)
	}

	value, err := st.Redeem(depositor, "alpha", u64(400), prices)
	if err != nil {
		t.Fatalf("Redeem: %v", err)
	}
	if !value.Eq(u64(400)) {
		t.Fatalf("redeemed value = %s, want 400", value.String())
	}

	if got := st.Account(depositor).ShareBalance("alpha"); !got.Eq(u64(600)) {
		t.Fatalf("remaining shares = %s, want 600", got.String())
	}
	if got := st.Account(depositor).UnallocatedBalance(tokenUSDC); !got.Eq(u64(400)) {
		t.Fatalf("idle balance = %s, want 400", got.String())
	}
}

func TestRedeemRejections(t *testing.T) {
	prices := pricesAt(t, 3_000)

	t.Run("more shares than held", func(t *testing.T) {
		st := newTestState(t)
		if err := st.Deposit(depositor, tokenUSDC, u64(100)); err != nil {
			t.Fatalf("Deposit: %v", err)
		}
		if _, err := st.Allocate(depositor, "alpha", u64(100), prices); err != nil {
			t.Fatalf("Allocate: %v", err)
		}
		if _, err := st.Redeem(depositor, "alpha", u64(500), prices); err != ErrInsufficientFunds {
			t.Fatalf("expected ErrInsufficientFunds, got %v", err)
		}
	})

	// A fully invested strategy cannot pay out without unwinding a position
	// first; redemption must fail rather than force a sale mid-batch.
	t.Run("strategy fully invested", func(t *testing.T) {
		st := newTestState(t)
		if err := st.Deposit(depositor, tokenUSDC, u64(3_000)); err != nil {
			t.Fatalf("Deposit: %v", err)
		}
		if _, err := st.Allocate(depositor, "alpha", u64(3_000), prices); err != nil {
			t.Fatalf("Allocate: %v", err)
		}

		s, _ := st.Strategy("alpha")
		if err := s.debit(tokenUSDC, u64(3_000)); err != nil {
			t.Fatalf("debit: %v", err)
		}
		if err := s.credit(tokenWETH, u64(1)); err != nil {
			t.Fatalf("credit: %v", err)
		}

		if _, err := st.Redeem(depositor, "alpha", u64(100), prices); err != ErrInsufficientFunds {
			t.Fatalf("expected ErrInsufficientFunds, got %v", err)
		}
	})

	t.Run("unknown account", func(t *testing.T) {
		st := newTestState(t)
		if _, err := st.Redeem(addr(0x77), "alpha", u64(1), prices); err != ErrNoSuchAccount {
			t.Fatalf("expected ErrNoSuchAccount, got %v", err)
		}
	})
}

// fundStrategy gives a strategy quote balance without going through a depositor.
func fundStrategy(t *testing.T, st *ApplicationInternalState, id string, quote, base uint64) *Strategy {
	t.Helper()
	s, err := st.Strategy(id)
	if err != nil {
		t.Fatalf("Strategy: %v", err)
	}
	if quote > 0 {
		if err := s.credit(tokenUSDC, u64(quote)); err != nil {
			t.Fatalf("credit quote: %v", err)
		}
	}
	if base > 0 {
		if err := s.credit(tokenWETH, u64(base)); err != nil {
			t.Fatalf("credit base: %v", err)
		}
	}
	return s
}

func buyIntent(amount uint64, limit types.Uint256) Intent {
	return Intent{
		StrategyID: "alpha",
		Base:       tokenWETH,
		Quote:      tokenUSDC,
		Side:       SideBuy,
		Amount:     types.NewUint256(amount),
		LimitPrice: &limit,
	}
}

func sellIntent(amount uint64) Intent {
	zero := types.Uint256{}
	return Intent{
		StrategyID: "alpha",
		Base:       tokenWETH,
		Quote:      tokenUSDC,
		Side:       SideSell,
		Amount:     types.NewUint256(amount),
		LimitPrice: &zero,
	}
}

func TestSubmitIntentAcceptsValidIntent(t *testing.T) {
	st := newTestState(t)
	fundStrategy(t, st, "alpha", 1_000_000, 0)

	in, err := st.SubmitIntent(managerA, buyIntent(10, price(t, 3_000)))
	if err != nil {
		t.Fatalf("SubmitIntent: %v", err)
	}
	if in.ID == "" {
		t.Fatal("intent should be assigned an ID")
	}
	if len(st.Pending) != 1 {
		t.Fatalf("pending = %d, want 1", len(st.Pending))
	}

	// IDs are derived from a counter, so they are stable and non-repeating.
	in2, err := st.SubmitIntent(managerA, buyIntent(10, price(t, 3_000)))
	if err != nil {
		t.Fatalf("SubmitIntent: %v", err)
	}
	if in2.ID == in.ID {
		t.Fatal("intent IDs must be unique")
	}
}

func TestSubmitIntentEnforcesMandate(t *testing.T) {
	t.Run("only the manager may submit", func(t *testing.T) {
		st := newTestState(t)
		fundStrategy(t, st, "alpha", 1_000_000, 0)
		if _, err := st.SubmitIntent(managerB, buyIntent(10, price(t, 3_000))); err != ErrNotManager {
			t.Fatalf("expected ErrNotManager, got %v", err)
		}
	})

	t.Run("halted strategy", func(t *testing.T) {
		st := newTestState(t)
		s := fundStrategy(t, st, "alpha", 1_000_000, 0)
		s.Halted = true
		if _, err := st.SubmitIntent(managerA, buyIntent(10, price(t, 3_000))); err != ErrStrategyHalted {
			t.Fatalf("expected ErrStrategyHalted, got %v", err)
		}
	})

	t.Run("token outside mandate", func(t *testing.T) {
		st := newTestState(t)
		fundStrategy(t, st, "alpha", 1_000_000, 0)
		in := buyIntent(10, price(t, 3_000))
		in.Base = tokenWBTC
		if _, err := st.SubmitIntent(managerA, in); err != ErrTokenNotAllowed {
			t.Fatalf("expected ErrTokenNotAllowed, got %v", err)
		}
	})

	t.Run("order larger than mandate allows", func(t *testing.T) {
		st := newTestState(t)
		fundStrategy(t, st, "alpha", 100_000_000, 0)
		if _, err := st.SubmitIntent(managerA, buyIntent(5_000, price(t, 1))); err != ErrOrderTooLarge {
			t.Fatalf("expected ErrOrderTooLarge, got %v", err)
		}
	})

	t.Run("buy without a limit price", func(t *testing.T) {
		st := newTestState(t)
		fundStrategy(t, st, "alpha", 1_000_000, 0)
		if _, err := st.SubmitIntent(managerA, buyIntent(10, types.Uint256{})); err != ErrBuyNeedsLimitPrice {
			t.Fatalf("expected ErrBuyNeedsLimitPrice, got %v", err)
		}
	})

	t.Run("buy the strategy cannot afford", func(t *testing.T) {
		st := newTestState(t)
		fundStrategy(t, st, "alpha", 100, 0) // 100 quote only
		if _, err := st.SubmitIntent(managerA, buyIntent(10, price(t, 3_000))); err != ErrInsufficientFunds {
			t.Fatalf("expected ErrInsufficientFunds, got %v", err)
		}
	})

	// The vault does not permit shorting.
	t.Run("sell more than held", func(t *testing.T) {
		st := newTestState(t)
		fundStrategy(t, st, "alpha", 0, 5)
		if _, err := st.SubmitIntent(managerA, sellIntent(10)); err != ErrInsufficientFunds {
			t.Fatalf("expected ErrInsufficientFunds, got %v", err)
		}
	})

	t.Run("position cap across queued buys", func(t *testing.T) {
		st := newTestState(t)
		// Cap is 5000 base; fund generously so cost is not the binding limit.
		fundStrategy(t, st, "alpha", 1_000_000_000, 4_500)

		// 500 more reaches exactly the cap.
		if _, err := st.SubmitIntent(managerA, buyIntent(500, price(t, 1))); err != nil {
			t.Fatalf("SubmitIntent: %v", err)
		}
		// Any further buy breaches it.
		if _, err := st.SubmitIntent(managerA, buyIntent(1, price(t, 1))); err != ErrPositionTooLarge {
			t.Fatalf("expected ErrPositionTooLarge, got %v", err)
		}
	})
}

// Queued intents must be counted against the balance, or a strategy could
// commit the same money twice within one batch.
func TestSubmitIntentPreventsDoubleSpendingAcrossQueuedIntents(t *testing.T) {
	st := newTestState(t)
	// Enough for exactly one 10-unit buy at 3000.
	fundStrategy(t, st, "alpha", 30_000, 0)

	if _, err := st.SubmitIntent(managerA, buyIntent(10, price(t, 3_000))); err != nil {
		t.Fatalf("first SubmitIntent: %v", err)
	}
	if _, err := st.SubmitIntent(managerA, buyIntent(10, price(t, 3_000))); err != ErrInsufficientFunds {
		t.Fatalf("expected ErrInsufficientFunds on second intent, got %v", err)
	}
}

func TestSubmitIntentPreventsDoubleSpendingOfHeldBase(t *testing.T) {
	st := newTestState(t)
	fundStrategy(t, st, "alpha", 0, 10)

	if _, err := st.SubmitIntent(managerA, sellIntent(10)); err != nil {
		t.Fatalf("first SubmitIntent: %v", err)
	}
	if _, err := st.SubmitIntent(managerA, sellIntent(1)); err != ErrInsufficientFunds {
		t.Fatalf("expected ErrInsufficientFunds on second sell, got %v", err)
	}
}

func TestSortedIterationIsStable(t *testing.T) {
	st := newTestState(t)
	for _, id := range []string{"zeta", "beta", "gamma"} {
		if _, err := st.RegisterStrategy(id, managerA, Mandate{}); err != nil {
			t.Fatalf("RegisterStrategy: %v", err)
		}
	}

	// Repeated traversals must agree, or state roots would diverge between
	// otherwise identical executions.
	first := st.SortedStrategyIDs()
	for i := 0; i < 20; i++ {
		if got := st.SortedStrategyIDs(); !equalStrings(got, first) {
			t.Fatalf("iteration order not stable: %v vs %v", got, first)
		}
	}

	want := []string{"alpha", "beta", "gamma", "zeta"}
	if !equalStrings(first, want) {
		t.Fatalf("order = %v, want %v", first, want)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
