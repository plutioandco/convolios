#!/usr/bin/env bash
# Boots the bridge in mock mode, walks through login → begin_events → a mock
# inbound message → send_message, and prints every frame on stderr.
set -euo pipefail

cd "$(dirname "$0")"
SOCK=/tmp/meta-bridge-smoke-$$.sock
rm -f "$SOCK"

./meta-bridge --socket "$SOCK" --mock > /tmp/mbs-out.log 2> /tmp/mbs-err.log &
PID=$!
cleanup() {
  kill "$PID" 2>/dev/null || true
  rm -f "$SOCK"
}
trap cleanup EXIT

for _ in {1..20}; do
  [[ -S "$SOCK" ]] && break
  sleep 0.1
done

python3 - "$SOCK" <<'PY'
import json, socket, sys, time

path = sys.argv[1]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(path)
f = s.makefile('rwb')

def send(msg):
    data = (json.dumps(msg) + '\n').encode()
    f.write(data); f.flush()

def recv():
    return json.loads(f.readline().decode())

# 1) login
send({"jsonrpc": "2.0", "id": 1, "method": "login",
      "params": {"channel": "instagram", "username": "alice", "password": "hunter2"}})
print("login →", json.dumps(recv()))

# 2) begin_events with the account id we just got
send({"jsonrpc": "2.0", "id": 2, "method": "begin_events",
      "params": {"account_id": "mock-instagram-alice"}})
print("begin_events →", json.dumps(recv()))

# 3) send a message (immediately, no need to wait for inbound)
send({"jsonrpc": "2.0", "id": 3, "method": "send_message",
      "params": {"account_id": "mock-instagram-alice", "thread_id": "t1", "text": "hi"}})
print("send_message →", json.dumps(recv()))

# 4) expect the account_status notification
f.settimeout = 1
start = time.time()
while time.time() - start < 1:
    s.settimeout(0.5)
    try:
        line = f.readline()
        if not line: break
        msg = json.loads(line.decode())
        if msg.get('method') == 'event':
            print("event →", json.dumps(msg['params'].get('type')))
    except socket.timeout:
        break

s.close()
PY
