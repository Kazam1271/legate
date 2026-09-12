// Legate vault engine — runs inside a Vela confidential-compute enclave.
//
// This file is only a bridge. It converts raw WASM pointers into Go types and
// delegates to the app package, which holds all the logic and is testable
// without an enclave. Keeping the WASM-specific imports here is deliberate: the
// app package stays plain Go, so `go test ./...` needs neither TinyGo nor Vela.
package main

import (
	"github.com/HorizenOfficial/vela-common-go/wasm/types"
	"github.com/HorizenOfficial/vela-common-go/wasm/utils"

	"github.com/Kazam1271/legate/vela-app/app"
)

//export deploy
func deploy(appId int64, paramsPtr *byte, paramsLen int32) *byte {
	paramsJSON := utils.PtrToString(paramsPtr, paramsLen)
	result := app.Deploy(appId, paramsJSON)
	return types.SerializeAndWriteResult(result)
}

//export load_module
func load_module(appId int64) *byte {
	result := app.LoadModule(appId)
	return types.SerializeAndWriteResult(result)
}

//export deposit
func deposit(
	appId int64,
	senderPtr *byte, senderLen int32,
	tokenPtr *byte, tokenLen int32,
	valuePtr *byte, valueLen int32,
	statePtr *byte, stateLen int32,
) *byte {
	_ = appId
	sender := types.PtrToAddress(senderPtr, senderLen)
	token := types.PtrToAddress(tokenPtr, tokenLen)
	value := types.PtrToUint256(valuePtr, valueLen)
	stateJSON := utils.PtrToString(statePtr, stateLen)

	result := app.DepositFunds(sender, token, value, stateJSON)
	return types.SerializeAndWriteResult(result)
}

//export process_request
func process_request(
	appId int64,
	senderPtr *byte, senderLen int32,
	requestType int32,
	payloadPtr *byte, payloadLen int32,
	statePtr *byte, stateLen int32,
) *byte {
	_ = appId
	sender := types.PtrToAddress(senderPtr, senderLen)
	payloadJSON := utils.PtrToString(payloadPtr, payloadLen)
	stateJSON := utils.PtrToString(statePtr, stateLen)

	result := app.ProcessRequest(sender, requestType, payloadJSON, stateJSON)
	return types.SerializeAndWriteResult(result)
}

// trusted_request handles TRUSTPROCESS requests, which are enqueued by the
// trigger contract rather than by a user. It receives no sender and no request
// type: the payload is clear text produced on chain, so the Executor does not
// decrypt it, and its authenticity comes from the platform rather than a
// signature.
//
// Exporting this function is what opts the app into the trigger flow.
//
//export trusted_request
func trusted_request(appId int64, payloadPtr *byte, payloadLen int32, statePtr *byte, stateLen int32) *byte {
	_ = appId
	payload := utils.PtrToString(payloadPtr, payloadLen)
	stateJSON := utils.PtrToString(statePtr, stateLen)

	result := app.TrustedRequest(payload, stateJSON)
	return types.SerializeAndWriteResult(result)
}

//export get_memory_stats
func get_memory_stats() *byte {
	mapSize, cumulative := utils.GetAllocatedMemoryStats()
	return types.SerializeAndWriteResult(types.MemoryStats{
		MapSize:              mapSize,
		CumulativeMemorySize: cumulative,
	})
}

// Required by Go; unused in WASM.
func main() {}
