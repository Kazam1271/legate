package app

import (
	"strings"
	"testing"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

var managerC = addr(0x13)

// registerMultiPair registers a strategy whose mandate allows both WETH and WBTC.
func registerMultiPair(h *harness, manager types.Address, id string) {
	h.t.Helper()
	h.process(manager, PayloadInstructions{
		Command: "register_strategy",
		RegisterStrategy: &RegisterStrategyCmd{ID: id, Mandate: Mandate{
			AllowedTokens: []types.Address{tokenUSDC, tokenWETH, tokenWBTC},
		}},
	})
}

func wbtcIntentCmd(strategyID string, side Side, amount uint64, limit types.Uint256) PayloadInstructions {
	cmd := intentCmd(strategyID, side, amount, limit)
	cmd.Intent.Base = tokenWBTC.Hex()
	return cmd
}

func closeCmd(t *testing.T, base types.Address) PayloadInstructions {
	return PayloadInstructions{
		Command:    "close_batch",
		CloseBatch: &CloseBatchCmd{Base: base.Hex(), RefPrice: ptr(price(t, 3_000))},
	}
}

func cancelCmd(id string) PayloadInstructions {
	return PayloadInstructions{Command: "cancel_intent", CancelIntent: &CancelIntentCmd{IntentID: id}}
}

// pendingIDs lists the queued intent IDs in order.
func pendingIDs(h *harness) []string {
	st := h.load()
	ids := make([]string, 0, len(st.Pending))
	for _, in := range st.Pending {
		ids = append(ids, in.ID)
	}
	return ids
}

func intentIDFrom(t *testing.T, res types.ProcessResult, sender types.Address) string {
	t.Helper()
	id := onlyReceipt(t, res, sender).Detail["intentId"]
	if id == "" {
		t.Fatal("an accepted intent's receipt must carry its ID")
	}
	return id
}

// The griefing case, reproduced before the fix. A batch used to take its pair from
// the first queued intent. A strategy queuing one small intent on another pair
// first made every close refuse on the k-anonymity guard, and the refusal left the
// queue unchanged, so every later attempt refused the same way — batching stalled
// for the whole vault.
func TestAnIntentOnAnotherPairCannotBlockBatching(t *testing.T) {
	h := newHarness(t)
	h.process(managerA, registerCmd("alpha"))
	h.process(managerB, registerCmd("beta"))
	registerMultiPair(h, managerC, "gamma")
	h.fund("alpha", tokenUSDC, 1_000_000)
	h.fund("beta", tokenWETH, 60)
	h.fund("gamma", tokenUSDC, 1_000_000)

	stray := intentIDFrom(t, h.process(managerC, wbtcIntentCmd("gamma", SideBuy, 1, price(t, 3_100))), managerC)
	h.process(managerA, intentCmd("alpha", SideBuy, 100, price(t, 3_100)))
	h.process(managerB, intentCmd("beta", SideSell, 60, types.Uint256{}))

	// The WETH pair closes normally despite the WBTC intent queued ahead of it.
	res := h.process(operator, closeCmd(t, tokenWETH))
	if len(res.AppEvents) != 1 {
		t.Fatalf("expected the WETH batch to go to market, got %d orders", len(res.AppEvents))
	}
	order, err := DecodeOrder(res.AppEvents[0].Data)
	if err != nil {
		t.Fatalf("DecodeOrder: %v", err)
	}
	if order.Base != tokenWETH || !order.BaseAmount.Eq(u64(40)) {
		t.Fatalf("order = %s of %s, want the netted 40 WETH", order.BaseAmount.String(), order.Base.Hex())
	}

	// The WBTC intent is untouched and still queued.
	if ids := pendingIDs(h); len(ids) != 1 || ids[0] != stray {
		t.Fatalf("pending = %v, want only the WBTC intent %s", ids, stray)
	}

	// Its own pair is still refused, privately, because it is alone there — but
	// that no longer affects anyone else.
	receipt := h.processExpectingRejection(operator, closeCmd(t, tokenWBTC))
	if !strings.Contains(receipt.Reason, "too few contributing strategies") {
		t.Fatalf("unexpected reason: %s", receipt.Reason)
	}
}

// The quieter half of the same bug. If the stray intent was dust, its batch did not
// refuse but fully internalised — and the close then cleared the whole queue,
// silently discarding every intent on every other pair.
func TestClosingAPairThatInternalisesKeepsOtherPairsQueued(t *testing.T) {
	h := newHarness(t)
	st := h.load()
	st.Config.MinResidual = types.NewUint256(5)
	h.save(st)

	h.process(managerA, registerCmd("alpha"))
	h.process(managerB, registerCmd("beta"))
	registerMultiPair(h, managerC, "gamma")
	h.fund("alpha", tokenUSDC, 1_000_000)
	h.fund("beta", tokenWETH, 60)
	h.fund("gamma", tokenUSDC, 1_000_000)

	h.process(managerC, wbtcIntentCmd("gamma", SideBuy, 1, price(t, 3_100)))
	alphaID := intentIDFrom(t, h.process(managerA, intentCmd("alpha", SideBuy, 100, price(t, 3_100))), managerA)
	betaID := intentIDFrom(t, h.process(managerB, intentCmd("beta", SideSell, 60, types.Uint256{})), managerB)

	wbtc := h.process(operator, closeCmd(t, tokenWBTC))
	if got := onlyReceipt(t, wbtc, operator).Detail["outcome"]; got != "internalised" {
		t.Fatalf("WBTC close outcome = %q, want internalised", got)
	}

	if ids := pendingIDs(h); len(ids) != 2 || ids[0] != alphaID || ids[1] != betaID {
		t.Fatalf("pending = %v, want the WETH intents %s and %s still queued in order", ids, alphaID, betaID)
	}

	if res := h.process(operator, closeCmd(t, tokenWETH)); len(res.AppEvents) != 1 {
		t.Fatal("the WETH intents must still batch afterwards")
	}
}

// Naming the pair is the operator's choice and says nothing about confidential
// state, so getting it wrong fails publicly.
func TestCloseBatchMustNameAPair(t *testing.T) {
	h := newHarness(t)
	h.process(managerA, registerCmd("alpha"))
	h.fund("alpha", tokenUSDC, 1_000_000)
	h.process(managerA, intentCmd("alpha", SideBuy, 10, price(t, 3_100)))

	for name, base := range map[string]string{"missing": "", "not an address": "wrapped-ether"} {
		sender := operator
		res := ProcessRequest(&sender, RequestTypeProcess, paddedJSON(t, PayloadInstructions{
			Command:    "close_batch",
			CloseBatch: &CloseBatchCmd{Base: base, RefPrice: ptr(price(t, 3_000))},
		}), h.state)
		if res.Error == "" {
			t.Fatalf("%s pair: expected a public error", name)
		}
	}
}

func TestClosingAPairWithNothingQueuedIsRefusedPrivately(t *testing.T) {
	h := newHarness(t)
	h.process(managerA, registerCmd("alpha"))
	h.fund("alpha", tokenUSDC, 1_000_000)
	h.process(managerA, intentCmd("alpha", SideBuy, 10, price(t, 3_100)))

	// processExpectingRejection also asserts the WETH intent survives untouched.
	receipt := h.processExpectingRejection(operator, closeCmd(t, tokenWBTC))
	if !strings.Contains(receipt.Reason, "no pending intents") {
		t.Fatalf("unexpected reason: %s", receipt.Reason)
	}
}

// A strategy alone on a pair will never be released by the k-anonymity guard.
// Before cancellation existed, the funds its queued intent committed stayed
// committed indefinitely.
func TestCancellingAnIntentReleasesTheFundsItCommitted(t *testing.T) {
	h := newHarness(t)
	h.process(managerA, registerCmd("alpha"))
	h.fund("alpha", tokenUSDC, 310_000) // exactly one 100-unit buy at 3100

	id := intentIDFrom(t, h.process(managerA, intentCmd("alpha", SideBuy, 100, price(t, 3_100))), managerA)

	h.processExpectingRejection(operator, closeCmd(t, tokenWETH))
	if r := h.processExpectingRejection(managerA, intentCmd("alpha", SideBuy, 100, price(t, 3_100))); !strings.Contains(r.Reason, "insufficient balance") {
		t.Fatalf("the queued intent should still hold the funds, got: %s", r.Reason)
	}

	res := h.process(managerA, cancelCmd(id))
	if got := onlyReceipt(t, res, managerA); got.Status != statusAccepted {
		t.Fatalf("receipt = %+v", got)
	}
	if ids := pendingIDs(h); len(ids) != 0 {
		t.Fatalf("pending = %v after cancelling, want empty", ids)
	}

	// The same buy is affordable again.
	h.process(managerA, intentCmd("alpha", SideBuy, 100, price(t, 3_100)))
}

// Someone else's intent and a nonexistent one must be refused identically, or the
// reason would let anyone probe which intent IDs exist — and since IDs come from a
// counter, how much the vault has traded.
func TestCancellingSomeoneElsesIntentLooksLikeCancellingNothing(t *testing.T) {
	h := newHarness(t)
	h.process(managerA, registerCmd("alpha"))
	h.process(managerB, registerCmd("beta"))
	h.fund("alpha", tokenUSDC, 1_000_000)

	alphaID := intentIDFrom(t, h.process(managerA, intentCmd("alpha", SideBuy, 10, price(t, 3_100))), managerA)

	notMine := h.processExpectingRejection(managerB, cancelCmd(alphaID))
	unknown := h.processExpectingRejection(managerB, cancelCmd("intent-00000000000000ff"))

	if notMine.Reason != unknown.Reason {
		t.Fatalf("reasons differ, which lets IDs be probed:\n  someone else's: %q\n  nonexistent:    %q",
			notMine.Reason, unknown.Reason)
	}
	if ids := pendingIDs(h); len(ids) != 1 || ids[0] != alphaID {
		t.Fatalf("pending = %v, alpha's intent must survive", ids)
	}
}

func TestAnIntentAlreadySentToMarketCannotBeCancelled(t *testing.T) {
	h := newHarness(t)
	h.process(managerA, registerCmd("alpha"))
	h.process(managerB, registerCmd("beta"))
	h.fund("alpha", tokenUSDC, 1_000_000)
	h.fund("beta", tokenWETH, 60)

	alphaID := intentIDFrom(t, h.process(managerA, intentCmd("alpha", SideBuy, 100, price(t, 3_100))), managerA)
	h.process(managerB, intentCmd("beta", SideSell, 60, types.Uint256{}))
	closed := h.process(operator, closeCmd(t, tokenWETH))

	own := h.processExpectingRejection(managerA, cancelCmd(alphaID))
	if !strings.Contains(own.Reason, "already in a batch") {
		t.Fatalf("the manager should learn why: %s", own.Reason)
	}

	// Anyone else gets the same answer as for an intent that does not exist.
	other := h.processExpectingRejection(managerB, cancelCmd(alphaID))
	if !strings.Contains(other.Reason, "no such pending intent") {
		t.Fatalf("unexpected reason for a non-manager: %s", other.Reason)
	}

	// Settlement is unaffected by the refused cancellations.
	order, err := DecodeOrder(closed.AppEvents[0].Data)
	if err != nil {
		t.Fatalf("DecodeOrder: %v", err)
	}
	marketQuote, err := ApplyPrice(u64(40), price(t, 3_000))
	if err != nil {
		t.Fatalf("ApplyPrice: %v", err)
	}
	h.trusted(EncodeFill(order.BatchID, MarketFill{Base: u64(40), Quote: marketQuote, Success: true}))
	if alpha, _ := h.load().Strategy("alpha"); !alpha.Balance(tokenWETH).Eq(u64(100)) {
		t.Fatalf("alpha base = %s after settlement, want 100", alpha.Balance(tokenWETH).String())
	}
}

func TestCancelIntentMustNameAnIntent(t *testing.T) {
	h := newHarness(t)
	sender := managerA
	res := ProcessRequest(&sender, RequestTypeProcess, paddedJSON(t, cancelCmd("")), h.state)
	if res.Error == "" {
		t.Fatal("a cancellation with no intent ID must fail publicly")
	}
}
