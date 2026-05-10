#!/usr/bin/env bash
# qmd-openrouter.sh — QMD wrapper that routes embeddings through OpenRouter
# instead of the local GGUF embeddinggemma that QMD ships with.
#
# Why: the local model is fine for casual use but is not what you want for a
# vault you'll be querying for years. Also the local model is small (768-dim);
# we want the 3072-dim Gemini embedding via OpenRouter.
#
# Reads OPENROUTER_API_KEY from $ENV_FILE (default: $HOME/.config/ai-literature-os.env).
#
# Usage:
#   qmd-openrouter.sh embed -f                  # full re-embed (use deliberately)
#   qmd-openrouter.sh vsearch "my query" -c science
#   qmd-openrouter.sh update && qmd-openrouter.sh embed --collection science

set -euo pipefail

ENV_FILE="${ENV_FILE:-$HOME/.config/ai-literature-os.env}"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY not set; configure in $ENV_FILE}"

# Bun (which qmd runs under) needs to be on PATH. Adjust if your bun lives elsewhere.
export PATH="${BUN_PATH:-$HOME/.bun/bin}:$PATH"

export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
export OPENAI_API_KEY="$OPENROUTER_API_KEY"
export QMD_EMBED_MODEL="${QMD_EMBED_MODEL:-google/gemini-embedding-2-preview}"

exec qmd "$@"
