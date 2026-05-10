#!/usr/bin/env bash
#
# relate-papers.sh — Compute paper-to-paper neighbors from QMD's vector
# embeddings and write to a sidecar JSON file (`_related-papers.json`).
#
# Pure local math: reads embeddings from QMD's SQLite store, computes
# all-pairs cosine similarity, ranks neighbors per paper. Zero API calls.
#
# Why a sidecar instead of paper frontmatter: writing neighbors into each
# paper's YAML frontmatter changes its file hash and triggers a vault-wide
# QMD re-embed every night the script runs. The sidecar is cheap to rewrite
# and stays out of the search-stack scan path.
#
# Usage:
#   relate-papers.sh                  # Update sidecar (skip entries already present)
#   relate-papers.sh --force          # Recompute every entry
#   relate-papers.sh --dry-run        # Print results without writing
#   relate-papers.sh --min-score S    # Minimum similarity score (default: 0.83)
#   relate-papers.sh --max N          # Maximum neighbors per paper (default: 30)
#
# Threshold notes:
#   - The default 0.83 is calibrated for google/gemini-embedding-2-preview (3072-dim).
#   - If you change the embedding model, re-tune with `--dry-run --min-score X`
#     and watch the "isolated papers" / "neighbors per paper" tail in the output.
#   - For 768-dim or smaller models, expect a different working threshold.

set -euo pipefail

ENV_FILE="${ENV_FILE:-$HOME/.config/ai-literature-os.env}"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

: "${VAULT_DIR:?VAULT_DIR not set; configure in $ENV_FILE}"
: "${NAV_DIR:?NAV_DIR not set; configure in $ENV_FILE}"

QMD_INDEX="${QMD_INDEX:-$HOME/.cache/qmd/index.sqlite}"
MIN_SCORE="${MIN_SCORE:-0.83}"
MAX_N="${MAX_N:-30}"
FORCE=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force) FORCE=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        --min-score) MIN_SCORE="$2"; shift 2 ;;
        --max) MAX_N="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ ! -f "$QMD_INDEX" ]]; then
    echo "ERROR: QMD index not found at $QMD_INDEX" >&2
    echo "Run 'qmd-openrouter.sh update && qmd-openrouter.sh embed --collection science' first." >&2
    exit 1
fi

mkdir -p "$NAV_DIR"

echo "$(date '+%Y-%m-%d %H:%M:%S') — Computing related papers (min_score=$MIN_SCORE, max=$MAX_N, force=$FORCE, dry_run=$DRY_RUN)"

VENV_PYTHON="${VENV_PYTHON:-$HOME/.venvs/ai-literature-os/bin/python}"

"$VENV_PYTHON" - "$VAULT_DIR" "$NAV_DIR" "$QMD_INDEX" "$MIN_SCORE" "$MAX_N" "$FORCE" "$DRY_RUN" "${QMD_COLLECTION:-science}" << 'PYEOF'
import json, sqlite3, sys, time
from pathlib import Path
import numpy as np

VAULT_DIR = Path(sys.argv[1])
NAV_DIR = Path(sys.argv[2])
QMD_INDEX = sys.argv[3]
MIN_SCORE = float(sys.argv[4])
MAX_N = int(sys.argv[5])
FORCE = sys.argv[6].lower() == "true"
DRY_RUN = sys.argv[7].lower() == "true"
COLLECTION = sys.argv[8]
DIMS = int(__import__("os").environ.get("EMBEDDING_DIMS", "3072"))
SIDECAR_PATH = NAV_DIR / "_related-papers.json"

t0 = time.time()

# --- Step 1: Load embeddings from QMD index ---
db = sqlite3.connect(QMD_INDEX)

hash_to_path = {}
for row in db.execute(
    """
    SELECT hash, path FROM documents
    WHERE collection=? AND active=1
      AND path NOT LIKE '\\_topic%' ESCAPE '\\'
      AND path NOT LIKE '\\_index%' ESCAPE '\\'
      AND path NOT LIKE '\\_review%' ESCAPE '\\'
    """,
    (COLLECTION,),
):
    hash_to_path[row[0]] = row[1]

hash_seq_to_rowinfo = {}
for row in db.execute("SELECT id, chunk_id, chunk_offset FROM vectors_vec_rowids"):
    h = row[0].rsplit('_', 1)[0]
    if h in hash_to_path:
        hash_seq_to_rowinfo[row[0]] = (row[1], row[2])

chunk_blobs = {}
for row in db.execute("SELECT rowid, vectors FROM vectors_vec_vector_chunks00"):
    chunk_blobs[row[0]] = np.frombuffer(row[1], dtype=np.float32).reshape(-1, DIMS)

db.close()

