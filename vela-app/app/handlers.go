package app

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

// Vela request types, as passed to process_request by the Executor.
const (
	RequestTypeProcess         int32 = 1
	RequestTypeDeanonymization int32 = 2
)

// Event subtypes. These become indexed log topics, so they must not leak
// anything sensitive; they are coarse labels only.
const (
	subtypeDeposit    = "deposit"
	subtypeAllocated  = "allocated"
	subtypeRedeemed   = "redeemed"
	subtypeIntent     = "intent_accepted"
	subtypeBatchOrder = "batch_order"
	subtypeFills      = "fills"
)

// Fuel costs, roughly proportional to the work each operation does.
var (
	fuelDeploy  = types.NewUint256(5)
	fuelDeposit = types.NewUint256(35)
	fuelProcess = types.NewUint256(60)
	fuelBatch   = types.NewUint256(120)
	fuelSettle  = types.NewUint256(90)
	fuelReport  = types.NewUint256(75)
)

var (
	ErrNotOperator      = errors.New("only the operator may perform this action")
	ErrUnknownCommand   = errors.New("unsupported command")
	ErrNoPendingIntents = errors.New("no pending intents to batch")
)

// DeployParams are the constructor parameters, supplied in the deploy
// descriptor's constructorParams field.
type DeployParams struct {
	// TriggerContract must match the trigger registered on chain by
	// submitDeployRequestWithTrigger. Both sides are required: the on-chain
	// wiring makes the endpoint call the trigger, and this copy lets the app
	// address withdrawals to it.
	TriggerContract string `json:"triggerContract"`

	// QuoteToken is the asset deposits and NAV are denominated in.
	QuoteToken string `json:"quoteToken"`

	// Operator may close batches. Who holds this is a live design question:
	// it centralises batch timing, and timing is itself a signal.
	Operator string `json:"operator"`

	MinContributors int            `json:"minContributors"`
	MinResidual     *types.Uint256 `json:"minResidual"`
}

// PayloadInstructions is the decrypted user payload for process_request.
type PayloadInstructions struct {
	Command string `json:"command"`

	RegisterStrategy *RegisterStrategyCmd `json:"registerStrategy,omitempty"`
	Allocate         *AllocateCmd         `json:"allocate,omitempty"`
	Redeem           *RedeemCmd           `json:"redeem,omitempty"`
	Intent           *IntentCmd           `json:"intent,omitempty"`
	CloseBatch       *CloseBatchCmd       `json:"closeBatch,omitempty"`
}

type RegisterStrategyCmd struct {
	ID      string  `json:"id"`
	Mandate Mandate `json:"mandate"`
}

type AllocateCmd struct {
	StrategyID string         `json:"strategyId"`
	Amount     *types.Uint256 `json:"amount"`
	Prices     PriceSet       `json:"prices"`
}

type RedeemCmd struct {
	StrategyID string         `json:"strategyId"`
	Shares     *types.Uint256 `json:"shares"`
	Prices     PriceSet       `json:"prices"`
}

type IntentCmd struct {
	StrategyID string         `json:"strategyId"`
	Base       string         `json:"base"`
	Side       Side           `json:"side"`
	Amount     *types.Uint256 `json:"amount"`
	LimitPrice *types.Uint256 `json:"limitPrice"`
}

type CloseBatchCmd struct {
	// RefPrice is the reference price the batch is netted at. The enclave
	// cannot fetch a price, so it is supplied with the request; the per-intent
	// limit prices and the trigger's on-chain bound are what stop a bad one
	// doing damage.
	RefPrice *types.Uint256 `json:"refPrice"`

	// SlippageBps bounds execution when participants set no limit of their own.
	SlippageBps uint32 `json:"slippageBps"`
}

