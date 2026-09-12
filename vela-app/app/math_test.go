package app

import (
	"math/big"
	"math/rand"
	"testing"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

// toBig converts a Uint256 to a big.Int via its canonical 32-byte big-endian form.
func toBig(x types.Uint256) *big.Int {
	return new(big.Int).SetBytes(x.Bytes())
}

// fromBig converts a big.Int (which must fit in 256 bits) to a Uint256.
func fromBig(t *testing.T, x *big.Int) types.Uint256 {
	t.Helper()
	if x.BitLen() > 256 {
		t.Fatalf("value does not fit in 256 bits: %s", x.String())
	}
	b := x.Bytes()
	padded := make([]byte, 32)
	copy(padded[32-len(b):], b)
	var z types.Uint256
	z.SetBytes(padded)
	return z
}

func u64(v uint64) types.Uint256 { return *types.NewUint256(v) }

func TestMulDivSimple(t *testing.T) {
	cases := []struct {
		name          string
		a, b, d, want uint64
	}{
		{"six over two", 6, 7, 2, 21},
		{"exact", 100, 3, 10, 30},
		{"floor rounds down", 10, 1, 3, 3},
		{"zero numerator", 0, 12345, 7, 0},
		{"identity", 1, 1, 1, 1},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := MulDiv(u64(tc.a), u64(tc.b), u64(tc.d))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !got.Eq(u64(tc.want)) {
				t.Fatalf("MulDiv(%d,%d,%d) = %s, want %d", tc.a, tc.b, tc.d, got.String(), tc.want)
			}
		})
	}
}

// TestMulDivExceeds256 is the case that motivates the 512-bit intermediate: the
// product a*b overflows 256 bits, but the final quotient fits comfortably.
// A naive implementation that multiplied in 256 bits would wrap and return a
// wrong answer here.
func TestMulDivExceeds256(t *testing.T) {
	// a = b = 2^200. a*b = 2^400, well beyond 256 bits.
	a := new(big.Int).Lsh(big.NewInt(1), 200)
	d := new(big.Int).Lsh(big.NewInt(1), 200)

	got, err := MulDiv(fromBig(t, a), fromBig(t, a), fromBig(t, d))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := new(big.Int).Div(new(big.Int).Mul(a, a), d) // == 2^200
	if toBig(got).Cmp(want) != 0 {
		t.Fatalf("got %s, want %s", toBig(got).String(), want.String())
	}
}

func TestMulDivMaxValues(t *testing.T) {
	maxU256 := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	max := fromBig(t, maxU256)

	// max * max / max == max, the tightest case that must still fit.
	got, err := MulDiv(max, max, max)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if toBig(got).Cmp(maxU256) != 0 {
		t.Fatalf("got %s, want %s", toBig(got).String(), maxU256.String())
	}
}

func TestMulDivOverflowDetected(t *testing.T) {
	maxU256 := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	max := fromBig(t, maxU256)

	// max * max / 1 cannot be represented in 256 bits.
	if _, err := MulDiv(max, max, u64(1)); err != ErrOverflow {
		t.Fatalf("expected ErrOverflow, got %v", err)
	}
}

func TestMulDivByZero(t *testing.T) {
	if _, err := MulDiv(u64(1), u64(1), types.Uint256{}); err != ErrDivByZero {
		t.Fatalf("expected ErrDivByZero, got %v", err)
	}
}

// TestMulDivAgainstBigInt cross-checks the implementation against math/big over
// a wide spread of magnitudes. math/big is unavailable under TinyGo inside the
// enclave, which is why mulDiv exists, but it is the ideal test oracle here.
func TestMulDivAgainstBigInt(t *testing.T) {
	rng := rand.New(rand.NewSource(1)) // fixed seed: reproducible failures

	randBits := func(n int) *big.Int {
		if n == 0 {
			return big.NewInt(0)
		}
		v := new(big.Int).Rand(rng, new(big.Int).Lsh(big.NewInt(1), uint(n)))
		return v
	}

	bitSizes := []int{1, 8, 32, 64, 65, 100, 128, 200, 255, 256}

	for _, abits := range bitSizes {
		for _, dbits := range bitSizes {
			for i := 0; i < 20; i++ {
				a := randBits(abits)
				b := randBits(abits)
				d := randBits(dbits)
				if d.Sign() == 0 {
					d = big.NewInt(1)
				}

				want := new(big.Int).Div(new(big.Int).Mul(a, b), d)

				got, err := MulDiv(fromBig(t, a), fromBig(t, b), fromBig(t, d))
				if want.BitLen() > 256 {
					if err != ErrOverflow {
						t.Fatalf("a=%s b=%s d=%s: expected ErrOverflow, got %v", a, b, d, err)
					}
					continue
				}
				if err != nil {
					t.Fatalf("a=%s b=%s d=%s: unexpected error %v", a, b, d, err)
				}
				if toBig(got).Cmp(want) != 0 {
					t.Fatalf("a=%s b=%s d=%s: got %s want %s", a, b, d, toBig(got).String(), want.String())
				}
			}
		}
	}
}

func TestOneIsTenToThe18(t *testing.T) {
	want, _ := new(big.Int).SetString("1000000000000000000", 10)
	if toBig(One()).Cmp(want) != 0 {
		t.Fatalf("One() = %s, want %s", toBig(One()).String(), want.String())
	}
}

func TestApplyPriceRoundTrip(t *testing.T) {
	// 2.5 in fixed point.
	price, err := MulDiv(One(), u64(25), u64(10))
	if err != nil {
		t.Fatalf("building price: %v", err)
	}

	amount := u64(1_000_000)

	out, err := ApplyPrice(amount, price)
	if err != nil {
		t.Fatalf("ApplyPrice: %v", err)
	}
	if !out.Eq(u64(2_500_000)) {
		t.Fatalf("ApplyPrice = %s, want 2500000", out.String())
	}

	back, err := UnapplyPrice(out, price)
	if err != nil {
		t.Fatalf("UnapplyPrice: %v", err)
	}
	if !back.Eq(amount) {
		t.Fatalf("round trip = %s, want %s", back.String(), amount.String())
	}
}

func TestUnapplyPriceZeroPrice(t *testing.T) {
	if _, err := UnapplyPrice(u64(1), types.Uint256{}); err != ErrDivByZero {
		t.Fatalf("expected ErrDivByZero, got %v", err)
	}
}

func TestAddSubGuards(t *testing.T) {
	maxU256 := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	max := fromBig(t, maxU256)

	if _, err := Add(max, u64(1)); err != ErrOverflow {
		t.Fatalf("expected overflow on Add, got %v", err)
	}
	if _, err := Sub(u64(1), u64(2)); err != ErrOverflow {
		t.Fatalf("expected underflow on Sub, got %v", err)
	}

	sum, err := Add(u64(2), u64(3))
	if err != nil || !sum.Eq(u64(5)) {
		t.Fatalf("Add(2,3) = %s, %v", sum.String(), err)
	}
	diff, err := Sub(u64(5), u64(3))
	if err != nil || !diff.Eq(u64(2)) {
		t.Fatalf("Sub(5,3) = %s, %v", diff.String(), err)
	}
}

func TestMin(t *testing.T) {
	if !Min(u64(3), u64(9)).Eq(u64(3)) {
		t.Fatal("Min(3,9) should be 3")
	}
	if !Min(u64(9), u64(3)).Eq(u64(3)) {
		t.Fatal("Min(9,3) should be 3")
	}
	if !Min(u64(4), u64(4)).Eq(u64(4)) {
		t.Fatal("Min(4,4) should be 4")
	}
}
