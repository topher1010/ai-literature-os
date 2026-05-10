#!/usr/bin/env bash
#
# integrate-paper.sh — Per-paper LLM integration for the vault literature map.
#
# Reads a paper's full markdown, sends it to Claude Sonnet via the claude CLI,
# and patches frontmatter with: tags, key_findings, integrated.
#
# Paper-to-paper neighbors are computed separately by relate-papers.sh into
# the $NAV_DIR/_related-papers.json sidecar (NOT written here).
#
# Design: the LLM is invoked without file-write tools; it returns a JSON block.
# This shell script parses that JSON and patches the targeted paper's
# frontmatter. Splitting "LLM proposes" from "shell script writes" means a
# malformed or wrong-paper response cannot accidentally rewrite arbitrary
# fields elsewhere in the vault.
#
# Usage:
#   integrate-paper.sh FILE [FILE ...]       # Integrate specific files
#   integrate-paper.sh --batch [N]           # Integrate up to N unintegrated papers (default 3)
#   integrate-paper.sh --dry-run FILE        # Preview without writing
#   integrate-paper.sh --force FILE          # Re-integrate even if already done
#
# Required env: VAULT_DIR. Optional: LOG_DIR, CLAUDE_BIN.

set -euo pipefail

ENV_FILE="${ENV_FILE:-$HOME/.config/ai-literature-os.env}"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

# Unset to allow running from cron or nested contexts where Claude Code itself runs
unset CLAUDECODE 2>/dev/null || true

: "${VAULT_DIR:?VAULT_DIR not set; configure in $ENV_FILE}"

LOG_DIR="${LOG_DIR:-/tmp}"
LOG_FILE="$LOG_DIR/integrate-paper.log"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
MAX_BATCH=3
DRY_RUN=false
FORCE=false
MODEL="${INTEGRATE_MODEL:-claude-sonnet-4-6}"

# ── Parse arguments ─────────────────────────────────────────────────────────

FILES=()
BATCH_MODE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --force)   FORCE=true; shift ;;
        --batch)
            BATCH_MODE=true
            shift
            if [[ $# -gt 0 && "$1" =~ ^[0-9]+$ ]]; then
                MAX_BATCH="$1"; shift
            fi
            ;;
        --help|-h)
            echo "Usage: integrate-paper.sh [--batch [N]] [--dry-run] [--force] [FILE ...]"
            exit 0
            ;;
        *) FILES+=("$1"); shift ;;
    esac
done

# ── Batch mode: find unintegrated papers ────────────────────────────────────

