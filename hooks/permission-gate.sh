#!/usr/bin/env bash
# permission-gate.sh — config-driven permission enforcement per team
# Called by Claude Code PreToolUse hook
# Reads teams.json to determine what each team can/cannot do

TOOL_NAME="${1:-}"
TOOL_INPUT="${2:-}"
TEAM="${MOCOCO_TEAM:-}"

# If not running as a mococo team, allow everything
if [ -z "$TEAM" ]; then
  exit 0
fi

TEAMS_JSON="teams.json"
if [ ! -f "$TEAMS_JSON" ]; then
  exit 0
fi

# Check globalDeny first
GLOBAL_DENY=$(python3 -c "
import json, sys
with open('$TEAMS_JSON') as f:
    cfg = json.load(f)
for rule in cfg.get('globalDeny', []):
    if rule.lower() in '''$TOOL_NAME $TOOL_INPUT'''.lower():
        print('BLOCKED')
        sys.exit(0)
" 2>/dev/null)

if [ "$GLOBAL_DENY" = "BLOCKED" ]; then
  echo "BLOCKED by globalDeny: $TOOL_NAME" >&2
  exit 2
fi

# Check per-team permissions
RESULT=$(python3 -c "
import json, sys
with open('$TEAMS_JSON') as f:
    cfg = json.load(f)
team = cfg.get('teams', {}).get('$TEAM', {})
perms = team.get('permissions', {})
tool_context = '''$TOOL_NAME $TOOL_INPUT'''.lower()

# Check deny list
for rule in perms.get('deny', []):
    if rule.lower() in tool_context:
        print('DENIED')
        sys.exit(0)

# Check allow list (if present, only listed actions are allowed for restricted tools)
allow = perms.get('allow', [])
if allow:
    for rule in allow:
        if rule.lower() in tool_context:
            print('ALLOWED')
            sys.exit(0)

print('OK')
" 2>/dev/null)

if [ "$RESULT" = "DENIED" ]; then
  echo "BLOCKED by team permissions ($TEAM): $TOOL_NAME" >&2
  exit 2
fi

exit 0
