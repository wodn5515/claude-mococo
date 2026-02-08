#!/usr/bin/env bash
# event-bridge.sh — forward hook events to the mococo hook receiver
# Called by Claude Code hooks as: bash hooks/event-bridge.sh <event_type> <detail> <session_id>

EVENT_TYPE="${1:-unknown}"
DETAIL="${2:-}"
SESSION_ID="${3:-}"
HOOK_PORT="${HOOK_PORT:-9876}"
TEAM="${MOCOCO_TEAM:-unknown}"

# Only forward if hook server is running
curl -s -X POST "http://localhost:${HOOK_PORT}/hook" \
  -H "Content-Type: application/json" \
  -d "{
    \"hook_event_name\": \"${EVENT_TYPE}\",
    \"session_id\": \"${SESSION_ID}\",
    \"mococo_team\": \"${TEAM}\",
    \"task_subject\": \"${DETAIL}\"
  }" > /dev/null 2>&1 || true

exit 0
