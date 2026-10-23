#!/bin/sh
# Integration proof: one live dispatch wave (bills models).
# Override PI_BIN to point at a pi >= 1.4.0 executable. Requires GNU timeout on PATH.
set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PI_BIN=${PI_BIN:-pi}
WORK="$REPO_DIR/.pi/work"
WAVE="prove-$(date +%s)"

mkdir -p "$WORK"
cat > "$WORK/$WAVE-quick-brief.md" <<'EOF'
You are a dispatched read-only leaf. Reply with exactly `PROVE-DONE` and nothing else. No tool calls.
EOF

echo "== unit tests =="
node "$REPO_DIR/tests/derive.test.ts"

echo "== dispatch rejects a blind MCP lane (no reach route in tools) =="
"$PI_BIN" --print --no-session -ne -e "$REPO_DIR/src/index.ts" "Call the dispatch tool with wave=\"$WAVE-blind\", lanes=[{name:\"blind\",briefPath:\"$WORK/$WAVE-quick-brief.md\",model:\"zai/glm-5.3-flash\"}]. The call must fail with an error about MCP reach; report the exact error text. Do not retry with changes."
test ! -e "$WORK/$WAVE-blind-manifest.json" || { echo "FAIL: rejection stranded the wave slug"; exit 1; }

echo "== dispatch wave $WAVE (one quick lane, flash, offline) =="
"$PI_BIN" --print --no-session -ne -e "$REPO_DIR/src/index.ts" "Call the dispatch tool with wave=\"$WAVE\", lanes=[{name:\"quick\",briefPath:\"$WORK/$WAVE-quick-brief.md\",model:\"zai/glm-5.3-flash\",deadlineSec:180,mcp:false}]. Report the result, then stop."

echo "== poll status =="
"$PI_BIN" --print --no-session -ne -e "$REPO_DIR/src/index.ts" "Call the lanes tool with wave=\"$WAVE\", action=\"status\". Report the result verbatim, then stop."

echo "== collect =="
"$PI_BIN" --print --no-session -ne -e "$REPO_DIR/src/index.ts" "Call the lanes tool with wave=\"$WAVE\", action=\"collect\". Report the result verbatim and the artifact file's exact content, then stop."

echo "== artifact =="
cat "$WORK/$WAVE-quick.md"
echo "== expected content: PROVE-DONE =="
