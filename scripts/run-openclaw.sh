#!/usr/bin/env bash
# Run Agent Town on OpenClaw with the planner / researcher / critic work lifecycle enabled.
# Overrides .env.local for this process only; no secrets are printed or written.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-3108}"
GATEWAY_URL="${GATEWAY_URL:-ws://127.0.0.1:18789/}"
export GATEWAY_TOKEN="${GATEWAY_TOKEN:-$(node -e 'const c=JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.openclaw/openclaw.json","utf8"));process.stdout.write(c.gateway?.auth?.token??"")')}"
export PORT GATEWAY_URL
export AGENT_PROVIDER=openclaw
export AGENT_TOWN_TEXT_NEMOTRON_ONLY=0
export AGENT_TOWN_SPECIALIST_GRANTS='[]'
export AGENT_TOWN_EXECUTION_PREFERENCE='["openclaw-local"]'
export AGENT_TOWN_EXECUTION_OPTIONS="[{\"id\":\"openclaw-local\",\"provider\":\"openclaw\",\"gatewayUrl\":\"${GATEWAY_URL}\",\"tokenEnv\":\"GATEWAY_TOKEN\",\"sharedAgent\":\"main\",\"grants\":[{\"manifestId\":\"planner\",\"seatId\":\"oc-planner\",\"sessionKey\":\"agent:town-planner:main\"},{\"manifestId\":\"data-steward-researcher\",\"seatId\":\"oc-researcher\",\"sessionKey\":\"agent:town-researcher:main\"},{\"manifestId\":\"critic\",\"seatId\":\"oc-critic\",\"sessionKey\":\"agent:town-critic:main\"}]}]"
# Set AGENT_TOWN_EXECUTION_OPTIONS_DISABLED=1 to run on OpenClaw without the specialist router,
# which also stops its periodic tools.effective discovery against the gateway.
if [ "${AGENT_TOWN_EXECUTION_OPTIONS_DISABLED:-0}" = "1" ]; then
  export AGENT_TOWN_EXECUTION_OPTIONS='[]'
fi
exec node --env-file=.env.local --import tsx server.ts