# Average chunk vectors per paper -> single normalized embedding
paper_vecs = {}
for hash_seq, (chunk_id, chunk_offset) in hash_seq_to_rowinfo.items():
    h = hash_seq.rsplit('_', 1)[0]
    path = hash_to_path.get(h)
    if not path:
        continue
    vec = chunk_blobs[chunk_id][chunk_offset].copy()
    paper_vecs.setdefault(path, []).append(vec)

paper_embeddings = {}
for path, vecs in paper_vecs.items():
    avg = np.mean(vecs, axis=0)
    norm = np.linalg.norm(avg)
    if norm > 0:
        avg /= norm
    paper_embeddings[path] = avg

paths = sorted(paper_embeddings.keys())
n = len(paths)
print(f"  Papers with embeddings: {n}")

if n == 0:
    print("  No embeddings found — has the vault been embedded yet?")
    sys.exit(1)

# --- Step 2: All-pairs cosine similarity ---
matrix = np.stack([paper_embeddings[p] for p in paths])
sim = matrix @ matrix.T
np.fill_diagonal(sim, -1)
print(f"  Similarity matrix ({n}x{n}) computed in {time.time() - t0:.2f}s")

# --- Step 3: Build normalized filename map ---
def normalize_name(name):
    n = name.lower()
    n = n.replace('_-_', '-').replace('_', '-')
    while '--' in n:
        n = n.replace('--', '-')
    return n

vault_files = {}
for f in VAULT_DIR.iterdir():
    if f.suffix == '.md' and not f.name.startswith('_'):
        vault_files[normalize_name(f.name)] = f

# --- Step 4: Load existing sidecar (for incremental updates) ---
existing = {}
if not FORCE and SIDECAR_PATH.exists():
    try:
        existing = json.loads(SIDECAR_PATH.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError):
        existing = {}

# --- Step 5: Compute neighbors and build sidecar data ---
sidecar = {}
computed = reused = no_file = 0
neighbor_counts = []

for i, path in enumerate(paths):
    filepath = vault_files.get(normalize_name(path))
    if not filepath or not filepath.exists():
        no_file += 1
        continue

    fname = filepath.name

    if not FORCE and fname in existing:
        sidecar[fname] = existing[fname]
        reused += 1
        continue

    scores = sim[i]
    above = np.where(scores >= MIN_SCORE)[0]
    above = above[np.argsort(scores[above])[::-1]][:MAX_N]

    neighbors = []
    for j in above:
        nb_file = vault_files.get(normalize_name(paths[j]))
        if nb_file:
            neighbors.append({"file": nb_file.name, "score": round(float(scores[j]), 3)})

    neighbor_counts.append(len(neighbors))
    sidecar[fname] = neighbors
    computed += 1

    if DRY_RUN and (computed <= 3 or computed % 250 == 0):
        print(f"\n  {fname}: {len(neighbors)} neighbors")
        for nb in neighbors[:5]:
            print(f"    {nb['score']:.3f}  {nb['file']}")
        if len(neighbors) > 5:
            print(f"    ... and {len(neighbors) - 5} more")

# --- Step 6: Write sidecar ---
# Refuse-to-overwrite guard: if vec0 is broken (dim-mismatch wipe, mid-embed
# crash, etc.), the new sidecar will only have a handful of papers and
# clobbering a 1,000-entry sidecar with that would silently corrupt the
# navigation layer. Refuse the overwrite, exit non-zero, and preserve the
# existing sidecar so the cron run flags the problem.
if not DRY_RUN and existing:
    new_count = len(sidecar)
    old_count = len(existing)
    if old_count >= 100 and new_count < 0.5 * old_count:
        print(
            f"  REFUSING to overwrite {SIDECAR_PATH.name}: existing has "
            f"{old_count} entries, new computation only {new_count} "
            f"({new_count/old_count*100:.0f}%). Existing sidecar preserved. "
            f"Investigate vec0 vs content_vectors mismatch before re-running.",
            file=sys.stderr,
        )
        sys.exit(2)

if not DRY_RUN:
    SIDECAR_PATH.write_text(json.dumps(sidecar, indent=2, sort_keys=True), encoding='utf-8')

action = "Would write" if DRY_RUN else "Wrote"
print(f"\n  {action}: {SIDECAR_PATH.name} ({len(sidecar)} entries)")
print(f"  Computed: {computed}, Reused from cache: {reused}")
if no_file:
    print(f"  Missing vault files: {no_file}")
if neighbor_counts:
    nc = np.array(neighbor_counts)
    print(f"  Neighbors per paper: min={nc.min()}, median={int(np.median(nc))}, mean={nc.mean():.1f}, max={nc.max()}")
print(f"  Total time: {time.time() - t0:.1f}s")
PYEOF

echo "$(date '+%Y-%m-%d %H:%M:%S') — Done"
