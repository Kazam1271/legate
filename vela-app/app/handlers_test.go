package app

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

var operator = addr(0x31)

// harness threads JSON state between calls the way the Vela Executor does:
// every export receives the current state and returns the next one.
type harness struct {
	t     *testing.T
	state string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{t: t}

	res := Deploy(1, mustJSON(t, DeployParams{
		TriggerContract: triggerAddr.Hex(),
		QuoteToken:      tokenUSDC.Hex(),
		Operator:        operator.Hex(),
		MinContributors: 2,
		MinResidual:     types.NewUint256(0),
	}))
	if res.Error != "" {
		t.Fatalf("deploy: %s", res.Error)
	}
	h.state = string(res.State)
	return h
}

var triggerAddr = addr(0x99)

func (h *harness) deposit(sender, token types.Address, amount uint64) types.DepositResult {
	h.t.Helper()
	v := u64(amount)
	res := DepositFunds(&sender, &token, &v, h.state)
	if res.Error != "" {
		h.t.Fatalf("deposit: %s", res.Error)
	}
	h.state = string(res.State)
	return res
}

func (h *harness) process(sender types.Address, instr PayloadInstructions) types.ProcessResult {
	h.t.Helper()
	res := ProcessRequest(&sender, RequestTypeProcess, paddedJSON(h.t, instr), h.state)
	if res.Error != "" {
		h.t.Fatalf("process %q: %s", instr.Command, res.Error)
	}
	h.state = string(res.State)
	return res
}

// processExpectingError runs a command that should be rejected.
func (h *harness) processExpectingError(sender types.Address, instr PayloadInstructions) string {
	h.t.Helper()
	res := ProcessRequest(&sender, RequestTypeProcess, paddedJSON(h.t, instr), h.state)
	if res.Error == "" {
		h.t.Fatalf("process %q: expected an error, got none", instr.Command)
	}
	return res.Error
}

func (h *harness) trusted(payload []byte) types.ProcessResult {
	h.t.Helper()
	res := TrustedRequest(string(payload), h.state)
	if res.Error != "" {
		h.t.Fatalf("trusted_request: %s", res.Error)
	}
	h.state = string(res.State)
	return res
}

// fund credits a strategy directly, standing in for positions it would
// otherwise have acquired by trading in an earlier batch.
func (h *harness) fund(strategyID string, token types.Address, amount uint64) {
	h.t.Helper()
	st := h.load()
	s, err := st.Strategy(strategyID)
	if err != nil {
		h.t.Fatalf("fund: %v", err)
	}
	if err := s.credit(token, u64(amount)); err != nil {
		h.t.Fatalf("fund: %v", err)
	}
	h.save(st)
}

func (h *harness) load() *ApplicationInternalState {
	h.t.Helper()
	st, err := loadState(h.state)
	if err != nil {
		h.t.Fatalf("load state: %v", err)
	}
	return st
}

func (h *harness) save(st *ApplicationInternalState) {
	h.t.Helper()
	h.state = mustJSON(h.t, st)
}

func mustJSON(t *testing.T, v interface{}) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

// paddedJSON encodes a command the way a real client must: padded to the fixed
// size, so its length reveals nothing.
func paddedJSON(t *testing.T, v interface{}) string {
	t.Helper()
	padded, err := PadPayload([]byte(mustJSON(t, v)))
	if err != nil {
		t.Fatalf("pad: %v", err)
	}
	return string(padded)
}

// Every command, whatever it says, must be the same length on the wire.
func TestAllCommandsPadToTheSameLength(t *testing.T) {
	commands := []PayloadInstructions{
		intentCmd("alpha", SideBuy, 10, price(t, 3_100)),
		intentCmd("beta", SideSell, 6, types.Uint256{}),
		registerCmd("a-much-longer-strategy-identifier"),
		{Command: "close_batch", CloseBatch: &CloseBatchCmd{RefPrice: ptr(price(t, 3_000))}},
		{Command: "allocate", Allocate: &AllocateCmd{
			StrategyID: "alpha", Amount: types.NewUint256(1), Prices: pricesAt(t, 3_000),
		}},
	}
	for _, c := range commands {
		if got := len(paddedJSON(t, c)); got != PaddedPayloadSize {
			t.Fatalf("%s padded to %d bytes, want %d", c.Command, got, PaddedPayloadSize)
		}
	}
}