// Deploy initialises state from the constructor parameters.
func Deploy(appID int64, paramsJSON string) types.DeployResult {
	var params DeployParams
	if paramsJSON != "" && paramsJSON != "{}" {
		if err := json.Unmarshal([]byte(paramsJSON), &params); err != nil {
			return types.DeployResult{Error: fmt.Sprintf("deploy: bad params: %v", err)}
		}
	}

	quote, err := types.HexToAddress(params.QuoteToken)
	if err != nil {
		return types.DeployResult{Error: fmt.Sprintf("deploy: bad quoteToken: %v", err)}
	}

	trigger := ""
	if params.TriggerContract != "" {
		addr, err := types.HexToAddress(params.TriggerContract)
		if err != nil {
			return types.DeployResult{Error: fmt.Sprintf("deploy: bad triggerContract: %v", err)}
		}
		trigger = addr.Hex()
	}

	cfg := NettingConfig{
		MinContributors: params.MinContributors,
		MinResidual:     params.MinResidual,
	}

	st := NewState(uint64(appID), trigger, quote, cfg)

	if params.Operator != "" {
		op, err := types.HexToAddress(params.Operator)
		if err != nil {
			return types.DeployResult{Error: fmt.Sprintf("deploy: bad operator: %v", err)}
		}
		st.Operator = op.Hex()
	}

	stateJSON, err := json.Marshal(st)
	if err != nil {
		return types.DeployResult{Error: fmt.Sprintf("deploy: %v", err)}
	}
	return types.DeployResult{State: stateJSON, Fuel: fuelDeploy}
}

// LoadModule rebuilds a default state. The Executor calls this only to warm its
// cache on restart; real deployments go through Deploy.
func LoadModule(appID int64) types.LoadModuleResult {
	st := NewState(uint64(appID), "", types.Address{}, NettingConfig{})
	stateJSON, err := json.Marshal(st)
	if err != nil {
		return types.LoadModuleResult{Error: fmt.Sprintf("load_module: %v", err)}
	}
	return types.LoadModuleResult{State: stateJSON, Fuel: fuelDeploy}
}

// DepositFunds credits an incoming transfer to the sender's idle balance.
func DepositFunds(sender, token *types.Address, value *types.Uint256, stateJSON string) types.DepositResult {
	if sender == nil || token == nil || value == nil {
		return types.DepositResult{Error: "deposit: nil argument"}
	}

	st, err := loadState(stateJSON)
	if err != nil {
		return types.DepositResult{Error: err.Error()}
	}

	if err := st.Deposit(*sender, *token, *value); err != nil {
		return types.DepositResult{Error: fmt.Sprintf("deposit: %v", err)}
	}

	balance := st.Account(*sender).UnallocatedBalance(*token)
	event, err := userEvent(*sender, subtypeDeposit, map[string]interface{}{
		"type":         subtypeDeposit,
		"token":        token.Hex(),
		"balanceAfter": balance.ToHex(),
	})
	if err != nil {
		return types.DepositResult{Error: err.Error()}
	}

	out, err := json.Marshal(st)
	if err != nil {
		return types.DepositResult{Error: fmt.Sprintf("deposit: %v", err)}
	}
	return types.DepositResult{State: out, Events: []types.PlainEvent{event}, Fuel: fuelDeposit}
}

// ProcessRequest handles user commands and deanonymisation requests.
func ProcessRequest(sender *types.Address, requestType int32, payloadJSON, stateJSON string) types.ProcessResult {
	if sender == nil {
		return types.ProcessResult{Error: "process: missing sender"}
	}

	st, err := loadState(stateJSON)
	if err != nil {
		return types.ProcessResult{Error: err.Error()}
	}

	if requestType == RequestTypeDeanonymization {
		return handleDeanonymization(st)
	}

	var instr PayloadInstructions
	if payloadJSON != "" && payloadJSON != "{}" {
		if err := json.Unmarshal([]byte(payloadJSON), &instr); err != nil {
			return types.ProcessResult{Error: fmt.Sprintf("process: bad payload: %v", err)}
		}
	}

	switch instr.Command {
	case "register_strategy":
		return handleRegisterStrategy(st, *sender, instr.RegisterStrategy)
	case "allocate":
		return handleAllocate(st, *sender, instr.Allocate)
	case "redeem":
		return handleRedeem(st, *sender, instr.Redeem)
	case "submit_intent":
		return handleSubmitIntent(st, *sender, instr.Intent)
	case "close_batch":
		return handleCloseBatch(st, *sender, instr.CloseBatch)
	default:
		return types.ProcessResult{Error: fmt.Sprintf("process: %v: %q", ErrUnknownCommand, instr.Command)}
	}
}

