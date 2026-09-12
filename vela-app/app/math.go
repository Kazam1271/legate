package app

import (
	"errors"
	"math/bits"

	"github.com/HorizenOfficial/vela-common-go/wasm/types"
)

// Fixed-point scale used for prices and share accounting. A price of 1.0 is
// represented as ONE. 18 decimals matches ERC-20 convention and keeps rounding
// error below one wei for any realistic token amount.
const PriceScale = 18

var (
	// ErrDivByZero is returned when a denominator is zero.
	ErrDivByZero = errors.New("division by zero")
	// ErrOverflow is returned when a result does not fit in 256 bits.
	ErrOverflow = errors.New("result overflows 256 bits")
)

// One returns the fixed-point representation of 1.0 (10^PriceScale).
func One() types.Uint256 {
	v := types.NewUint256(1)
	for i := 0; i < PriceScale; i++ {
		v.Mul64(10)
	}
	return *v
}

// mul512 computes a*b as a 512-bit value held in eight little-endian 64-bit
// limbs. Schoolbook multiplication; the intermediate `hi` additions cannot
// overflow because hi <= 2^64-2 for any single 64x64 product.
func mul512(a, b types.Uint256) [8]uint64 {
	var r [8]uint64
	for i := 0; i < 4; i++ {
		var carry uint64
		for j := 0; j < 4; j++ {
			hi, lo := bits.Mul64(a[i], b[j])
			var c uint64
			lo, c = bits.Add64(lo, carry, 0)
			hi += c
			lo, c = bits.Add64(r[i+j], lo, 0)
			hi += c
			r[i+j] = lo
			carry = hi
		}
		r[i+4] = carry
	}
	return r
}

// bit512 reports bit i (0 = least significant) of a 512-bit value.
func bit512(x *[8]uint64, i int) uint64 {
	return (x[i>>6] >> uint(i&63)) & 1
}

// setBit256 sets bit i of a 256-bit value held in four limbs.
func setBit256(x *types.Uint256, i int) {
	x[i>>6] |= 1 << uint(i&63)
}

// mulDiv512 computes floor(a*b/d) exactly, using a 512-bit intermediate so no
// precision is lost when a*b exceeds 256 bits.
//
// Uint256 in vela-common-go provides no division and no 256x256 multiply, but
// pro-rata fill allocation, price conversion and share accounting all need
// both. This is the primitive the rest of the engine is built on.
//
// The algorithm is bit-by-bit long division: 512 iterations of shift-compare-
// subtract. It is deterministic and has no data-dependent branching on secret
// values beyond the comparison itself, which keeps it suitable for use inside
// the enclave.
func mulDiv512(a, b, d types.Uint256) (types.Uint256, error) {
	if d.IsZero() {
		return types.Uint256{}, ErrDivByZero
	}

	num := mul512(a, b)

	var quo types.Uint256
	var rem types.Uint256

	for i := 511; i >= 0; i-- {
		// The true remainder is (rem << 1) | bit, which can reach 2^257 and so
		// does not fit in 256 bits. Capture the bit shifted off the top before
		// shifting so the comparison below stays correct.
		top := rem[3] >> 63

		rem[3] = rem[3]<<1 | rem[2]>>63
		rem[2] = rem[2]<<1 | rem[1]>>63
		rem[1] = rem[1]<<1 | rem[0]>>63
		rem[0] = rem[0]<<1 | bit512(&num, i)

		// If a bit was shifted out, the true remainder is >= 2^256 > d, so a
		// subtraction is always required. Otherwise compare normally.
		if top == 1 || rem.Cmp(d) >= 0 {
			// Wrapping subtraction is correct here: the true remainder minus d
			// is guaranteed to be below 2^256.
			rem.Sub(rem, d)

			if i >= 256 {
				// A quotient bit above 255 means the result cannot be held.
				return types.Uint256{}, ErrOverflow
			}
			setBit256(&quo, i)
		}
	}

	return quo, nil
}

// MulDiv returns floor(a*b/d).
func MulDiv(a, b, d types.Uint256) (types.Uint256, error) {
	return mulDiv512(a, b, d)
}

// ApplyPrice converts an amount of one asset into the other at a fixed-point
// price, returning floor(amount * price / ONE).
func ApplyPrice(amount, price types.Uint256) (types.Uint256, error) {
	return mulDiv512(amount, price, One())
}

// UnapplyPrice is the inverse of ApplyPrice: floor(amount * ONE / price).
func UnapplyPrice(amount, price types.Uint256) (types.Uint256, error) {
	if price.IsZero() {
		return types.Uint256{}, ErrDivByZero
	}
	return mulDiv512(amount, One(), price)
}

// Add returns x+y, erroring on overflow rather than wrapping.
func Add(x, y types.Uint256) (types.Uint256, error) {
	var z types.Uint256
	if z.AddOverflow(x, y) {
		return types.Uint256{}, ErrOverflow
	}
	return z, nil
}

// Sub returns x-y, erroring on underflow rather than wrapping.
func Sub(x, y types.Uint256) (types.Uint256, error) {
	var z types.Uint256
	if z.SubOverflow(x, y) {
		return types.Uint256{}, ErrOverflow
	}
	return z, nil
}

// Min returns the smaller of x and y.
func Min(x, y types.Uint256) types.Uint256 {
	if x.Cmp(y) <= 0 {
		return x
	}
	return y
}
