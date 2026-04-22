#!/usr/bin/env bash
# One-shot HR-Hermes intake (non-interactive). Enables MCP toolsets Hermes may omit in -q mode.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HR_HERMES_ROOT="$ROOT"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes-hr-hermes}"
TOOLSETS="mcp-firestore,mcp-gmail,mcp-trello,mcp-telegram,mcp-slack"
exec hermes chat -Q \
  -q "Execute the HR-Hermes intake-workflow skill end-to-end for all active projects. Follow the loaded intake-workflow skill steps exactly (poll projects, emails, process threads, approval signals). Use MCP tools." \
  -s intake-workflow \
  -t "$TOOLSETS" \
  --max-turns "${MAX_TURNS:-40}" \
  "$@"
