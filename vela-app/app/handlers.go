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

// Event subtypes. These become public indexed log topics, so they must not leak
// anything sensitive.
//
// Every user command answers with the same "receipt" subtype, whatever the
// command and whatever the outcome. Distinct subtypes per command would announce
// which command a wallet sent even though its payload is encrypted and padded,
// and distinct subtypes per outcome would announce every rejection.
const (
	subtypeDeposit    = "deposit"
	subtypeReceipt    = "receipt"
	subtypeBatchOrder = "batch_order"
	subtypeFills      = "fills"
)

// Receipt statuses.
const (
	statusAccepted = "accepted"
	statusRejected = "rejected"
)

// EventPadSize is the size every private event body is padded to, or a multiple
// of it for bodies that cannot fit.
//
// The recipient of a user event is not public, but its encrypted length is, and
// an accepted receipt and a rejected one say different things. Unpadded, their
// lengths would differ and a rejection would be visible after all.
const EventPadSize = 1024

// maxReasonLen caps a rejection reason so a receipt always fits one padded
// bucket. A reason long enough to spill into a second bucket would make that
// particular rejection larger than any acceptance.
const maxReasonLen = 256

// Receipt is the private answer to a user command.
type Receipt struct {
	Type    string            `json:"type"`
	Command string            `json:"command"`
	Status  string            `json:"status"`
	Reason  string            `json:"reason,omitempty"`
	Detail  map[string]string `json:"detail,omitempty"`
}

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
	ErrPayloadNotPadded = errors.New("payload must be padded to the fixed size")
	ErrPayloadTooLarge  = errors.New("payload does not fit the fixed size")
)

// PaddedPayloadSize is the exact plaintext length every PROCESS payload must
// have.
//
// Encryption hides what a payload says but not how long it is: AES-GCM output is
// the plaintext plus a fixed 28 bytes. Unpadded, the length alone told a chain
// observer which command was sent, whether an intent carried a limit price
// (which separates buys from unconditional sells), the length of the strategy
// ID, and the rough magnitude of hex-encoded amounts. Combined with the sender
// address every request exposes, that was enough to read a strategist's
// direction off the chain. The first live run on Vela showed it plainly: two
// buys and a sell encrypted to 214, 213 and 196 bytes.
//
// Every command is therefore padded to one size, so all requests look alike.
// The enclave enforces the size rather than merely tolerating padding: if it
// accepted short payloads, a single careless client would leak its own intents
// and shrink everyone else's crowd.
//
// Padding is trailing ASCII spaces, which JSON already permits after the value,
// so parsing needs no special handling. 1024 bytes comfortably fits the largest
// command, a strategy registration with its mandate.
const PaddedPayloadSize = 1024

// PadPayload pads a JSON command to PaddedPayloadSize with trailing spaces.
func PadPayload(payload []byte) ([]byte, error) {
	if len(payload) > PaddedPayloadSize {
		return nil, ErrPayloadTooLarge
	}
	out := make([]byte, PaddedPayloadSize)
	copy(out, payload)
	for i := len(payload); i < PaddedPayloadSize; i++ {
		out[i] = ' '
	}
	return out, nil
}

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
	Withdraw         *WithdrawCmd         `json:"withdraw,omitempty"`
}

// WithdrawCmd pays idle balance out to a wallet.
type WithdrawCmd struct {
	Token  string         `json:"token"`
	Amount *types.Uint256 `json:"amount"`

	// Destination defaults to the sender. Choosing another address does not
	// unlink the two: the Withdrawal event is published under this request's ID,
	// and the request's sender is public, so the chain shows who withdrew to
	// where. It is a convenience, not a privacy feature.
	Destination string `json:"destination,omitempty"`
}