if $BATCH_MODE; then
    while IFS= read -r -d '' f; do
        [[ "$(basename "$f")" == _* ]] && continue
        if ! $FORCE && grep -q "^integrated:" "$f" 2>/dev/null; then
            continue
        fi
        FILES+=("$f")
        if [[ ${#FILES[@]} -ge $MAX_BATCH ]]; then
            break
        fi
    done < <(find "$VAULT_DIR" -maxdepth 1 -name '*.md' -print0 | sort -z)
fi

if [[ ${#FILES[@]} -eq 0 ]]; then
    echo "No files to integrate." >&2
    exit 0
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') — Integrating ${#FILES[@]} paper(s)" | tee -a "$LOG_FILE"

# ── Collect current tag vocabulary from vault ───────────────────────────────
# Top-200 tags by frequency so the LLM preferentially reuses established
# vocabulary instead of inventing synonyms.

EXISTING_TAGS=$(grep -h "^tags:" "$VAULT_DIR"/*.md 2>/dev/null \
    | sed 's/^tags:\s*\[//; s/\]$//' \
    | tr ',' '\n' \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^"//; s/"$//' \
    | grep -v -x -E 'abstract-only|pubmed|pmcid|llm|failed|preprint|in-review|in-press' \
    | grep -v '^$' \
    | sort | uniq -c | sort -rn \
    | head -200 \
    | awk '{print $2}' \
    | tr '\n' ',' \
    | sed 's/,$//' || true)

# ── Build the system prompt ────────────────────────────────────────────────

read -r -d '' SYSTEM_PROMPT << 'SYSPROMPT' || true
You are a scientific literature analyst. You read research papers and extract structured metadata for a literature map.

RULES:
1. key_findings: State specific experimental results. Format: "In [model/system], [intervention] caused [measured outcome]." One concluding sentence is allowed. Do NOT rehash the abstract. 3-5 findings per paper.
2. tags: Factual descriptors for keyword search. Use lowercase, hyphenated. STRONGLY prefer reusing tags from the existing vocabulary list provided — only coin a new tag when no existing tag covers the concept. 5-10 tags per paper.
3. Do NOT interpret beyond what the paper states. Limited correct interpretation is acceptable. Incorrect interpretation is very bad.

Respond with ONLY valid JSON, no markdown fencing.
SYSPROMPT

# ── Process each file ──────────────────────────────────────────────────────

for filepath in "${FILES[@]}"; do
    if [[ ! "$filepath" = /* ]]; then
        if [[ -f "$VAULT_DIR/$filepath" ]]; then
            filepath="$VAULT_DIR/$filepath"
        fi
    fi

    if [[ ! -f "$filepath" ]]; then
        echo "  SKIP: File not found: $filepath" | tee -a "$LOG_FILE"
        continue
    fi

    fname=$(basename "$filepath")
    echo "  Processing: $fname" | tee -a "$LOG_FILE"

    if ! $FORCE && grep -q "^integrated:" "$filepath"; then
        echo "    Already integrated, skipping (use --force to re-run)" | tee -a "$LOG_FILE"
        continue
    fi

    PAPER_TEXT=$(head -800 "$filepath")

    USER_PROMPT="Existing tags in the vault (prefer reusing): ${EXISTING_TAGS:-none yet}

Read this paper and return JSON with exactly these fields:
{
  \"key_findings\": [\"finding 1\", \"finding 2\", ...],
  \"tags\": [\"tag-1\", \"tag-2\", ...]
}

Paper:
${PAPER_TEXT}"

    RESPONSE=$(echo "$USER_PROMPT" | "$CLAUDE_BIN" -p \
        --model "$MODEL" \
        --system-prompt "$SYSTEM_PROMPT" \
        --allowedTools "" \
        2>> "$LOG_FILE") || {
        echo "    ERROR: API call failed for $fname" | tee -a "$LOG_FILE"
        continue
    }

    JSON=$(echo "$RESPONSE" | sed -n '/^{/,/^}/p' | head -50)

    if [[ -z "$JSON" ]]; then
        echo "    ERROR: No JSON in response for $fname" | tee -a "$LOG_FILE"
        echo "    Response was: $(echo "$RESPONSE" | head -5)" >> "$LOG_FILE"
        continue
    fi

    if ! echo "$JSON" | python3 -m json.tool > /dev/null 2>&1; then
        echo "    ERROR: Invalid JSON for $fname" | tee -a "$LOG_FILE"
        echo "    JSON was: $(echo "$JSON" | head -10)" >> "$LOG_FILE"
        continue
    fi

    KEY_FINDINGS=$(echo "$JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for f in d.get('key_findings', []):
    print(f)
" 2>/dev/null)

    TAGS=$(echo "$JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tags = d.get('tags', [])
print('[' + ', '.join(f'\"{t}\"' for t in tags) + ']')
" 2>/dev/null)

    if $DRY_RUN; then
        echo "    [DRY RUN] Would patch $fname:"
        echo "      tags: $TAGS"
        echo "      key_findings: $(echo "$KEY_FINDINGS" | head -2)..."
        continue
    fi

    # ── Patch frontmatter using Python (safe YAML manipulation) ─────────

    python3 << PYPATCH
import re, json, sys
from pathlib import Path
from datetime import date

filepath = Path("$filepath")
text = filepath.read_text(encoding="utf-8", errors="replace")

json_str = '''$JSON'''
try:
    data = json.loads(json_str)
except json.JSONDecodeError:
    print("    ERROR: JSON parse failed in patcher", file=sys.stderr)
    sys.exit(1)

tags = data.get("tags", [])
key_findings = data.get("key_findings", [])

fm_match = re.match(r'^---\s*\n(.*?)\n---', text, re.DOTALL)
if not fm_match:
    print("    ERROR: No frontmatter found", file=sys.stderr)
    sys.exit(1)

fm_text = fm_match.group(1)
after_fm = text[fm_match.end():]

new_fields = {}
new_fields["tags"] = "[" + ", ".join(f'"{t}"' for t in tags) + "]"
new_fields["integrated"] = str(date.today())

existing_kf = re.search(r'^key_findings:\s*\[(.+?)\]', fm_text, re.MULTILINE | re.DOTALL)
if key_findings:
    kf_yaml = "key_findings:\n" + "\n".join(f'  - "{f}"' for f in key_findings)
    if existing_kf or re.search(r'^key_findings:', fm_text, re.MULTILINE):
        fm_text = re.sub(r'^key_findings:.*?(?=^\w|\Z)', '', fm_text, flags=re.MULTILINE | re.DOTALL)
    fm_text = fm_text.rstrip() + "\n" + kf_yaml + "\n"

tags_yaml = "tags: " + new_fields["tags"]
if re.search(r'^tags:', fm_text, re.MULTILINE):
    fm_text = re.sub(r'^tags:.*$', tags_yaml, fm_text, flags=re.MULTILINE)
else:
    fm_text = fm_text.rstrip() + "\n" + tags_yaml + "\n"

int_yaml = "integrated: " + new_fields["integrated"]
if re.search(r'^integrated:', fm_text, re.MULTILINE):
    fm_text = re.sub(r'^integrated:.*$', int_yaml, fm_text, flags=re.MULTILINE)
else:
    fm_text = fm_text.rstrip() + "\n" + int_yaml + "\n"

new_text = "---\n" + fm_text.strip() + "\n---" + after_fm
filepath.write_text(new_text, encoding="utf-8")
print(f"    Patched: tags={len(tags)}, findings={len(key_findings)}")
PYPATCH

    echo "    Done: $fname" | tee -a "$LOG_FILE"
done

echo "$(date '+%Y-%m-%d %H:%M:%S') — Integration complete" | tee -a "$LOG_FILE"
