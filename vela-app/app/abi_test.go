package app

import (
	"bytes"
	"testing"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

func TestEncodeOrderRoundTrip(t *testing.T) {
	want := Order{
		BatchID:    batchIDFromNonce(7),
		Side:       SideSell,
		Base:       tokenWETH,
		Quote:      tokenUSDC,
		BaseAmount: u64(1_234),
		QuoteLimit: u64(5_678_900),
	}

	encoded := EncodeOrder(want)
	if len(encoded) != orderEncodedLen {
		t.Fatalf("encoded length = %d, want %d", len(encoded), orderEncodedLen)
	}

	got, err := DecodeOrder(encoded)
	if err != nil {
		t.Fatalf("DecodeOrder: %v", err)
	}
	if got.BatchID != want.BatchID {
		t.Fatalf("batch id = %x, want %x", got.BatchID, want.BatchID)
	}
	if got.Side != want.Side {
		t.Fatalf("side = %s, want %s", got.Side, want.Side)
	}
	if got.Base != want.Base || got.Quote != want.Quote {
		t.Fatalf("tokens = %s/%s, want %s/%s", got.Base.Hex(), got.Quote.Hex(), want.Base.Hex(), want.Quote.Hex())
	}
	if !got.BaseAmount.Eq(want.BaseAmount) || !got.QuoteLimit.Eq(want.QuoteLimit) {
		t.Fatalf("amounts = %s/%s, want %s/%s",
			got.BaseAmount.String(), got.QuoteLimit.String(),
			want.BaseAmount.String(), want.QuoteLimit.String())
	}
}

// Solidity's abi.decode expects a very specific byte layout. Getting alignment
// wrong produces values that are silently garbage rather than an error, so the
// layout is asserted directly.
func TestEncodeOrderByteLayout(t *testing.T) {
	o := Order{
		BatchID:    batchIDFromNonce(1),
		Side:       SideBuy,
		Base:       tokenWETH,
		Quote:      tokenUSDC,
		BaseAmount: u64(1),
		QuoteLimit: u64(2),
	}
	e := EncodeOrder(o)

	// Word 0: bytes16 is left-aligned, so the trailing 16 bytes are zero.
	if !bytes.Equal(e[16:32], make([]byte, 16)) {
		t.Fatalf("bytes16 should be left-aligned, got %x", e[0:32])
	}
	// Word 1: uint8 right-aligned.
	if !bytes.Equal(e[32:63], make([]byte, 31)) || e[63] != byte(SideBuy) {
		t.Fatalf("uint8 should be right-aligned, got %x", e[32:64])
	}
	// Word 2: address right-aligned, first 12 bytes zero.
	if !bytes.Equal(e[64:76], make([]byte, 12)) {
		t.Fatalf("address should be right-aligned, got %x", e[64:96])
	}
	if !bytes.Equal(e[76:96], tokenWETH[:]) {
		t.Fatalf("address bytes wrong: %x", e[76:96])
	}
	// Word 4: uint256 occupies the whole word, big-endian.
	if e[159] != 1 {
		t.Fatalf("baseAmount should be big-endian in its word, got %x", e[128:160])
	}
}

func TestDecodeOrderRejectsMalformed(t *testing.T) {
	t.Run("wrong length", func(t *testing.T) {
		if _, err := DecodeOrder(make([]byte, 100)); err != ErrBadOrder {
			t.Fatalf("expected ErrBadOrder, got %v", err)
		}
	})

	// A non-zero high byte in an address word means the encoding is not what we
	// think it is; accepting it would silently truncate to a different address.
	t.Run("dirty address word", func(t *testing.T) {
		e := EncodeOrder(Order{BatchID: batchIDFromNonce(1), Base: tokenWETH, Quote: tokenUSDC})
		e[64] = 0xFF
		if _, err := DecodeOrder(e); err != ErrBadOrder {
			t.Fatalf("expected ErrBadOrder, got %v", err)
		}
	})
}

func TestFillRoundTrip(t *testing.T) {
	id := batchIDFromNonce(42)

	for _, success := range []bool{true, false} {
		want := MarketFill{Base: u64(500), Quote: u64(1_500_000), Success: success}

		encoded := EncodeFill(id, want)
		if len(encoded) != fillEncodedLen {
			t.Fatalf("encoded length = %d, want %d", len(encoded), fillEncodedLen)
		}

		gotID, got, err := DecodeFill(encoded)
		if err != nil {
			t.Fatalf("DecodeFill: %v", err)
		}
		if gotID != id {
			t.Fatalf("batch id = %x, want %x", gotID, id)
		}
		if !got.Base.Eq(want.Base) || !got.Quote.Eq(want.Quote) || got.Success != want.Success {
			t.Fatalf("fill = %+v, want %+v", got, want)
		}
	}
}

func TestDecodeFillRejectsWrongLength(t *testing.T) {
	if _, _, err := DecodeFill(make([]byte, 96)); err != ErrBadFillPayload {
		t.Fatalf("expected ErrBadFillPayload, got %v", err)
	}
}

func TestBatchIDsAreDeterministicAndDistinct(t *testing.T) {
	a := batchIDFromNonce(1)
	b := batchIDFromNonce(2)

	if a == b {
		t.Fatal("different nonces must give different batch ids")
	}
	if a != batchIDFromNonce(1) {
		t.Fatal("the same nonce must always give the same batch id")
	}
}

func TestQuoteLimitUsesTheTightestParticipantLimit(t *testing.T) {
	refPrice := price(t, 3_000)

	// Two buyers with different ceilings; the lower one binds, because the
	// clearing price applies to everyone.
	generous := intent("i1", "alpha", SideBuy, 100)
	generous.LimitPrice = ptr(price(t, 3_500))
	strict := intent("i2", "beta", SideBuy, 100)
	strict.LimitPrice = ptr(price(t, 3_100))
	seller := intent("i3", "gamma", SideSell, 150)

	plan := planFrom(t, []Intent{generous, strict, seller}, refPrice)

	limit, err := QuoteLimitFor(plan, 0)
	if err != nil {
		t.Fatalf("QuoteLimitFor: %v", err)
	}

	// residual 50 at the tightest ceiling of 3100.
	want, err := ApplyPrice(u64(50), price(t, 3_100))
	if err != nil {
		t.Fatalf("ApplyPrice: %v", err)
	}
	if !limit.Eq(want) {
		t.Fatalf("quote limit = %s, want %s", limit.String(), want.String())
	}
}

func TestQuoteLimitFallsBackToSlippageTolerance(t *testing.T) {
	refPrice := price(t, 3_000)
	plan := planFrom(t, []Intent{
		intent("i1", "alpha", SideBuy, 100),
		intent("i2", "beta", SideSell, 60),
	}, refPrice)

	// No participant limits, so a 1% tolerance bounds it: 40 * 3030.
	limit, err := QuoteLimitFor(plan, 100)
	if err != nil {
		t.Fatalf("QuoteLimitFor: %v", err)
	}
	want, err := ApplyPrice(u64(40), price(t, 3_030))
	if err != nil {
		t.Fatalf("ApplyPrice: %v", err)
	}
	if !limit.Eq(want) {
		t.Fatalf("quote limit = %s, want %s", limit.String(), want.String())
	}
}

// Going to market with nothing bounding the price would let a bad reference
// price drain the batch.
func TestQuoteLimitRefusesWhenNothingBoundsThePrice(t *testing.T) {
	plan := planFrom(t, []Intent{
		intent("i1", "alpha", SideBuy, 100),
		intent("i2", "beta", SideSell, 60),
	}, price(t, 3_000))

	if _, err := QuoteLimitFor(plan, 0); err != ErrNoPriceBound {
		t.Fatalf("expected ErrNoPriceBound, got %v", err)
	}
}

func TestQuoteLimitForSellResidualUsesAFloor(t *testing.T) {
	refPrice := price(t, 3_000)

	seller := intent("i1", "alpha", SideSell, 200)
	seller.LimitPrice = ptr(price(t, 2_900)) // will not sell below 2900
	buyer := intent("i2", "beta", SideBuy, 50)

	plan := planFrom(t, []Intent{seller, buyer}, refPrice)
	if plan.ResidualSide != SideSell {
		t.Fatalf("expected a sell residual, got %s", plan.ResidualSide)
	}

	limit, err := QuoteLimitFor(plan, 0)
	if err != nil {
		t.Fatalf("QuoteLimitFor: %v", err)
	}

	// residual 150 at the floor of 2900: the minimum acceptable proceeds.
	want, err := ApplyPrice(u64(150), price(t, 2_900))
	if err != nil {
		t.Fatalf("ApplyPrice: %v", err)
	}
	if !limit.Eq(want) {
		t.Fatalf("quote limit = %s, want %s", limit.String(), want.String())
	}
}

func TestAddressWordRejectsOversizedInput(t *testing.T) {
	if _, err := addressFromWord(make([]byte, 8)); err != ErrBadOrder {
		t.Fatalf("expected ErrBadOrder, got %v", err)
	}
}

var _ = types.Address{}