// Accepting short payloads would let one careless client leak its own intents,
// so the enclave refuses them rather than tolerating them.
func TestUnpaddedPayloadIsRejected(t *testing.T) {
	h := newHarness(t)
	h.process(managerA, registerCmd("alpha"))

	sender := managerA
	unpadded := mustJSON(t, intentCmd("alpha", SideBuy, 1, price(t, 3_100)))
	res := ProcessRequest(&sender, RequestTypeProcess, unpadded, h.state)

	if res.Error == "" {
		t.Fatal("an unpadded payload must be rejected")
	}
	if !strings.Contains(res.Error, "padded") {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if strings.Contains(res.Error, "1024") || strings.Contains(res.Error, "bytes") {
		t.Fatalf("the public error must not restate lengths: %s", res.Error)
	}
}

func TestOverlongPayloadIsRejected(t *testing.T) {
	h := newHarness(t)
	sender := managerA
	res := ProcessRequest(&sender, RequestTypeProcess, strings.Repeat(" ", PaddedPayloadSize+1), h.state)
	if res.Error == "" {
		t.Fatal("a payload longer than the fixed size must be rejected")
	}
}

func TestPadPayloadRefusesCommandsThatDoNotFit(t *testing.T) {
	if _, err := PadPayload(make([]byte, PaddedPayloadSize+1)); err != ErrPayloadTooLarge {
		t.Fatalf("expected ErrPayloadTooLarge, got %v", err)
	}
}

// Padding must be whitespace. Anything else after the JSON value is not a padded
// command but a malformed one.
func TestNonWhitespacePaddingIsRejected(t *testing.T) {
	h := newHarness(t)
	sender := managerA

	body := []byte(mustJSON(t, registerCmd("alpha")))
	payload := make([]byte, PaddedPayloadSize)
	copy(payload, body)
	for i := len(body); i < PaddedPayloadSize; i++ {
		payload[i] = 'x'
	}

	res := ProcessRequest(&sender, RequestTypeProcess, string(payload), h.state)
	if res.Error == "" {
		t.Fatal("non-whitespace padding must be rejected")
	}
}

func registerCmd(id string) PayloadInstructions {
	return PayloadInstructions{
		Command: "register_strategy",
		RegisterStrategy: &RegisterStrategyCmd{
			ID: id,
			Mandate: Mandate{
				AllowedTokens:   []types.Address{tokenUSDC, tokenWETH},
				MaxOrderBase:    types.NewUint256(10_000),
				MaxPositionBase: types.NewUint256(100_000),
			},
		},
	}
}

func intentCmd(strategyID string, side Side, amount uint64, limit types.Uint256) PayloadInstructions {
	return PayloadInstructions{
		Command: "submit_intent",
		Intent: &IntentCmd{
			StrategyID: strategyID,
			Base:       tokenWETH.Hex(),
			Side:       side,
			Amount:     types.NewUint256(amount),
			LimitPrice: &limit,
		},
	}
}

// TestEndToEndBatchLifecycle runs a whole batch through the real execution path:
// deploy, deposit, allocate, two strategies submitting opposing intents, the
// batch closing into a single public order, and the trigger's fill settling it.
//
// This is the M1 demonstration in test form. The assertion that matters is the
// one on the emitted order: the chain sees 40, not the 100 and 60 that produced
// it.
func TestEndToEndBatchLifecycle(t *testing.T) {
	h := newHarness(t)

	// Two strategies, each registered by its own manager.
	h.process(managerA, registerCmd("alpha"))
	h.process(managerB, registerCmd("beta"))

	// A depositor funds alpha.
	h.deposit(depositor, tokenUSDC, 500_000)
	h.process(depositor, PayloadInstructions{
		Command: "allocate",
		Allocate: &AllocateCmd{
			StrategyID: "alpha",
			Amount:     types.NewUint256(500_000),
			Prices:     pricesAt(t, 3_000),
		},
	})

	// Beta already holds the asset it is about to sell.
	h.fund("beta", tokenWETH, 60)

	// Opposing intents: alpha buys 100, beta sells 60.
	h.process(managerA, intentCmd("alpha", SideBuy, 100, price(t, 3_100)))
	h.process(managerB, intentCmd("beta", SideSell, 60, types.Uint256{}))

	// Close the batch.
	res := h.process(operator, PayloadInstructions{
		Command:    "close_batch",
		CloseBatch: &CloseBatchCmd{RefPrice: ptr(price(t, 3_000))},
	})

	// Exactly one order reaches the chain.
	if len(res.AppEvents) != 1 {
		t.Fatalf("expected exactly one public order, got %d", len(res.AppEvents))
	}
	order, err := DecodeOrder(res.AppEvents[0].Data)
	if err != nil {
		t.Fatalf("DecodeOrder: %v", err)
	}

	// The netted residual, not either strategy's order.
	if !order.BaseAmount.Eq(u64(40)) {
		t.Fatalf("public order size = %s, want 40 (the net of 100 buy and 60 sell)", order.BaseAmount.String())
	}
	if order.Side != SideBuy {
		t.Fatalf("public order side = %s, want buy", order.Side)
	}

	// The quote limit is the tightest participant ceiling: 40 * 3100.
	wantLimit, err := ApplyPrice(u64(40), price(t, 3_100))
	if err != nil {
		t.Fatalf("ApplyPrice: %v", err)
	}
	if !order.QuoteLimit.Eq(wantLimit) {
		t.Fatalf("quote limit = %s, want %s", order.QuoteLimit.String(), wantLimit.String())
	}

	// Funds move to the trigger so it can execute.
	if len(res.Withdrawals) != 1 {
		t.Fatalf("expected one withdrawal, got %d", len(res.Withdrawals))
	}
	w := res.Withdrawals[0]
	if w.DestinationAddress != triggerAddr {
		t.Fatalf("withdrawal went to %s, want the trigger", w.DestinationAddress.Hex())
	}
	if w.TokenAddress != tokenUSDC || !w.Amount.Eq(wantLimit) {
		t.Fatalf("withdrawal = %s of %s, want %s of quote", w.Amount.String(), w.TokenAddress.Hex(), wantLimit.String())
	}

	// The trigger executes at the reference price and reports back.
	marketQuote, err := ApplyPrice(u64(40), price(t, 3_000))
	if err != nil {
		t.Fatalf("ApplyPrice: %v", err)
	}
	settleRes := h.trusted(EncodeFill(order.BatchID, MarketFill{
		Base: u64(40), Quote: marketQuote, Success: true,
	}))

	// A trusted request must emit no AppEvents, or the trigger loop never ends.
	if len(settleRes.AppEvents) != 0 {
		t.Fatalf("trusted_request emitted %d app events; the trigger loop would not terminate", len(settleRes.AppEvents))
	}
	// Each manager is told privately what their own strategy got.
	if len(settleRes.Events) != 2 {
		t.Fatalf("expected one private event per strategy, got %d", len(settleRes.Events))
	}

	// Final positions: alpha holds the full 100 it asked for, beta has sold 60.
	st := h.load()
	alpha, _ := st.Strategy("alpha")
	beta, _ := st.Strategy("beta")

	if !alpha.Balance(tokenWETH).Eq(u64(100)) {
		t.Fatalf("alpha base = %s, want 100", alpha.Balance(tokenWETH).String())
	}
	if !beta.Balance(tokenWETH).IsZero() {
		t.Fatalf("beta base = %s, want 0", beta.Balance(tokenWETH).String())
	}
	// Everyone cleared at 3000: alpha paid 300k, beta received 180k.
	if !alpha.Balance(tokenUSDC).Eq(u64(200_000)) {
		t.Fatalf("alpha quote = %s, want 200000", alpha.Balance(tokenUSDC).String())
	}
	if !beta.Balance(tokenUSDC).Eq(u64(180_000)) {
		t.Fatalf("beta quote = %s, want 180000", beta.Balance(tokenUSDC).String())
	}

	// The batch is closed out, so a replay finds nothing.
	if len(st.Open) != 0 {
		t.Fatalf("expected no open batches, got %d", len(st.Open))
	}
}

// A batch that cancels out entirely publishes nothing at all — no order, no
// withdrawal. This is the strongest privacy outcome the design can produce.
func TestFullyInternalisedBatchPublishesNothing(t *testing.T) {
	h := newHarness(t)

	h.process(managerA, registerCmd("alpha"))
	h.process(managerB, registerCmd("beta"))

	h.fund("alpha", tokenUSDC, 1_000_000)
	h.fund("beta", tokenWETH, 100)

	h.process(managerA, intentCmd("alpha", SideBuy, 100, price(t, 3_100)))
	h.process(managerB, intentCmd("beta", SideSell, 100, types.Uint256{}))

	res := h.process(operator, PayloadInstructions{
		Command:    "close_batch",
		CloseBatch: &CloseBatchCmd{RefPrice: ptr(price(t, 3_000))},
	})

	if len(res.AppEvents) != 0 {
		t.Fatalf("a fully internalised batch must publish no order, got %d", len(res.AppEvents))
	}
	if len(res.Withdrawals) != 0 {
		t.Fatalf("a fully internalised batch must move no funds on chain, got %d", len(res.Withdrawals))
	}

	// It still settles: the assets changed hands inside the enclave.
	st := h.load()
	alpha, _ := st.Strategy("alpha")
	beta, _ := st.Strategy("beta")
	if !alpha.Balance(tokenWETH).Eq(u64(100)) {
		t.Fatalf("alpha base = %s, want 100", alpha.Balance(tokenWETH).String())
	}
	if !beta.Balance(tokenWETH).IsZero() {
		t.Fatalf("beta base = %s, want 0", beta.Balance(tokenWETH).String())
	}
	if len(st.Open) != 0 {
		t.Fatal("an internalised batch should not stay open")
	}
}

// Settling twice must not pay out twice.
func TestReplayedSettlementIsRejected(t *testing.T) {
	h := newHarness(t)

	h.process(managerA, registerCmd("alpha"))
	h.process(managerB, registerCmd("beta"))
	h.fund("alpha", tokenUSDC, 1_000_000)
	h.fund("beta", tokenWETH, 60)

	h.process(managerA, intentCmd("alpha", SideBuy, 100, price(t, 3_100)))
	h.process(managerB, intentCmd("beta", SideSell, 60, types.Uint256{}))

	res := h.process(operator, PayloadInstructions{
		Command:    "close_batch",
		CloseBatch: &CloseBatchCmd{RefPrice: ptr(price(t, 3_000))},
	})
	order, err := DecodeOrder(res.AppEvents[0].Data)
	if err != nil {
		t.Fatalf("DecodeOrder: %v", err)
	}

	marketQuote, err := ApplyPrice(u64(40), price(t, 3_000))
	if err != nil {
		t.Fatalf("ApplyPrice: %v", err)
	}
	payload := EncodeFill(order.BatchID, MarketFill{Base: u64(40), Quote: marketQuote, Success: true})

	h.trusted(payload) // first settlement succeeds

	replay := TrustedRequest(string(payload), h.state)
	if replay.Error == "" {
		t.Fatal("a replayed settlement must be rejected")
	}
	if !strings.Contains(replay.Error, "unknown or already-settled batch") {
		t.Fatalf("unexpected error: %s", replay.Error)
	}
}

func TestOnlyTheOperatorMayCloseABatch(t *testing.T) {
	h := newHarness(t)

	h.process(managerA, registerCmd("alpha"))
	h.process(managerB, registerCmd("beta"))
	h.fund("alpha", tokenUSDC, 1_000_000)
	h.fund("beta", tokenWETH, 60)

	h.process(managerA, intentCmd("alpha", SideBuy, 100, price(t, 3_100)))
	h.process(managerB, intentCmd("beta", SideSell, 60, types.Uint256{}))

	err := h.processExpectingError(managerA, PayloadInstructions{
		Command:    "close_batch",
		CloseBatch: &CloseBatchCmd{RefPrice: ptr(price(t, 3_000))},
	})
	if !strings.Contains(err, "only the operator") {
		t.Fatalf("unexpected error: %s", err)
	}
}

// Funds committed to a batch already sent to market are spoken for, even though
// the ledger still shows them until settlement lands.
func TestFundsInAnOpenBatchCannotBeSpentAgain(t *testing.T) {
	h := newHarness(t)

	h.process(managerA, registerCmd("alpha"))
	h.process(managerB, registerCmd("beta"))

	// Enough quote for exactly one 100-unit buy at 3100.
	h.fund("alpha", tokenUSDC, 310_000)
	h.fund("beta", tokenWETH, 60)

	h.process(managerA, intentCmd("alpha", SideBuy, 100, price(t, 3_100)))
	h.process(managerB, intentCmd("beta", SideSell, 60, types.Uint256{}))

	h.process(operator, PayloadInstructions{
		Command:    "close_batch",
		CloseBatch: &CloseBatchCmd{RefPrice: ptr(price(t, 3_000))},
	})

	// The batch is in flight. Alpha's money is committed even though its
	// balance has not been debited yet.
	errMsg := h.processExpectingError(managerA, intentCmd("alpha", SideBuy, 100, price(t, 3_100)))
	if !strings.Contains(errMsg, "insufficient balance") {
		t.Fatalf("unexpected error: %s", errMsg)
	}
}

func TestDeanonymizationProducesAReport(t *testing.T) {
	h := newHarness(t)
	h.process(managerA, registerCmd("alpha"))
	h.fund("alpha", tokenUSDC, 1_234)

	auditor := addr(0x41)
	res := ProcessRequest(&auditor, RequestTypeDeanonymization, "", h.state)
	if res.Error != "" {
		t.Fatalf("deanonymization: %s", res.Error)
	}
	if len(res.Report) == 0 {
		t.Fatal("a deanonymization request must return a report")
	}

	var report struct {
		Strategies []struct {
			ID       string            `json:"id"`
			Balances map[string]string `json:"balances"`
		} `json:"strategies"`
	}
	if err := json.Unmarshal(res.Report, &report); err != nil {
		t.Fatalf("report is not valid JSON: %v", err)
	}
	if len(report.Strategies) != 1 || report.Strategies[0].ID != "alpha" {
		t.Fatalf("unexpected report contents: %s", string(res.Report))
	}
}

func TestUnknownCommandIsRejected(t *testing.T) {
	h := newHarness(t)
	errMsg := h.processExpectingError(managerA, PayloadInstructions{Command: "drain_everything"})
	if !strings.Contains(errMsg, "unsupported command") {
		t.Fatalf("unexpected error: %s", errMsg)
	}
}

func TestDeployRejectsBadParameters(t *testing.T) {
	res := Deploy(1, `{"quoteToken":"not-an-address"}`)
	if res.Error == "" {
		t.Fatal("expected an error for a malformed quote token")
	}
}

// State crosses the WASM boundary as JSON on every call, so it must survive a
// round trip intact.
func TestStateSurvivesSerialisation(t *testing.T) {
	h := newHarness(t)
	h.process(managerA, registerCmd("alpha"))
	h.deposit(depositor, tokenUSDC, 5_000)
	h.process(depositor, PayloadInstructions{
		Command: "allocate",
		Allocate: &AllocateCmd{
			StrategyID: "alpha",
			Amount:     types.NewUint256(5_000),
			Prices:     pricesAt(t, 3_000),
		},
	})

	st := h.load()
	round := mustJSON(t, st)

	again, err := loadState(round)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}

	s, err := again.Strategy("alpha")
	if err != nil {
		t.Fatalf("strategy lost in round trip: %v", err)
	}
	if !s.Balance(tokenUSDC).Eq(u64(5_000)) {
		t.Fatalf("balance after round trip = %s, want 5000", s.Balance(tokenUSDC).String())
	}
	if s.Manager != managerA {
		t.Fatal("manager lost in round trip")
	}
	if again.Operator != operator.Hex() {
		t.Fatal("operator lost in round trip")
	}
	if again.QuoteToken != tokenUSDC {
		t.Fatal("quote token lost in round trip")
	}
}
