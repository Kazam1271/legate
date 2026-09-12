package app

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// Clients send whatever address casing their library produces. ethers emits
// checksummed addresses, while balances are keyed by the lowercase canonical
// form, so without normalisation a priced holding would report a missing price.
func TestPriceSetAcceptsAnyAddressCasing(t *testing.T) {
	checksummed := "0x" + strings.ToUpper(strings.TrimPrefix(tokenWETH.Hex(), "0x"))
	body := `{"` + checksummed + `":"0xa2a15d09519be00000"}` // 3000e18

	var prices PriceSet
	if err := json.Unmarshal([]byte(body), &prices); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	got, ok := prices.Price(tokenWETH, tokenUSDC)
	if !ok {
		t.Fatal("a checksummed key must resolve to the same token")
	}
	if !got.Eq(price(t, 3_000)) {
		t.Fatalf("price = %s, want 3000e18", got.String())
	}
}

func TestPriceSetValuesAHoldingPricedWithAChecksummedKey(t *testing.T) {
	st := newTestState(t)
	s, _ := st.Strategy("alpha")
	if err := s.credit(tokenWETH, u64(2)); err != nil {
		t.Fatalf("credit: %v", err)
	}

	checksummed := "0x" + strings.ToUpper(strings.TrimPrefix(tokenWETH.Hex(), "0x"))
	var prices PriceSet
	if err := json.Unmarshal([]byte(`{"`+checksummed+`":"0x3e8"}`), &prices); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// A raw price of 1000 (not 1000e18) against 2 units values to zero after
	// fixed-point scaling; what matters here is that the lookup succeeds.
	if _, err := st.NAV(s, prices); err != nil {
		t.Fatalf("NAV with a checksummed price key: %v", err)
	}
}

// Merging keys that differ only by case would keep whichever Go's randomised map
// iteration reached last, making NAV — and the state root — vary between runs.
func TestPriceSetRejectsTheSameTokenTwice(t *testing.T) {
	lower := tokenWETH.Hex()
	upper := "0x" + strings.ToUpper(strings.TrimPrefix(lower, "0x"))
	body := `{"` + lower + `":"0x1","` + upper + `":"0x2"}`

	var prices PriceSet
	err := json.Unmarshal([]byte(body), &prices)
	if !errors.Is(err, ErrDuplicatePriceKey) {
		t.Fatalf("expected ErrDuplicatePriceKey, got %v", err)
	}
}

func TestPriceSetRejectsAKeyThatIsNotAnAddress(t *testing.T) {
	var prices PriceSet
	if err := json.Unmarshal([]byte(`{"WETH":"0x1"}`), &prices); err == nil {
		t.Fatal("a non-address price key must be rejected")
	}
}

// The command path must pick the normalisation up too, not just direct unmarshal.
func TestAllocateCommandAcceptsChecksummedPriceKeys(t *testing.T) {
	checksummed := "0x" + strings.ToUpper(strings.TrimPrefix(tokenWETH.Hex(), "0x"))
	payload := `{"command":"allocate","allocate":{"strategyId":"alpha","amount":"0x64","prices":{"` +
		checksummed + `":"0xa2a15d09519be00000"}}}`

	var instr PayloadInstructions
	if err := json.Unmarshal([]byte(payload), &instr); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := instr.Allocate.Prices.Price(tokenWETH, tokenUSDC); !ok {
		t.Fatal("price keyed by a checksummed address must resolve through the command payload")
	}
}