// TrustedRequest settles a batch once the trigger has executed its order.
//
// The payload is clear text produced on chain by the trigger, not by a user.
// It emits no AppEvents, which is what makes the trigger return an empty
// payload next time and terminates the TRUSTPROCESS round trip.
func TrustedRequest(payload, stateJSON string) types.ProcessResult {
	st, err := loadState(stateJSON)
	if err != nil {
		return types.ProcessResult{Error: err.Error()}
	}

	batchID, fill, err := DecodeFill([]byte(payload))
	if err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("trusted_request: %v", err)}
	}

	key := hex.EncodeToString(batchID[:])
	open, ok := st.Open[key]
	if !ok || open == nil {
		// Idempotency: the batch was already settled and removed, so a replayed
		// or duplicated TRUSTPROCESS finds nothing rather than paying twice.
		return types.ProcessResult{Error: fmt.Sprintf("trusted_request: %v", ErrNoSuchBatch)}
	}
	delete(st.Open, key)

	settlement, err := SettleBatch(&open.Plan, key, fill)
	if err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("trusted_request: %v", err)}
	}
	if err := st.ApplySettlement(&open.Plan, settlement); err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("trusted_request: %v", err)}
	}

	events, err := fillEvents(st, settlement)
	if err != nil {
		return types.ProcessResult{Error: err.Error()}
	}

	out, err := json.Marshal(st)
	if err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("trusted_request: %v", err)}
	}

	// No AppEvents: this is what terminates the trigger loop.
	return types.ProcessResult{State: out, Events: events, Fuel: fuelSettle}
}

func handleRegisterStrategy(st *ApplicationInternalState, sender types.Address, cmd *RegisterStrategyCmd) types.ProcessResult {
	if cmd == nil {
		return types.ProcessResult{Error: "register_strategy: missing parameters"}
	}
	if _, err := st.RegisterStrategy(cmd.ID, sender, cmd.Mandate); err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("register_strategy: %v", err)}
	}
	return finish(st, nil, nil, nil, fuelProcess)
}

func handleAllocate(st *ApplicationInternalState, sender types.Address, cmd *AllocateCmd) types.ProcessResult {
	if cmd == nil || cmd.Amount == nil {
		return types.ProcessResult{Error: "allocate: missing parameters"}
	}

	issued, err := st.Allocate(sender, cmd.StrategyID, *cmd.Amount, cmd.Prices)
	if err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("allocate: %v", err)}
	}

	event, err := userEvent(sender, subtypeAllocated, map[string]interface{}{
		"type":       subtypeAllocated,
		"strategyId": cmd.StrategyID,
		"shares":     issued.ToHex(),
	})
	if err != nil {
		return types.ProcessResult{Error: err.Error()}
	}
	return finish(st, []types.PlainEvent{event}, nil, nil, fuelProcess)
}

func handleRedeem(st *ApplicationInternalState, sender types.Address, cmd *RedeemCmd) types.ProcessResult {
	if cmd == nil || cmd.Shares == nil {
		return types.ProcessResult{Error: "redeem: missing parameters"}
	}

	value, err := st.Redeem(sender, cmd.StrategyID, *cmd.Shares, cmd.Prices)
	if err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("redeem: %v", err)}
	}

	event, err := userEvent(sender, subtypeRedeemed, map[string]interface{}{
		"type":       subtypeRedeemed,
		"strategyId": cmd.StrategyID,
		"value":      value.ToHex(),
	})
	if err != nil {
		return types.ProcessResult{Error: err.Error()}
	}
	return finish(st, []types.PlainEvent{event}, nil, nil, fuelProcess)
}

func handleSubmitIntent(st *ApplicationInternalState, sender types.Address, cmd *IntentCmd) types.ProcessResult {
	if cmd == nil || cmd.Amount == nil {
		return types.ProcessResult{Error: "submit_intent: missing parameters"}
	}

	base, err := types.HexToAddress(cmd.Base)
	if err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("submit_intent: bad base: %v", err)}
	}

	limit := types.Uint256{}
	if cmd.LimitPrice != nil {
		limit = *cmd.LimitPrice
	}

	accepted, err := st.SubmitIntent(sender, Intent{
		StrategyID: cmd.StrategyID,
		Base:       base,
		Quote:      st.QuoteToken,
		Side:       cmd.Side,
		Amount:     cmd.Amount,
		LimitPrice: &limit,
	})
	if err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("submit_intent: %v", err)}
	}

	// The acknowledgement reveals only that this strategist's intent was
	// accepted, and goes only to them.
	event, err := userEvent(sender, subtypeIntent, map[string]interface{}{
		"type":     subtypeIntent,
		"intentId": accepted.ID,
	})
	if err != nil {
		return types.ProcessResult{Error: err.Error()}
	}
	return finish(st, []types.PlainEvent{event}, nil, nil, fuelProcess)
}