// ErrBadDestination rejects withdrawal destinations that cannot receive funds
// sensibly.
var ErrBadDestination = errors.New("invalid withdrawal destination")

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

	// Checked before parsing, and the error deliberately omits the length it
	// saw: it is public, and there is no reason to restate it.
	if len(payloadJSON) != PaddedPayloadSize {
		return types.ProcessResult{Error: fmt.Sprintf("process: %v", ErrPayloadNotPadded)}
	}

	var instr PayloadInstructions
	if err := json.Unmarshal([]byte(payloadJSON), &instr); err != nil {
		return types.ProcessResult{Error: fmt.Sprintf("process: bad payload: %v", err)}
	}

	req := &commandRequest{st: st, sender: *sender, command: instr.Command, original: stateJSON}

	switch instr.Command {
	case "register_strategy":
		return handleRegisterStrategy(req, instr.RegisterStrategy)
	case "allocate":
		return handleAllocate(req, instr.Allocate)
	case "redeem":
		return handleRedeem(req, instr.Redeem)
	case "submit_intent":
		return handleSubmitIntent(req, instr.Intent)
	case "close_batch":
		return handleCloseBatch(req, instr.CloseBatch)
	case "withdraw":
		return handleWithdraw(req, instr.Withdraw)
	default:
		return malformed("process: %v: %q", ErrUnknownCommand, instr.Command)
	}
}

// commandRequest is one user command in flight, and the only way it may answer.
//
// There are two kinds of failure, and they are published differently.
//
// A malformed request — bad padding, unparseable JSON, a missing parameter —
// fails publicly, because the reason depends only on what the sender sent and
// says nothing about confidential state.
//
// A request that is well formed but refused by the rules — an unaffordable
// intent, a mandate breach, a batch the k-anonymity guard will not release — is
// rejected privately. Vela publishes an app's error string in the signed
// RequestCompleted event, and those reasons describe confidential state: a
// refusal for exceeding a position cap tells everyone the strategy is near it.
// So a rejection instead completes successfully, and the reason goes only to the
// sender, inside a receipt.
//
// For that to hide anything, a rejection must be indistinguishable from an
// acceptance in everything the chain records:
//
//   - status: both succeed;
//   - fee: both report the same fuel, which is fixed per command;
//   - events: both emit exactly one receipt, same subtype, same padded size;
//   - state root: Vela bumps a nonce inside the hashed app data on every
//     successful request, so the root moves even when Legate's state does not.
type commandRequest struct {
	st      *ApplicationInternalState
	sender  types.Address
	command string

	// original is the state exactly as it arrived. A rejection returns this,
	// never the handler's working copy: handlers may have mutated state before
	// the rule that refused them ran, and now that a rejection is a successful
	// request, anything it returned would be kept.
	original string
}

// fuel is fixed per command and independent of outcome. The fee it determines is
// published, so a rejection that cost less than an acceptance would announce
// itself.
func (r *commandRequest) fuel() *types.Uint256 {
	if r.command == "close_batch" {
		return fuelBatch
	}
	return fuelProcess
}

// accept commits the working state and answers with an accepted receipt,
// followed by any further events the command produced.
func (r *commandRequest) accept(
	detail map[string]string,
	extra []types.PlainEvent,
	appEvents []types.AppEvent,
	withdrawals []types.Withdrawal,
) types.ProcessResult {
	receipt, err := receiptEvent(r.sender, Receipt{
		Type:    subtypeReceipt,
		Command: r.command,
		Status:  statusAccepted,
		Detail:  detail,
	})
	if err != nil {
		return malformed("%s: %v", r.command, err)
	}
	events := append([]types.PlainEvent{receipt}, extra...)
	return finish(r.st, events, appEvents, withdrawals, r.fuel())
}

// reject discards every change and answers privately with the reason.
func (r *commandRequest) reject(cause error) types.ProcessResult {
	reason := fmt.Sprintf("%s: %v", r.command, cause)
	if len(reason) > maxReasonLen {
		reason = reason[:maxReasonLen]
	}

	receipt, err := receiptEvent(r.sender, Receipt{
		Type:    subtypeReceipt,
		Command: r.command,
		Status:  statusRejected,
		Reason:  reason,
	})
	if err != nil {
		return malformed("%s: %v", r.command, err)
	}

	return types.ProcessResult{
		State:  []byte(r.original),
		Events: []types.PlainEvent{receipt},
		Fuel:   r.fuel(),
	}
}

