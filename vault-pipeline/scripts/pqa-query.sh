#!/usr/bin/env bash
# pqa-query.sh — Query the vault with PaperQA2.
#
# For deep synthesis across many papers with passage-level citations.
# For quick keyword lookup, use QMD instead.
#
# Usage:
#   pqa-query.sh "What is the mechanism by which X induces Y?"

set -euo pipefail

ENV_FILE="${ENV_FILE:-$HOME/.config/ai-literature-os.env}"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY not set; configure in $ENV_FILE}"
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY not set; configure in $ENV_FILE}"

VENV_PYTHON="${VENV_PYTHON:-$HOME/.venvs/ai-literature-os/bin/python}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYSCRIPT="$SCRIPT_DIR/pqa-query.py"

if [[ -z "${1:-}" ]]; then
    echo "Usage: pqa-query.sh \"your question here\"" >&2
    exit 1
fi

if [[ ! -x "$VENV_PYTHON" ]]; then
    echo "ERROR: venv python not found at $VENV_PYTHON" >&2
    echo "Set VENV_PYTHON in $ENV_FILE or create the venv per docs/setup.md" >&2
    exit 1
fi

exec "$VENV_PYTHON" "$PYSCRIPT" "$@"