// handleCloseBatch nets the pending intents and, if anything is left over,
// sends exactly one order to market.
func handleCloseBatch(st *ApplicationInternalState, sender types.Address, cmd *CloseBatchCmd) types.ProcessResult {
	if cmd == nil || cmd.RefPrice == nil {
		return types.ProcessResult{Error: "close_batch: missing parameters"}
	}
	if st.Operator != "" && st.Operator != sender.Hex() {
		return types.ProcessResult{Error: fmt.Sprintf("close_batch: %v", ErrNotOperator)}
	}
	if len(st.Pending) == 0 {
		return types.ProcessResult{Error: fmt.Sprintf("close_batch: %v", ErrNoPendingIntents)}
	}

	plan, err := NetBatch(st.Pending, *cmd.RefPrice, st.Config)
	if err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("close_batch: %v", err)}
	}

	st.BatchNonce++
	batchID := batchIDFromNonce(st.BatchNonce)
	key := hex.EncodeToString(batchID[:])

	// Intents that made it into the batch are consumed; anything excluded is
	// dropped rather than silently carried forward into a later batch at a
	// price its author never agreed to.
	st.Pending = nil

	// A fully internalised batch never reaches the market, so it settles
	// immediately and nothing at all is published.
	if plan.FullyInternalised {
		settlement, err := SettleBatch(plan, key, MarketFill{Success: true})
		if err != nil {
			return types.ProcessResult{Error: fmt.Sprintf("close_batch: %v", err)}
		}
		if err := st.ApplySettlement(plan, settlement); err != nil {
			return types.ProcessResult{Error: fmt.Sprintf("close_batch: %v", err)}
		}
		events, err := fillEvents(st, settlement)
		if err != nil {
			return types.ProcessResult{Error: err.Error()}
		}
		return finish(st, events, nil, nil, fuelBatch)
	}

	if st.TriggerAddress == "" {
		return types.ProcessResult{Error: "close_batch: no trigger contract configured"}
	}
	triggerAddr, err := types.HexToAddress(st.TriggerAddress)
	if err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("close_batch: bad trigger address: %v", err)}
	}

	quoteLimit, err := QuoteLimitFor(plan, cmd.SlippageBps)
	if err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("close_batch: %v", err)}
	}

	st.Open[key] = &OpenBatch{ID: key, Plan: *plan}

	order := Order{
		BatchID:    batchID,
		Side:       plan.ResidualSide,
		Base:       plan.Base,
		Quote:      plan.Quote,
		BaseAmount: plan.ResidualBase,
		QuoteLimit: quoteLimit,
	}

	// Move the funds the trigger needs into it. Buying spends quote up to the
	// limit; selling hands over the base being sold. Anything unspent is swept
	// back by the platform after execution.
	withdrawToken := plan.Quote
	withdrawAmount := quoteLimit
	if plan.ResidualSide == SideSell {
		withdrawToken = plan.Base
		withdrawAmount = plan.ResidualBase
	}

	withdrawals := []types.Withdrawal{{
		TokenAddress:       withdrawToken,
		DestinationAddress: triggerAddr,
		Amount:             &withdrawAmount,
	}}

	// The order is a plaintext AppEvent, visible to everyone. It describes
	// pooled net flow only and never names a strategy.
	appEvents := []types.AppEvent{{
		EventSubType: subtypeToBytes32(subtypeBatchOrder),
		Data:         EncodeOrder(order),
	}}

	return finish(st, nil, appEvents, withdrawals, fuelBatch)
}