// malformed fails a request publicly. Reserve it for reasons that reveal nothing
// about confidential state.
func malformed(format string, args ...interface{}) types.ProcessResult {
	return types.ProcessResult{Error: fmt.Sprintf(format, args...)}
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
	if err := st.CreditSweep(&open.Plan, open.QuoteLimit, settlement); err != nil {
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

// Receipts deliberately never echo sender-chosen strings such as a strategy ID.
// Those are unbounded, and echoing one could push a receipt past a padding
// bucket. The sender already knows what they sent, and can match a receipt to
// its request by the request ID the event is published under.

func handleRegisterStrategy(r *commandRequest, cmd *RegisterStrategyCmd) types.ProcessResult {
	if cmd == nil {
		return malformed("register_strategy: missing parameters")
	}
	if _, err := r.st.RegisterStrategy(cmd.ID, r.sender, cmd.Mandate); err != nil {
		return r.reject(err)
	}
	return r.accept(nil, nil, nil, nil)
}

func handleAllocate(r *commandRequest, cmd *AllocateCmd) types.ProcessResult {
	if cmd == nil || cmd.Amount == nil {
		return malformed("allocate: missing parameters")
	}

	issued, err := r.st.Allocate(r.sender, cmd.StrategyID, *cmd.Amount, cmd.Prices)
	if err != nil {
		// A deposit made with this request stays credited as idle balance: the
		// deposit export already ran, and refunding it on chain would announce the
		// rejection as plainly as an error would.
		return r.reject(err)
	}
	return r.accept(map[string]string{"shares": issued.ToHex()}, nil, nil, nil)
}

func handleRedeem(r *commandRequest, cmd *RedeemCmd) types.ProcessResult {
	if cmd == nil || cmd.Shares == nil {
		return malformed("redeem: missing parameters")
	}

	value, err := r.st.Redeem(r.sender, cmd.StrategyID, *cmd.Shares, cmd.Prices)
	if err != nil {
		return r.reject(err)
	}
	return r.accept(map[string]string{"value": value.ToHex()}, nil, nil, nil)
}

// handleWithdraw pays idle balance out through a Vela withdrawal, which the
// endpoint credits to the destination as a claim.
//
// Unlike other commands, a withdrawal's outcome cannot be fully hidden: an
// accepted one moves funds, and funds moving on chain are public. What private
// rejection still protects is the reason — whether the sender lacked the balance,
// or something else stopped it.
func handleWithdraw(r *commandRequest, cmd *WithdrawCmd) types.ProcessResult {
	if cmd == nil || cmd.Amount == nil {
		return malformed("withdraw: missing parameters")
	}

	token, err := types.HexToAddress(cmd.Token)
	if err != nil {
		return malformed("withdraw: bad token: %v", err)
	}

	destination := r.sender
	if cmd.Destination != "" {
		if destination, err = types.HexToAddress(cmd.Destination); err != nil {
			return malformed("withdraw: bad destination: %v", err)
		}
	}

	// These say nothing about confidential state, so they fail in public.
	//
	// The endpoint would accept a withdrawal to the zero address and lose it. And
	// it treats a withdrawal to the trigger as funding for a trade, claiming it
	// into the trigger before executing, which would feed a user's money into the
	// next batch's sweep.
	if destination == (types.Address{}) {
		return malformed("withdraw: %v: zero address", ErrBadDestination)
	}
	if r.st.TriggerAddress != "" && destination.Hex() == r.st.TriggerAddress {
		return malformed("withdraw: %v: the trigger contract", ErrBadDestination)
	}

	if err := r.st.Withdraw(r.sender, token, *cmd.Amount); err != nil {
		return r.reject(err)
	}

	amount := *cmd.Amount
	return r.accept(nil, nil, nil, []types.Withdrawal{{
		TokenAddress:       token,
		DestinationAddress: destination,
		Amount:             &amount,
	}})
}

func handleSubmitIntent(r *commandRequest, cmd *IntentCmd) types.ProcessResult {
	if cmd == nil || cmd.Amount == nil {
		return malformed("submit_intent: missing parameters")
	}

	base, err := types.HexToAddress(cmd.Base)
	if err != nil {
		return malformed("submit_intent: bad base: %v", err)
	}

	limit := types.Uint256{}
	if cmd.LimitPrice != nil {
		limit = *cmd.LimitPrice
	}

	accepted, err := r.st.SubmitIntent(r.sender, Intent{
		StrategyID: cmd.StrategyID,
		Base:       base,
		Quote:      r.st.QuoteToken,
		Side:       cmd.Side,
		Amount:     cmd.Amount,
		LimitPrice: &limit,
	})
	if err != nil {
		return r.reject(err)
	}
	return r.accept(map[string]string{"intentId": accepted.ID}, nil, nil, nil)
}

// handleCloseBatch nets the pending intents and, if anything is left over,
// sends exactly one order to market.
//
// Every refusal here is private. That includes the k-anonymity guard declining to
// release a batch: publishing that reason would tell everyone fewer than k
// strategies were active. From outside, a refused close is a successful request
// that published no order — though, unlike a batch that fully internalised, it
// carries no fill events, so the fact that nothing settled remains visible.
func handleCloseBatch(r *commandRequest, cmd *CloseBatchCmd) types.ProcessResult {
	st := r.st

	if cmd == nil || cmd.RefPrice == nil {
		return malformed("close_batch: missing parameters")
	}
	if st.Operator != "" && st.Operator != r.sender.Hex() {
		return r.reject(ErrNotOperator)
	}
	if len(st.Pending) == 0 {
		return r.reject(ErrNoPendingIntents)
	}

	plan, err := NetBatch(st.Pending, *cmd.RefPrice, st.Config)
	if err != nil {
		return r.reject(err)
	}

	st.BatchNonce++
	batchID := batchIDFromNonce(st.BatchNonce)
	key := hex.EncodeToString(batchID[:])

	// Intents that made it into the batch are consumed; anything excluded is
	// dropped rather than silently carried forward into a later batch at a
	// price its author never agreed to.
	st.Pending = nil

	// A fully internalised batch never reaches the market, so it settles
	// immediately and no order is published.
	if plan.FullyInternalised {
		settlement, err := SettleBatch(plan, key, MarketFill{Success: true})
		if err != nil {
			return r.reject(err)
		}
		if err := st.ApplySettlement(plan, settlement); err != nil {
			return r.reject(err)
		}
		events, err := fillEvents(st, settlement)
		if err != nil {
			return r.reject(err)
		}
		return r.accept(map[string]string{"outcome": "internalised"}, events, nil, nil)
	}

	// Deployment misconfiguration, not confidential state, so it fails publicly.
	if st.TriggerAddress == "" {
		return malformed("close_batch: no trigger contract configured")
	}
	triggerAddr, err := types.HexToAddress(st.TriggerAddress)
	if err != nil {
		return malformed("close_batch: bad trigger address: %v", err)
	}

	// This check runs after the nonce was bumped and the pending queue cleared.
	// Rejecting returns the state as it arrived, so those intents are not lost.
	quoteLimit, err := QuoteLimitFor(plan, cmd.SlippageBps)
	if err != nil {
		return r.reject(err)
	}

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

	// Funding the trigger is a withdrawal like any other, and would freeze the app
	// just the same if custody could not cover it.
	if err := st.takeCustody(withdrawToken, withdrawAmount); err != nil {
		return r.reject(err)
	}

	st.Open[key] = &OpenBatch{ID: key, Plan: *plan, QuoteLimit: quoteLimit}

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

	return r.accept(map[string]string{"outcome": "sent_to_market"}, nil, appEvents, withdrawals)
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

// userEvent builds a private event, padded so its encrypted length reveals
// nothing about its contents.
func userEvent(to types.Address, subtype string, body interface{}) (types.PlainEvent, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return types.PlainEvent{}, fmt.Errorf("event: %v", err)
	}
	return types.PlainEvent{
		UserID:       to,
		EventSubType: subtypeToBytes32(subtype),
		Data:         padToBucket(data),
	}, nil
}

func receiptEvent(to types.Address, r Receipt) (types.PlainEvent, error) {
	return userEvent(to, subtypeReceipt, r)
}

// padToBucket pads JSON with trailing spaces to the next multiple of
// EventPadSize. JSON permits trailing whitespace, so readers parse it unchanged.
//
// Receipts are sized to always fit a single bucket. Fill events can outgrow one
// when a strategy has many fills in a batch, and are allowed to take more buckets
// rather than fail: refusing would strand a settled batch. That reveals only a
// coarse fill count, and only to someone who already knows whose event it is.
func padToBucket(body []byte) []byte {
	size := EventPadSize
	for size < len(body) {
		size += EventPadSize
	}
	out := make([]byte, size)
	copy(out, body)
	for i := len(body); i < size; i++ {
		out[i] = ' '
	}
	return out
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
	if st.Custody == nil {
		st.Custody = make(map[string]*types.Uint256)
	}
	return &st, nil
}
