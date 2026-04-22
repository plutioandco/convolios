package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"sync"
)

// JSON-RPC 2.0 wire types. We only use a subset — ids are always integers,
// params are always objects, and we never issue server-to-client requests
// that expect responses (notifications only).

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *uint64         `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string  `json:"jsonrpc"`
	ID      uint64  `json:"id"`
	Result  any     `json:"result,omitempty"`
	Error   *rpcErr `json:"error,omitempty"`
}

type rpcNotification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcErr struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// writerWithLock bundles an io.Writer with a mutex. Multiple goroutines
// (request handlers + the bridge's event goroutine) write concurrently, and
// the Unix socket has no implicit framing, so every write must be atomic.
type writerWithLock struct {
	w  io.Writer
	mu *sync.Mutex
}

// Server routes incoming RPC calls to bridge methods. A new Server is created
// per-connection, but they all share the same underlying Bridge.
type Server struct {
	bridge *Bridge
}

func NewServer(b *Bridge) *Server {
	return &Server{bridge: b}
}

func (s *Server) Serve(ctx context.Context, conn net.Conn) {
	defer conn.Close()

	writer := writerWithLock{w: conn, mu: &sync.Mutex{}}
	s.bridge.SetNotifier(func(method string, params any) {
		_ = writeJSON(writer, rpcNotification{
			JSONRPC: "2.0",
			Method:  method,
			Params:  params,
		})
	})

	reader := bufio.NewReader(conn)
	for {
		if ctx.Err() != nil {
			return
		}
		line, err := reader.ReadBytes('\n')
		if err != nil {
			if err != io.EOF {
				logf("read: %v", err)
			}
			return
		}
		if len(line) == 0 {
			continue
		}

		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			logf("bad json from parent: %v", err)
			continue
		}

		// Notifications (no id) — only `shutdown` today.
		if req.ID == nil {
			if req.Method == "shutdown" {
				s.bridge.Shutdown()
				return
			}
			logf("unhandled notification: %s", req.Method)
			continue
		}

		// Dispatch each request on its own goroutine so a slow login
		// challenge doesn't block unrelated pings.
		go func(req rpcRequest) {
			result, rpcError := s.dispatch(ctx, req.Method, req.Params)
			resp := rpcResponse{JSONRPC: "2.0", ID: *req.ID}
			if rpcError != nil {
				resp.Error = rpcError
			} else {
				resp.Result = result
			}
			if err := writeJSON(writer, resp); err != nil {
				logf("write response: %v", err)
			}
		}(req)
	}
}

func (s *Server) dispatch(ctx context.Context, method string, raw json.RawMessage) (any, *rpcErr) {
	switch method {
	case "login":
		var p loginParams
		if err := unmarshal(raw, &p); err != nil {
			return nil, invalidParams(err)
		}
		return s.bridge.Login(ctx, p)
	case "resume":
		var p resumeParams
		if err := unmarshal(raw, &p); err != nil {
			return nil, invalidParams(err)
		}
		return s.bridge.Resume(ctx, p)
	case "begin_events":
		var p beginEventsParams
		if err := unmarshal(raw, &p); err != nil {
			return nil, invalidParams(err)
		}
		return s.bridge.BeginEvents(ctx, p)
	case "send_message":
		var p sendParams
		if err := unmarshal(raw, &p); err != nil {
			return nil, invalidParams(err)
		}
		return s.bridge.SendMessage(ctx, p)
	case "health":
		return map[string]any{"ok": true}, nil
	default:
		return nil, &rpcErr{Code: -32601, Message: "method not found: " + method}
	}
}

func unmarshal[T any](raw json.RawMessage, dest *T) error {
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, dest)
}

func invalidParams(err error) *rpcErr {
	return &rpcErr{Code: -32602, Message: "invalid params: " + err.Error()}
}

func internalError(err error) *rpcErr {
	return &rpcErr{Code: -32000, Message: err.Error()}
}
