package app

import (
	"encoding/binary"
	"errors"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

// The guest cannot import go-ethereum, so the small amount of ABI encoding
// needed to talk to the trigger contract is hand-rolled here.
//
// Both wire formats are deliberately made of fixed-size types only. A static
// layout is a flat run of 32-byte words with no offsets or length prefixes,
// which removes an entire class of encoding bug and keeps the codec short
// enough to audit by eye.

const abiWord = 32

// Order layout: 6 static words.
//
//	(bytes16 batchId, uint8 side, address base, address quote,
//	 uint256 baseAmount, uint256 quoteLimit)
const orderEncodedLen = 6 * abiWord

// Fill layout: 4 static words.
//
//	(bytes16 batchId, uint256 baseFilled, uint256 quoteMoved, uint8 outcome)
const fillEncodedLen = 4 * abiWord

var (
	ErrBadFillPayload = errors.New("malformed fill payload from the trigger contract")
	ErrBadOrder       = errors.New("malformed order")
)

// Order is the instruction handed to the trigger contract to execute against a
// venue. It is carried in a plaintext AppEvent, so everything in it is public by
// construction — which is exactly why it describes pooled net flow and never
// mentions a strategy.
type Order struct {
	BatchID [16]byte
	Side    Side

	Base  types.Address
	Quote types.Address

	// BaseAmount is the exact quantity of base to trade.
	BaseAmount types.Uint256

	// QuoteLimit bounds the other leg: for a buy it is the most quote the
	// trigger may spend, for a sell the least it must receive.
	//
	// This is the on-chain slippage guard. The enclave checks limit prices
	// against the reference price before execution, but the realised price is
	// only known afterwards, so this bound is what actually protects the batch.
	QuoteLimit types.Uint256
}

// EncodeOrder lays an order out as ABI-encoded static words for the trigger to
// abi.decode on chain.
func EncodeOrder(o Order) []byte {
	out := make([]byte, 0, orderEncodedLen)

	// bytes16 is left-aligned within its word; everything else right-aligned.
	var w [abiWord]byte
	copy(w[:16], o.BatchID[:])
	out = append(out, w[:]...)

	out = append(out, uint8Word(uint8(o.Side))...)
	out = append(out, addressWord(o.Base)...)
	out = append(out, addressWord(o.Quote)...)
	out = append(out, o.BaseAmount.Bytes()...)
	out = append(out, o.QuoteLimit.Bytes()...)

	return out
}

// DecodeOrder is the inverse of EncodeOrder. The guest never needs it in
// production — the trigger decodes orders, not the enclave — but round-tripping
// is how the encoder is tested.
func DecodeOrder(payload []byte) (Order, error) {
	if len(payload) != orderEncodedLen {
		return Order{}, ErrBadOrder
	}

	var o Order
	copy(o.BatchID[:], payload[0:16])
	o.Side = Side(payload[63]) // uint8 sits in the last byte of word 1

	var err error
	if o.Base, err = addressFromWord(payload[64:96]); err != nil {
		return Order{}, err
	}
	if o.Quote, err = addressFromWord(payload[96:128]); err != nil {
		return Order{}, err
	}

	o.BaseAmount.SetBytes(payload[128:160])
	o.QuoteLimit.SetBytes(payload[160:192])

	return o, nil
}

// DecodeFill reads the result the trigger reports after executing an order.
//
// This payload arrives through trusted_request as clear text: it was produced
// on chain by the trigger, not by a user, so the Executor does not decrypt it.
// It is trusted only because the platform guarantees its origin — its contents
// are still validated before use.
func DecodeFill(payload []byte) (batchID [16]byte, fill MarketFill, err error) {
	if len(payload) != fillEncodedLen {
		return batchID, MarketFill{}, ErrBadFillPayload
	}

	copy(batchID[:], payload[0:16])

	fill.Base.SetBytes(payload[32:64])
	fill.Quote.SetBytes(payload[64:96])
	fill.Success = payload[127] == 0 // uint8 outcome: 0 means success

	return batchID, fill, nil
}

// EncodeFill builds a fill payload. Only used by tests and by a mock trigger;
// on chain the real trigger contract produces this.
func EncodeFill(batchID [16]byte, fill MarketFill) []byte {
	out := make([]byte, 0, fillEncodedLen)

	var w [abiWord]byte
	copy(w[:16], batchID[:])
	out = append(out, w[:]...)

	out = append(out, fill.Base.Bytes()...)
	out = append(out, fill.Quote.Bytes()...)

	outcome := uint8(0)
	if !fill.Success {
		outcome = 1
	}
	out = append(out, uint8Word(outcome)...)

	return out
}

func uint8Word(v uint8) []byte {
	var w [abiWord]byte
	w[abiWord-1] = v
	return w[:]
}

func addressWord(a types.Address) []byte {
	var w [abiWord]byte
	copy(w[12:], a[:]) // right-aligned: last 20 bytes of the word
	return w[:]
}

func addressFromWord(word []byte) (types.Address, error) {
	if len(word) != abiWord {
		return types.Address{}, ErrBadOrder
	}
	// The first 12 bytes of an address word must be zero.
	for _, b := range word[:12] {
		if b != 0 {
			return types.Address{}, ErrBadOrder
		}
	}
	var a types.Address
	copy(a[:], word[12:])
	return a, nil
}

// batchIDFromNonce derives a batch identifier from the monotonic batch counter.
//
// Deterministic by necessity: the enclave has no clock and no randomness, so
// every identifier must come from state. bytes16 matches what the trigger
// contract expects.
func batchIDFromNonce(n uint64) [16]byte {
	var id [16]byte
	binary.BigEndian.PutUint64(id[8:], n)
	return id
}

// subtypeToBytes32 packs a short ASCII label into an indexed event topic.
func subtypeToBytes32(s string) [32]byte {
	var b [32]byte
	copy(b[:], s)
	return b
}
