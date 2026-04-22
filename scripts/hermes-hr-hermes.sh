#!/usr/bin/env bash
# Start Hermes with HR-Hermes profile. Run from anywhere.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HR_HERMES_ROOT="$ROOT"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes-hr-hermes}"
exec hermes chat "$@"