// handleDeanonymization produces the compliance report.
//
// This is a deliberate escape hatch, not a leak: Vela gates it on the
// AuthorityRegistry and encrypts the result to the requesting authority's key.
// Users are told it exists.
func handleDeanonymization(st *ApplicationInternalState) types.ProcessResult {
	type strategyReport struct {
		ID          string            `json:"id"`
		Manager     string            `json:"manager"`
		TotalShares string            `json:"totalShares"`
		Balances    map[string]string `json:"balances"`
		Halted      bool              `json:"halted"`
	}

	report := struct {
		AppID      uint64           `json:"appId"`
		QuoteToken string           `json:"quoteToken"`
		Strategies []strategyReport `json:"strategies"`
	}{
		AppID:      st.AppID,
		QuoteToken: st.QuoteToken.Hex(),
	}

	for _, id := range st.SortedStrategyIDs() {
		s := st.Strategies[id]
		balances := make(map[string]string, len(s.Balances))
		for _, key := range sortedBalanceKeys(s.Balances) {
			balances[key] = s.Balances[key].ToHex()
		}
		report.Strategies = append(report.Strategies, strategyReport{
			ID:          s.ID,
			Manager:     s.Manager.Hex(),
			TotalShares: s.TotalShares.ToHex(),
			Balances:    balances,
			Halted:      s.Halted,
		})
	}

	data, err := json.Marshal(report)
	if err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("deanonymization: %v", err)}
	}

	out, err := json.Marshal(st)
	if err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("deanonymization: %v", err)}
	}

	return types.ProcessResult{State: out, Report: data, Fuel: fuelReport}
}

// fillEvents tells each strategy's manager, privately, what their strategy got.
func fillEvents(st *ApplicationInternalState, s *Settlement) ([]types.PlainEvent, error) {
	type entry struct {
		Base  string `json:"base"`
		Quote string `json:"quote"`
		Side  string `json:"side"`
	}

	grouped := make(map[string][]entry)
	order := make([]string, 0)
	for _, f := range s.Fills {
		if _, seen := grouped[f.StrategyID]; !seen {
			order = append(order, f.StrategyID)
		}
		grouped[f.StrategyID] = append(grouped[f.StrategyID], entry{
			Base:  f.Base.ToHex(),
			Quote: f.Quote.ToHex(),
			Side:  f.Side.String(),
		})
	}

	events := make([]types.PlainEvent, 0, len(order))
	for _, id := range order {
		strat, err := st.Strategy(id)
		if err != nil {
			return nil, err
		}
		event, err := userEvent(strat.Manager, subtypeFills, map[string]interface{}{
			"type":          subtypeFills,
			"batchId":       s.BatchID,
			"clearingPrice": s.ClearingPrice.ToHex(),
			"fills":         grouped[id],
			"limitBreached": s.LimitBreached,
		})
		if err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, nil
}

func userEvent(to types.Address, subtype string, body map[string]interface{}) (types.PlainEvent, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return types.PlainEvent{}, fmt.Errorf("event: %v", err)
	}
	return types.PlainEvent{
		UserID:       to,
		EventSubType: subtypeToBytes32(subtype),
		Data:         data,
	}, nil
}

// finish serialises state into a ProcessResult.
func finish(
	st *ApplicationInternalState,
	events []types.PlainEvent,
	appEvents []types.AppEvent,
	withdrawals []types.Withdrawal,
	fuel *types.Uint256,
) types.ProcessResult {
	out, err := json.Marshal(st)
	if err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("serialise state: %v", err)}
	}
	return types.ProcessResult{
		State:       out,
		Events:      events,
		AppEvents:   appEvents,
		Withdrawals: withdrawals,
		Fuel:        fuel,
	}
}

func loadState(stateJSON string) (*ApplicationInternalState, error) {
	var st ApplicationInternalState
	if err := json.Unmarshal([]byte(stateJSON), &st); err != nil {
		return nil, fmt.Errorf("parse state: %v", err)
	}
	// Maps survive a round trip only if they were non-empty, so restore any
	// that came back nil before anything writes to them.
	if st.Strategies == nil {
		st.Strategies = make(map[string]*Strategy)
	}
	if st.Accounts == nil {
		st.Accounts = make(map[string]*Account)
	}
	if st.Open == nil {
		st.Open = make(map[string]*OpenBatch)
	}
	return &st, nil
}
