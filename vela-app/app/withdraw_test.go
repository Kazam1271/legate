package app

import (
	"strings"
	"testing"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

func withdrawCmd(token types.Address, amount uint64, destination string) PayloadInstructions {
	return PayloadInstructions{
		Command: "withdraw",
		Withdraw: &WithdrawCmd{
			Token:       token.Hex(),
			Amount:      types.NewUint256(amount),
			Destination: destination,
		},
	}
}

// assertCustodyBalanced checks the invariant the custody mirror exists to hold:
// what the endpoint holds for the app equals every idle balance plus every
// strategy balance, less whatever is out with the trigger on an open batch.
//
// If this ever fails, the enclave's books and the chain's have drifted, and the
// next withdrawal large enough to notice would revert the state update and freeze
// the app.
func assertCustodyBalanced(t *testing.T, st *ApplicationInternalState, stage string) {
	t.Helper()

	expected := map[string]types.Uint256{}
	add := func(key string, v types.Uint256) {
		next, err := Add(expected[key], v)
		if err != nil {
			t.Fatalf("%s: overflow summing %s", stage, key)
		}
		expected[key] = next
	}
	sub := func(key string, v types.Uint256) {
		next, err := Sub(expected[key], v)
		if err != nil {
			t.Fatalf("%s: more out with the trigger than the ledger holds for %s", stage, key)
		}
		expected[key] = next
	}

	// Summation is order-independent, so plain map iteration is fine here.
	for _, a := range st.Accounts {
		for key, v := range a.Unallocated {
			add(key, *v)
		}
	}
	for _, s := range st.Strategies {
		for key, v := range s.Balances {
			add(key, *v)
		}
	}
	for _, open := range st.Open {
		if open.Plan.ResidualSide == SideBuy {
			sub(open.Plan.Quote.Hex(), open.QuoteLimit)
		} else {
			sub(open.Plan.Base.Hex(), open.Plan.ResidualBase)
		}
	}

	keys := map[string]bool{}
	for k := range expected {
		keys[k] = true
	}
	for k := range st.Custody {
		keys[k] = true
	}
	for key := range keys {
		var have types.Uint256
		if c := st.Custody[key]; c != nil {
			have = *c
		}
		if !have.Eq(expected[key]) {
			t.Fatalf("%s: custody of %s is %s but the ledger accounts for %s",
				stage, key, have.String(), expected[key].String())
		}
	}
}

func TestWithdrawPaysIdleBalanceToTheSender(t *testing.T) {
	h := newHarness(t)
	h.deposit(depositor, tokenUSDC, 1_000)

	res := h.process(depositor, withdrawCmd(tokenUSDC, 400, ""))

	if len(res.Withdrawals) != 1 {
		t.Fatalf("expected one withdrawal, got %d", len(res.Withdrawals))
	}
	w := res.Withdrawals[0]
	if w.DestinationAddress != depositor || w.TokenAddress != tokenUSDC || !w.Amount.Eq(u64(400)) {
		t.Fatalf("withdrawal = %s of %s to %s, want 400 USDC to the depositor",
			w.Amount.String(), w.TokenAddress.Hex(), w.DestinationAddress.Hex())
	}
	if got := onlyReceipt(t, res, depositor); got.Status != statusAccepted {
		t.Fatalf("receipt = %+v", got)
	}

	st := h.load()
	if idle := st.Account(depositor).UnallocatedBalance(tokenUSDC); !idle.Eq(u64(600)) {
		t.Fatalf("idle balance = %s, want 600", idle.String())
	}
	if c := st.CustodyOf(tokenUSDC); !c.Eq(u64(600)) {
		t.Fatalf("custody = %s, want 600", c.String())
	}
	assertCustodyBalanced(t, st, "after withdrawal")
}

func TestWithdrawToAnotherAddress(t *testing.T) {
	h := newHarness(t)
	h.deposit(depositor, tokenUSDC, 1_000)
	other := addr(0x55)

	res := h.process(depositor, withdrawCmd(tokenUSDC, 1_000, other.Hex()))

	if len(res.Withdrawals) != 1 || res.Withdrawals[0].DestinationAddress != other {
		t.Fatal("the withdrawal must go to the requested destination")
	}
}

// Withdrawal outcome is inherently public, since funds moving on chain are, but
// the reason for a refusal is not.
func TestWithdrawingMoreThanIdleIsRefusedPrivately(t *testing.T) {
	h := newHarness(t)
	h.deposit(depositor, tokenUSDC, 100)

	receipt := h.processExpectingRejection(depositor, withdrawCmd(tokenUSDC, 101, ""))
	if !strings.Contains(receipt.Reason, "insufficient balance") {
		t.Fatalf("unexpected reason: %s", receipt.Reason)
	}
}

// Value inside a strategy is not idle and cannot be withdrawn until redeemed.
func TestAllocatedValueCannotBeWithdrawnDirectly(t *testing.T) {
	h := newHarness(t)
	h.process(managerA, registerCmd("alpha"))
	h.deposit(depositor, tokenUSDC, 1_000)
	h.process(depositor, PayloadInstructions{
		Command:  "allocate",
		Allocate: &AllocateCmd{StrategyID: "alpha", Amount: types.NewUint256(1_000), Prices: PriceSet{}},
	})

	receipt := h.processExpectingRejection(depositor, withdrawCmd(tokenUSDC, 1, ""))
	if !strings.Contains(receipt.Reason, "insufficient balance") {
		t.Fatalf("unexpected reason: %s", receipt.Reason)
	}
}

// The endpoint reverts a whole state update whose withdrawals exceed custody,
// which would freeze the app for everyone. If the books ever drift, the
// withdrawal must be refused instead.
func TestAWithdrawalCustodyCannotCoverIsRefused(t *testing.T) {
	h := newHarness(t)
	h.deposit(depositor, tokenUSDC, 1_000)

	// Simulate drift: the ledger says 1000 is idle, but custody holds less.
	st := h.load()
	st.setCustody(tokenUSDC, u64(10))
	h.save(st)

	receipt := h.processExpectingRejection(depositor, withdrawCmd(tokenUSDC, 500, ""))
	if !strings.Contains(receipt.Reason, "custody") {
		t.Fatalf("unexpected reason: %s", receipt.Reason)
	}
}

// Funding the trigger is a withdrawal too, and must be held to the same check.
func TestABatchCustodyCannotFundIsRefused(t *testing.T) {
	h := newHarness(t)
	h.process(managerA, registerCmd("alpha"))
	h.process(managerB, registerCmd("beta"))
	h.fund("alpha", tokenUSDC, 1_000_000)
	h.fund("beta", tokenWETH, 60)

	h.process(managerA, intentCmd("alpha", SideBuy, 100, price(t, 3_100)))
	h.process(managerB, intentCmd("beta", SideSell, 60, types.Uint256{}))

	st := h.load()
	st.setCustody(tokenUSDC, u64(1)) // far below the 124000 the trigger needs
	h.save(st)

	receipt := h.processExpectingRejection(operator, PayloadInstructions{
		Command:    "close_batch",
		CloseBatch: &CloseBatchCmd{RefPrice: ptr(price(t, 3_000))},
	})
	if !strings.Contains(receipt.Reason, "custody") {
		t.Fatalf("unexpected reason: %s", receipt.Reason)
	}
}

// These say nothing about confidential state, so they fail publicly.
func TestNonsensicalWithdrawalDestinationsFailPublicly(t *testing.T) {
	h := newHarness(t)
	h.deposit(depositor, tokenUSDC, 1_000)
	sender := depositor

	cases := map[string]string{
		// The endpoint would accept this and the funds would be lost.
		"zero address": "0x0000000000000000000000000000000000000000",
		// The endpoint would claim this into the trigger as trade funding.
		"the trigger":    triggerAddr.Hex(),
		"not an address": "somewhere",
	}
	for name, dest := range cases {
		res := ProcessRequest(&sender, RequestTypeProcess, paddedJSON(t, withdrawCmd(tokenUSDC, 1, dest)), h.state)
		if res.Error == "" {
			t.Fatalf("%s: expected a public error", name)
		}
		if len(res.Withdrawals) != 0 {
			t.Fatalf("%s: no withdrawal may be emitted", name)
		}
	}
}

// Private rejections keep a deposit sent with a refused allocation in the vault,
// because refunding it on chain would announce the refusal. Withdrawal is how
// that money gets out.
func TestFundsFromARefusedAllocationCanBeWithdrawn(t *testing.T) {
	h := newHarness(t)
	h.deposit(depositor, tokenUSDC, 750)
	h.processExpectingRejection(depositor, PayloadInstructions{
		Command:  "allocate",
		Allocate: &AllocateCmd{StrategyID: "no-such-strategy", Amount: types.NewUint256(750), Prices: PriceSet{}},
	})

	res := h.process(depositor, withdrawCmd(tokenUSDC, 750, ""))
	if len(res.Withdrawals) != 1 || !res.Withdrawals[0].Amount.Eq(u64(750)) {
		t.Fatal("the stranded deposit must be withdrawable in full")
	}
	if c := h.load().CustodyOf(tokenUSDC); !c.IsZero() {
		t.Fatalf("custody = %s after withdrawing everything, want 0", c.String())
	}
}

// The full depositor journey, with the custody invariant checked after every
// step. It covers each way custody moves: a buy residual sent to market, a batch
// that fully internalises, a market leg that fails and sweeps everything back, a
// sell residual, redemption, and withdrawal. Every number below can be checked by
// hand; prices are 3000, so a unit of base is 3000 of quote.
func TestCustodyStaysBalancedThroughTheWholeLifecycle(t *testing.T) {
	h := newHarness(t)
	check := func(stage string) { assertCustodyBalanced(t, h.load(), stage) }
	closeBatch := func(slippageBps uint32) types.ProcessResult {
		return h.process(operator, PayloadInstructions{
			Command:    "close_batch",
			CloseBatch: &CloseBatchCmd{RefPrice: ptr(price(t, 3_000)), SlippageBps: slippageBps},
		})
	}
	settle := func(closed types.ProcessResult, fill MarketFill) {
		order, err := DecodeOrder(closed.AppEvents[0].Data)
		if err != nil {
			t.Fatalf("DecodeOrder: %v", err)
		}
		h.trusted(EncodeFill(order.BatchID, fill))
	}
	quote := func(base uint64) types.Uint256 {
		v, err := ApplyPrice(u64(base), price(t, 3_000))
		if err != nil {
			t.Fatalf("ApplyPrice: %v", err)
		}
		return v
	}
	custody := func(token types.Address, want uint64, stage string) {
		if got := h.load().CustodyOf(token); !got.Eq(u64(want)) {
			t.Fatalf("%s: custody of %s = %s, want %d", stage, token.Hex(), got.String(), want)
		}
	}

	h.process(managerA, registerCmd("alpha"))
	h.process(managerB, registerCmd("beta"))

	// Fund: alpha 100,000 and beta 50,000.
	for _, s := range []struct {
		id     string
		amount uint64
	}{{"alpha", 100_000}, {"beta", 50_000}} {
		h.deposit(depositor, tokenUSDC, s.amount)
		h.process(depositor, PayloadInstructions{
			Command:  "allocate",
			Allocate: &AllocateCmd{StrategyID: s.id, Amount: types.NewUint256(s.amount), Prices: PriceSet{}},
		})
	}
	custody(tokenUSDC, 150_000, "after funding")
	check("after funding")

	// Batch 1 — two buyers, residual buy 16. The trigger is sent the bound,
	// 16 x 3100 = 49,600, and spends 48,000.
	h.process(managerA, intentCmd("alpha", SideBuy, 10, price(t, 3_100)))
	h.process(managerB, intentCmd("beta", SideBuy, 6, price(t, 3_100)))
	batch1 := closeBatch(0)
	custody(tokenUSDC, 100_400, "with batch 1 at the trigger")
	check("with batch 1 at the trigger")

	settle(batch1, MarketFill{Base: u64(16), Quote: quote(16), Success: true})
	// 1,600 unspent quote and 16 base come back.
	custody(tokenUSDC, 102_000, "after batch 1")
	custody(tokenWETH, 16, "after batch 1")
	check("after batch 1")

	// Batch 2 — alpha buys 6 from beta. It fully internalises, so custody does
	// not move at all.
	h.process(managerA, intentCmd("alpha", SideBuy, 6, price(t, 3_100)))
	h.process(managerB, intentCmd("beta", SideSell, 6, types.Uint256{}))
	if batch2 := closeBatch(0); len(batch2.Withdrawals) != 0 {
		t.Fatal("batch 2 should have internalised")
	}
	custody(tokenUSDC, 102_000, "after batch 2")
	custody(tokenWETH, 16, "after batch 2")
	check("after batch 2")

	// Batch 3 — the market leg fails. The 31,000 sent out comes straight back.
	h.process(managerA, intentCmd("alpha", SideBuy, 5, price(t, 3_100)))
	h.process(managerB, intentCmd("beta", SideBuy, 5, price(t, 3_100)))
	batch3 := closeBatch(0)
	custody(tokenUSDC, 71_000, "with batch 3 at the trigger")
	settle(batch3, MarketFill{Success: false})
	custody(tokenUSDC, 102_000, "after batch 3 failed")
	check("after batch 3 failed")

	// Batch 4 — a sell residual. Alpha sells all 16 WETH; beta buys 1 of it
	// internally, and 15 go to market. Custody hands the trigger 15 base and
	// receives 45,000 quote.
	h.process(managerA, intentCmd("alpha", SideSell, 16, types.Uint256{}))
	h.process(managerB, intentCmd("beta", SideBuy, 1, price(t, 3_100)))
	batch4 := closeBatch(100) // sells carry no limits, so a 1% tolerance bounds it
	custody(tokenWETH, 1, "with batch 4 at the trigger")
	check("with batch 4 at the trigger")

	settle(batch4, MarketFill{Base: u64(15), Quote: quote(15), Success: true})
	custody(tokenUSDC, 147_000, "after batch 4")
	custody(tokenWETH, 1, "after batch 4")
	check("after batch 4")

	// Alpha is now all quote: 100,000. Beta holds 47,000 quote and 1 WETH, a NAV
	// of 50,000, and redemption pays from quote only, so only 47,000 of its
	// shares can be redeemed.
	h.process(depositor, PayloadInstructions{
		Command: "redeem",
		Redeem:  &RedeemCmd{StrategyID: "alpha", Shares: types.NewUint256(100_000), Prices: PriceSet{}},
	})
	check("after redeeming alpha")
	h.process(depositor, PayloadInstructions{
		Command: "redeem",
		Redeem:  &RedeemCmd{StrategyID: "beta", Shares: types.NewUint256(47_000), Prices: pricesAt(t, 3_000)},
	})
	check("after redeeming beta")

	if idle := h.load().Account(depositor).UnallocatedBalance(tokenUSDC); !idle.Eq(u64(147_000)) {
		t.Fatalf("idle balance = %s, want 147000", idle.String())
	}

	h.process(depositor, withdrawCmd(tokenUSDC, 147_000, ""))
	custody(tokenUSDC, 0, "after withdrawing")
	custody(tokenWETH, 1, "after withdrawing")
	check("after withdrawing")
}
