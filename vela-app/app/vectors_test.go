package app

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

// vectorsPath is the fixture shared with the Solidity test suite.
const vectorsPath = "../../contracts/test/fixtures/abi-vectors.json"

type abiVectors struct {
	Order struct {
		BatchID    string `json:"batchId"`
		Side       uint8  `json:"side"`
		Base       string `json:"base"`
		Quote      string `json:"quote"`
		BaseAmount string `json:"baseAmount"`
		QuoteLimit string `json:"quoteLimit"`
		Encoded    string `json:"encoded"`
	} `json:"order"`
	FillSuccess struct {
		BaseFilled string `json:"baseFilled"`
		QuoteMoved string `json:"quoteMoved"`
		Outcome    uint8  `json:"outcome"`
		Encoded    string `json:"encoded"`
	} `json:"fillSuccess"`
	FillFailure struct {
		Encoded string `json:"encoded"`
	} `json:"fillFailure"`
	BatchOrderSubtype string `json:"batchOrderSubtype"`
}

// TestGoMatchesCommittedABIVectors is one half of a cross-language contract; the
// Hardhat suite is the other. Go and Solidity each implement the wire format
// independently, so nothing but a shared fixture stops them drifting apart. A
// mismatch would not fail either side's own tests — it would surface on chain,
// as an order decoded into the wrong numbers after funds had already moved.
func TestGoMatchesCommittedABIVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.FromSlash(vectorsPath))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}

	var v abiVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}

	base, err := types.HexToAddress(v.Order.Base)
	if err != nil {
		t.Fatalf("base address: %v", err)
	}
	quote, err := types.HexToAddress(v.Order.Quote)
	if err != nil {
		t.Fatalf("quote address: %v", err)
	}

	order := Order{
		BatchID:    batchIDFromNonce(7),
		Side:       Side(v.Order.Side),
		Base:       base,
		Quote:      quote,
		BaseAmount: mustDecimal(t, v.Order.BaseAmount),
		QuoteLimit: mustDecimal(t, v.Order.QuoteLimit),
	}

	if got := hexOf(EncodeOrder(order)); got != strings.ToLower(v.Order.Encoded) {
		t.Fatalf("order encoding drifted from the committed vector:\n got  %s\n want %s", got, v.Order.Encoded)
	}
	if got := "0x" + hex.EncodeToString(order.BatchID[:]); got != v.Order.BatchID {
		t.Fatalf("batch id = %s, want %s", got, v.Order.BatchID)
	}

	success := MarketFill{
		Base:    mustDecimal(t, v.FillSuccess.BaseFilled),
		Quote:   mustDecimal(t, v.FillSuccess.QuoteMoved),
		Success: true,
	}
	if got := hexOf(EncodeFill(order.BatchID, success)); got != strings.ToLower(v.FillSuccess.Encoded) {
		t.Fatalf("success fill encoding drifted:\n got  %s\n want %s", got, v.FillSuccess.Encoded)
	}

	failure := MarketFill{Success: false}
	if got := hexOf(EncodeFill(order.BatchID, failure)); got != strings.ToLower(v.FillFailure.Encoded) {
		t.Fatalf("failure fill encoding drifted:\n got  %s\n want %s", got, v.FillFailure.Encoded)
	}

	subtype := subtypeToBytes32(subtypeBatchOrder)
	if got := "0x" + hex.EncodeToString(subtype[:]); got != v.BatchOrderSubtype {
		t.Fatalf("batch order subtype = %s, want %s", got, v.BatchOrderSubtype)
	}
}

// The committed vectors must also survive a decode, so the fixture is proven to
// round-trip rather than merely to match byte-for-byte.
func TestCommittedVectorsDecode(t *testing.T) {
	raw, err := os.ReadFile(filepath.FromSlash(vectorsPath))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v abiVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}

	orderBytes, err := hex.DecodeString(strings.TrimPrefix(v.Order.Encoded, "0x"))
	if err != nil {
		t.Fatalf("decode order hex: %v", err)
	}
	order, err := DecodeOrder(orderBytes)
	if err != nil {
		t.Fatalf("DecodeOrder: %v", err)
	}
	if !order.BaseAmount.Eq(mustDecimal(t, v.Order.BaseAmount)) {
		t.Fatalf("base amount = %s, want %s", order.BaseAmount.String(), v.Order.BaseAmount)
	}
	if !order.QuoteLimit.Eq(mustDecimal(t, v.Order.QuoteLimit)) {
		t.Fatalf("quote limit = %s, want %s", order.QuoteLimit.String(), v.Order.QuoteLimit)
	}

	fillBytes, err := hex.DecodeString(strings.TrimPrefix(v.FillSuccess.Encoded, "0x"))
	if err != nil {
		t.Fatalf("decode fill hex: %v", err)
	}
	_, fill, err := DecodeFill(fillBytes)
	if err != nil {
		t.Fatalf("DecodeFill: %v", err)
	}
	if !fill.Success {
		t.Fatal("outcome 0 must decode as success")
	}
	if !fill.Base.Eq(mustDecimal(t, v.FillSuccess.BaseFilled)) {
		t.Fatalf("base filled = %s, want %s", fill.Base.String(), v.FillSuccess.BaseFilled)
	}

	failBytes, err := hex.DecodeString(strings.TrimPrefix(v.FillFailure.Encoded, "0x"))
	if err != nil {
		t.Fatalf("decode failure hex: %v", err)
	}
	if _, failFill, err := DecodeFill(failBytes); err != nil || failFill.Success {
		t.Fatalf("outcome 1 must decode as failure (err=%v)", err)
	}
}

func hexOf(b []byte) string { return "0x" + hex.EncodeToString(b) }

// mustDecimal parses a base-10 string into a Uint256 by repeated multiply-add,
// since Uint256 parses hex but not decimal.
func mustDecimal(t *testing.T, s string) types.Uint256 {
	t.Helper()
	v := types.NewUint256(0)
	for _, r := range s {
		if r < '0' || r > '9' {
			t.Fatalf("not a decimal string: %q", s)
		}
		v.Mul64(10)
		v.Add64(uint64(r - '0'))
	}
	return *v
}
