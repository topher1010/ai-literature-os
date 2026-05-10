#!/usr/bin/env python3
"""
cluster-vault-graph.py — Graph-based community detection for the vault.

Discovers emergent topic clusters from the embedding graph using Leiden
community detection, supports multi-cluster membership via per-community
centroid percentiles, and labels communities via Claude Sonnet (cached).

Architecture:
  1. Load per-paper embeddings from QMD SQLite (3072-dim, L2-normalized)
  2. Build k-NN graph (sklearn kneighbors_graph -> igraph)
  3. Run Leiden community detection (leidenalg)
  4. Compute soft membership via per-community centroid percentiles
  5. Label communities via Claude Sonnet CLI (with Jaccard-based caching)
  6. Write _topic-*.md files

Subcommands:
  diagnose   Build graph, run Leiden, print stats. No writes.
  label      Generate community labels via Claude Sonnet.
  generate   Write _topic-*.md files from labeled communities.
  full-run   All three steps sequentially.

Required env: VAULT_DIR.
Optional env: NAV_DIR (default: $VAULT_DIR/../nav),
              QMD_INDEX (default: ~/.cache/qmd/index.sqlite),
              CLAUDE_BIN (default: 'claude').

Usage:
  cluster-vault-graph.py diagnose --sweep
  cluster-vault-graph.py diagnose --resolution 2.5
  cluster-vault-graph.py label --dry-run
  cluster-vault-graph.py generate --dry-run
  cluster-vault-graph.py full-run --resolution 8.0 --percentile 60
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import igraph as ig
import leidenalg as la
import numpy as np
from sklearn.neighbors import kneighbors_graph

VAULT_DIR = Path(os.environ.get("VAULT_DIR") or sys.exit("ERROR: VAULT_DIR not set in environment")).expanduser()
NAV_DIR = Path(os.environ.get("NAV_DIR", str(VAULT_DIR.parent / "nav"))).expanduser()
QMD_INDEX = Path(os.environ.get("QMD_INDEX", str(Path.home() / ".cache/qmd/index.sqlite"))).expanduser()
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
QMD_COLLECTION = os.environ.get("QMD_COLLECTION", "science")
DIMS = int(os.environ.get("EMBEDDING_DIMS", "3072"))
CACHE_PATH = NAV_DIR / "_topic-cache.json"
FRONTMATTER_RE = re.compile(r'^---\s*\n(.*?)\n---', re.DOTALL)


def load_embeddings(qmd_index: Path) -> dict[str, np.ndarray]:
    """Load per-paper averaged + normalized embeddings from QMD."""
    db = sqlite3.connect(str(qmd_index))

    hash_to_path: dict[str, str] = {}
    for row in db.execute(
        r"""
        SELECT hash, path FROM documents
        WHERE collection=? AND active=1
          AND path NOT LIKE '\_topic%' ESCAPE '\'
          AND path NOT LIKE '\_index%' ESCAPE '\'
          AND path NOT LIKE '\_review%' ESCAPE '\'
        """,
        (QMD_COLLECTION,),
    ):
        hash_to_path[row[0]] = row[1]

    hash_seq_to_rowinfo: dict[str, tuple[int, int]] = {}
    for row in db.execute("SELECT id, chunk_id, chunk_offset FROM vectors_vec_rowids"):
        h = row[0].rsplit("_", 1)[0]
        if h in hash_to_path:
            hash_seq_to_rowinfo[row[0]] = (row[1], row[2])

    chunk_blobs: dict[int, np.ndarray] = {}
    for row in db.execute("SELECT rowid, vectors FROM vectors_vec_vector_chunks00"):
        chunk_blobs[row[0]] = np.frombuffer(row[1], dtype=np.float32).reshape(-1, DIMS)

    db.close()

    paper_vecs: dict[str, list[np.ndarray]] = {}
    for hash_seq, (chunk_id, chunk_offset) in hash_seq_to_rowinfo.items():
        h = hash_seq.rsplit("_", 1)[0]
        path = hash_to_path.get(h)
        if not path:
            continue
        paper_vecs.setdefault(path, []).append(chunk_blobs[chunk_id][chunk_offset])

    paper_emb: dict[str, np.ndarray] = {}
    for path, vecs in paper_vecs.items():
        avg = np.mean(vecs, axis=0)
        norm = np.linalg.norm(avg)
        if norm > 0:
            paper_emb[path] = avg / norm
    return paper_emb


def normalize_name(name: str) -> str:
    """QMD normalizes: lowercase, underscores->hyphens, collapse separators."""
    n = name.lower().replace("_-_", "-").replace("_", "-")
    while "--" in n:
        n = n.replace("--", "-")
    return n


def build_vault_file_map(vault_dir: Path) -> dict[str, str]:
    m: dict[str, str] = {}
    for f in vault_dir.iterdir():
        if f.suffix == ".md" and not f.name.startswith("_"):
            m[normalize_name(f.name)] = f.name
    return m


def build_embeddings_by_filename(
    paper_emb: dict[str, np.ndarray], vault_map: dict[str, str]
) -> dict[str, np.ndarray]:
    out: dict[str, np.ndarray] = {}
    for qmd_path, vec in paper_emb.items():
        fname = vault_map.get(normalize_name(qmd_path))
        if fname:
            out[fname] = vec
    return out


def parse_yaml_value(val_str: str):
    val_str = val_str.strip()
    if not val_str or val_str in ("null", "~"):
        return None
    if val_str.startswith("[") and val_str.endswith("]"):
        inner = val_str[1:-1]
        if not inner.strip():
            return []
        items = [x.strip().strip('"').strip("'") for x in inner.split(",")]
        return [x for x in items if x]
    return val_str.strip('"').strip("'")


def parse_frontmatter(path: Path) -> dict:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}
    fm = {}
    current_key = None
    for line in m.group(1).splitlines():
        if re.match(r"^\s+-\s", line):
            if current_key is not None:
                val = line.strip().lstrip("- ").strip().strip('"')
                if isinstance(fm.get(current_key), list):
                    fm[current_key].append(val)
                else:
                    fm[current_key] = [val]
            continue
        if ":" not in line:
            continue
        key, _, raw_val = line.partition(":")
        key = key.strip().lower()
        raw_val = raw_val.strip()
        parsed = parse_yaml_value(raw_val)
        if isinstance(parsed, list):
            fm[key] = parsed
        elif parsed is None:
            fm[key] = []
        else:
            fm[key] = parsed
        current_key = key
    return fm


def first_author(fm: dict) -> str:
    authors = fm.get("authors")
    if isinstance(authors, list) and authors:
        name = authors[0].strip()
    elif isinstance(authors, str) and authors:
        name = authors.split(",")[0].strip()
    else:
        return "?"
    parts = name.rstrip(".").split()
    if not parts:
        return "?"
    last = parts[-1].rstrip(".")
    if len(parts) > 1 and len(last) <= 4 and last.isupper():
        return parts[0]
    return parts[-1]


# Generic biomedical journal abbreviations. Add or replace for your field.
JOURNAL_ABBREVS = {
    "cell metabolism": "Cell Metab",
    "the journal of clinical investigation": "JCI",
    "journal of clinical investigation": "JCI",
    "nature communications": "Nat Commun",
    "nature metabolism": "Nat Metab",
    "cell reports": "Cell Rep",
    "endocrinology": "Endocrinology",
    "scientific reports": "Sci Rep",
    "diabetes": "Diabetes",
    "obesity": "Obesity",
    "molecular metabolism": "Mol Metab",
    "nutrients": "Nutrients",
    "physiology & behavior": "Physiol Behav",
    "annual review of nutrition": "Annu Rev Nutr",
    "proceedings of the national academy of sciences": "PNAS",
    "the journal of neuroscience": "J Neurosci",
    "journal of neuroscience": "J Neurosci",
    "neuropharmacology": "Neuropharmacol",
    "american journal of physiology": "Am J Physiol",
    "metabolism": "Metabolism",
    "plos one": "PLoS ONE",
    "elife": "eLife",
    "nature": "Nature",
    "cell": "Cell",
    "nature medicine": "Nat Med",
    "science": "Science",
    "appetite": "Appetite",
    "chemical senses": "Chem Senses",
    "european journal of neuroscience": "Eur J Neurosci",
    "frontiers in neuroendocrinology": "Front Neuroendocrinol",
    "frontiers in endocrinology": "Front Endocrinol",
    "philosophical transactions": "Phil Trans R Soc B",
}


def short_journal(journal: str) -> str:
    j = journal.lower().strip()
    for long, short in JOURNAL_ABBREVS.items():
        if j.startswith(long):
            return short
    words = journal.split()
    return " ".join(words[:3]) if len(words) > 3 else journal


def get_first_finding(fm: dict) -> str:
    kf = fm.get("key_findings", [])
    if not isinstance(kf, list) or not kf:
        return ""
    finding = kf[0].strip().strip('"')
    if len(finding) > 130:
        finding = finding[:127] + "..."
    return finding


def format_paper_entry(fname: str, fm: dict) -> str:
    pmid = fm.get("pmid") or "—"
    year = fm.get("year") or "?"
    author = first_author(fm)
    journal = short_journal(fm.get("journal") or "") if fm.get("journal") else "?"
    ptype = fm.get("type") or "?"
    finding = get_first_finding(fm)
    stem = fname[:-3] if fname.endswith(".md") else fname
    header = f"**{stem}**"
    meta = f"  PMID {pmid} | {author} {year} | {journal} | {ptype}"
    lines = [header, meta]
    if finding:
        lines.append(f'  "{finding}"')
    return "\n".join(lines)


def sort_key(item):
    fname, fm = item
    year = fm.get("year")
    try:
        yr = int(year) if year else 9999
    except (ValueError, TypeError):
        yr = 9999
    return (yr, fname.lower())


def build_knn_graph(names: list[str], matrix: np.ndarray, k: int) -> ig.Graph:
    """Build a k-NN graph from embedding matrix. Edges weighted by similarity."""
    # Cap k below n_samples so we don't crash if vec0 is unexpectedly sparse
    # (e.g. an embedding wipe leaves only a handful of papers indexed).
    n = len(names)
    if n < 2:
        # No neighbors possible — return a graph with whatever vertices we have
        # but no edges. Caller's downstream Leiden / labeling logic must handle
        # the trivial-cluster case (each vertex in its own community).
        G = ig.Graph(n=n, directed=False)
        G.vs['name'] = names
        return G
    k = min(k, n - 1)
    A = kneighbors_graph(matrix, n_neighbors=k, metric='cosine', mode='distance')
    # Round for determinism — tiny float jitter shifts edge sets between runs.
    A.data = np.round(1.0 - A.data, decimals=6)

    A_sym = A.maximum(A.T)

    sources, targets = A_sym.nonzero()
    weights = [float(A_sym[s, t]) for s, t in zip(sources, targets)]

    G = ig.Graph(n=len(names), edges=list(zip(sources.tolist(), targets.tolist())),
                 directed=False)
    G.es['weight'] = weights
    G.vs['name'] = names

    G.simplify(combine_edges='max')
    return G


def detect_communities(G: ig.Graph, resolution: float, seed: int = 42) -> la.VertexPartition:
    return la.find_partition(
        G, la.RBConfigurationVertexPartition,
        weights='weight', resolution_parameter=resolution, seed=seed
    )


def merge_tiny_communities(partition_membership: list[int], G: ig.Graph, min_size: int = 3) -> list[int]:
    """Merge communities with < min_size members into nearest neighbor community."""
    membership = list(partition_membership)
    community_sizes = defaultdict(int)
    for c in membership:
        community_sizes[c] += 1

    tiny = {c for c, sz in community_sizes.items() if sz < min_size}
    if not tiny:
        return membership

    for v_idx in range(len(membership)):
        if membership[v_idx] not in tiny:
            continue
        neighbor_weight: dict[int, float] = defaultdict(float)
        for e_idx in G.incident(v_idx):
            e = G.es[e_idx]
            neighbor_idx = e.target if e.source == v_idx else e.source
            nc = membership[neighbor_idx]
            if nc not in tiny:
                neighbor_weight[nc] += e['weight']
        if neighbor_weight:
            membership[v_idx] = max(neighbor_weight, key=neighbor_weight.get)

    old_to_new = {}
    for c in membership:
        if c not in old_to_new:
            old_to_new[c] = len(old_to_new)
    return [old_to_new[c] for c in membership]


def compute_soft_membership(
    names: list[str], matrix: np.ndarray, membership: list[int], percentile: float = 80.0,
) -> dict[str, list[int]]:
    """Assign papers to additional communities based on centroid similarity percentiles."""
    n_communities = max(membership) + 1

    community_members: list[list[int]] = [[] for _ in range(n_communities)]
    for i, c in enumerate(membership):
        community_members[c].append(i)

    centroids = np.zeros((n_communities, matrix.shape[1]), dtype=np.float32)
    thresholds = np.zeros(n_communities, dtype=np.float32)

    for c_idx, members in enumerate(community_members):
        if not members:
            continue
        centroid = matrix[members].mean(axis=0)
        norm = np.linalg.norm(centroid)
        if norm > 0:
            centroid /= norm
        centroids[c_idx] = centroid
        member_sims = matrix[members] @ centroid
        thresholds[c_idx] = np.percentile(member_sims, 100 - percentile)

    all_sims = matrix @ centroids.T

    result: dict[str, list[int]] = {}
    for i, name in enumerate(names):
        primary = membership[i]
        secondary = [
            c for c in range(n_communities)
            if c != primary and all_sims[i, c] >= thresholds[c]
        ]
        result[name] = [primary] + secondary

    return result


def find_bridge_papers(G: ig.Graph, membership: list[int], top_n: int = 30) -> list[tuple[str, float, list[int]]]:
    """Find papers with high betweenness centrality (cross-community connectors)."""
    betweenness = G.betweenness(weights='weight')
    max_b = max(betweenness) if betweenness else 1.0
    if max_b == 0:
        max_b = 1.0

    papers = []
    for v_idx in range(G.vcount()):
        name = G.vs[v_idx]['name']
        b = betweenness[v_idx] / max_b

        neighbor_communities = set()
        for e_idx in G.incident(v_idx):
            e = G.es[e_idx]
            neighbor_idx = e.target if e.source == v_idx else e.source
            neighbor_communities.add(membership[neighbor_idx])
        neighbor_communities.discard(membership[v_idx])

        if len(neighbor_communities) >= 1:
            papers.append((name, b, sorted(neighbor_communities)))

    papers.sort(key=lambda x: x[1], reverse=True)
    return papers[:top_n]


def members_hash(member_names: list[str]) -> str:
    return hashlib.sha256("\n".join(sorted(member_names)).encode()).hexdigest()[:16]


def jaccard(set_a: set, set_b: set) -> float:
    if not set_a and not set_b:
        return 1.0
    return len(set_a & set_b) / len(set_a | set_b)


def slugify(name: str) -> str:
    s = name.lower().strip()
    s = re.sub(r'[^a-z0-9\s-]', '', s)
    s = re.sub(r'[\s]+', '-', s)
    s = re.sub(r'-+', '-', s)
    return s.strip('-')


def load_cache() -> dict:
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"version": 1, "communities": {}}


def save_cache(cache: dict):
    CACHE_PATH.write_text(json.dumps(cache, indent=2, sort_keys=False), encoding="utf-8")


def label_community_llm(top_papers: list[dict]) -> dict:
    """Call Claude Sonnet to name and describe a community."""
    paper_lines = "\n".join(
        f"- {p['title']} — {p['first_finding']}" for p in top_papers
    )
    prompt = f"""Name this cluster of related scientific papers.

Papers:
{paper_lines}

Return ONLY valid JSON (no markdown fencing, no explanation):
{{"name": "2-5 word cluster title", "description": "1-2 sentence description of the research theme"}}"""

    result = subprocess.run(
        [CLAUDE_BIN, "-p", "--model", "claude-sonnet-4-6"],
        input=prompt, capture_output=True, text=True, timeout=60,
    )

    if result.returncode != 0:
        print(f"  WARNING: claude -p failed: {result.stderr[:200]}", file=sys.stderr)
        return {"name": "Unlabeled Cluster", "description": ""}

    output = result.stdout.strip()
    output = re.sub(r'^```(?:json)?\s*', '', output)
    output = re.sub(r'\s*```$', '', output)

    try:
        return json.loads(output)
    except json.JSONDecodeError:
        print(f"  WARNING: could not parse LLM output: {output[:200]}", file=sys.stderr)
        return {"name": "Unlabeled Cluster", "description": output[:200]}


def label_communities(
    names: list[str], membership: list[int], G: ig.Graph, vault_dir: Path,
    force_relabel: bool = False, dry_run: bool = False,
) -> dict[int, dict]:
    """Label each community. Returns {community_idx: {name, description, slug}}."""
    n_communities = max(membership) + 1
    cache = load_cache()
    cached_communities = cache.get("communities", {})

    community_members: dict[int, list[str]] = defaultdict(list)
    for i, c in enumerate(membership):
        community_members[c].append(names[i])

    labels: dict[int, dict] = {}

    for c_idx in range(n_communities):
        members = community_members.get(c_idx, [])
        if not members:
            continue

        m_hash = members_hash(members)

        if not force_relabel:
            for cached_key, cached in cached_communities.items():
                if cached.get("members_hash") == m_hash:
                    labels[c_idx] = {
                        "name": cached["name"],
                        "description": cached["description"],
                        "slug": cached["slug"],
                    }
                    print(f"  Community {c_idx} ({len(members)} papers): cached as '{cached['name']}'", file=sys.stderr)
                    break
                old_members = set(cached.get("member_names", []))
                if old_members and jaccard(old_members, set(members)) >= 0.9:
                    labels[c_idx] = {
                        "name": cached["name"],
                        "description": cached["description"],
                        "slug": cached["slug"],
                    }
                    print(f"  Community {c_idx} ({len(members)} papers): Jaccard>=0.9, reusing '{cached['name']}'", file=sys.stderr)
                    break

        if c_idx in labels:
            continue

        subgraph_nodes = [i for i, c in enumerate(membership) if c == c_idx]
        subgraph = G.subgraph(subgraph_nodes)
        degree_cent = subgraph.strength(weights='weight')
        ranked = sorted(zip(degree_cent, range(len(subgraph_nodes))), reverse=True)
        top_indices = [subgraph_nodes[r[1]] for r in ranked[:10]]

        top_papers = []
        for idx in top_indices:
            fname = names[idx]
            fm = parse_frontmatter(vault_dir / fname)
            top_papers.append({
                "title": fm.get("title", fname),
                "first_finding": get_first_finding(fm) or "(no findings recorded)",
            })

        if dry_run:
            print(f"  Community {c_idx} ({len(members)} papers): WOULD LABEL from:", file=sys.stderr)
            for p in top_papers[:5]:
                print(f"    - {p['title'][:80]}", file=sys.stderr)
            labels[c_idx] = {
                "name": f"Community {c_idx}",
                "description": f"Unlabeled community with {len(members)} papers",
                "slug": f"community-{c_idx}",
            }
        else:
            print(f"  Community {c_idx} ({len(members)} papers): labeling via LLM...", file=sys.stderr)
            result = label_community_llm(top_papers)
            slug = slugify(result["name"])
            if not slug:
                slug = f"community-{c_idx}"
            labels[c_idx] = {
                "name": result["name"],
                "description": result.get("description", ""),
                "slug": slug,
            }
            print(f"    → '{result['name']}'", file=sys.stderr)

    seen_slugs: dict[str, int] = {}
    for c_idx, info in labels.items():
        slug = info["slug"]
        if slug in seen_slugs:
            info["slug"] = f"{slug}-{c_idx}"
        seen_slugs[slug] = c_idx

    if not dry_run:
        new_cache = {"version": 1, "params": {}, "generated": datetime.now().isoformat(), "communities": {}}
        for c_idx, info in labels.items():
            members = community_members.get(c_idx, [])
            new_cache["communities"][str(c_idx)] = {
                "name": info["name"],
                "description": info["description"],
                "slug": info["slug"],
                "members_hash": members_hash(members),
                "member_names": sorted(members),
                "member_count": len(members),
                "label_date": datetime.now().strftime("%Y-%m-%d"),
            }
        save_cache(new_cache)
        print(f"  Cache saved to {CACHE_PATH.name}", file=sys.stderr)

    return labels


def compute_related_communities(G: ig.Graph, membership: list[int], top_n: int = 4) -> dict[int, list[int]]:
    """For each community, find top-N most connected communities by edge density."""
    n_communities = max(membership) + 1
    cross_weight: dict[tuple[int, int], float] = defaultdict(float)

    for e in G.es:
        c_s = membership[e.source]
        c_t = membership[e.target]
        if c_s != c_t:
            pair = (min(c_s, c_t), max(c_s, c_t))
            cross_weight[pair] += e['weight']

    related: dict[int, list[int]] = {}
    for c_idx in range(n_communities):
        neighbors = []
        for (a, b), w in cross_weight.items():
            if a == c_idx:
                neighbors.append((w, b))
            elif b == c_idx:
                neighbors.append((w, a))
        neighbors.sort(reverse=True)
        related[c_idx] = [n[1] for n in neighbors[:top_n]]

    return related


def generate_topic_content(
    slug: str, label: dict,
    primary_papers: list[tuple[str, dict]], secondary_papers: list[tuple[str, dict]],
    related_slugs: list[tuple[str, str]], resolution: float,
) -> str:
    now = datetime.now().strftime("%Y-%m-%d")
    total = len(primary_papers) + len(secondary_papers)
    sorted_primary = sorted(primary_papers, key=sort_key)
    sorted_secondary = sorted(secondary_papers, key=sort_key)

    lines = [
        f"# Topic: {label['name']}",
        f"Generated: {now} | Papers: {total} (core: {len(sorted_primary)}, related: {len(sorted_secondary)})",
        "",
        label['description'],
        "",
        f"Papers assigned by graph community detection (Leiden, resolution={resolution}).",
        "Papers may appear in multiple topic files — this is intentional.",
        "For each paper: filename, PMID, first author, year, journal, type, first key finding.",
        "",
        "---",
        "",
        "## Core papers",
        "",
    ]

    for fname, fm in sorted_primary:
        lines.append(format_paper_entry(fname, fm))
        lines.append("")

    if sorted_secondary:
        lines.append("---")
        lines.append("")
        lines.append("## Related papers")
        lines.append("")
        for fname, fm in sorted_secondary:
            lines.append(format_paper_entry(fname, fm))
            lines.append("")

    if related_slugs:
        lines.append("---")
        lines.append("")
        lines.append("## Related clusters")
        for rel_slug, rel_name in related_slugs:
            lines.append(f"- `_topic-{rel_slug}.md` — {rel_name}")
        lines.append("")

    return "\n".join(lines)


def generate_bridges_content(
    bridges: list[tuple[str, float, list[int]]], labels: dict[int, dict], vault_dir: Path,
) -> str:
    now = datetime.now().strftime("%Y-%m-%d")
    lines = [
        "# Bridge Papers: Cross-Topic Connectors",
        f"Generated: {now} | Papers: {len(bridges)}",
        "",
        "Papers with high betweenness centrality in the paper similarity graph.",
        "These connect otherwise separate research areas.",
        "",
        "---",
        "",
    ]

    for fname, betweenness, bridged_communities in bridges:
        fm = parse_frontmatter(vault_dir / fname)
        entry = format_paper_entry(fname, fm)
        community_names = []
        for c in bridged_communities:
            if c in labels:
                community_names.append(f"_topic-{labels[c]['slug']}.md")
        bridges_str = ", ".join(community_names[:4]) if community_names else "multiple communities"
        lines.append(entry)
        lines.append(f"  Bridges: {bridges_str} (betweenness: {betweenness:.4f})")
        lines.append("")

    return "\n".join(lines)


def generate_other_content(papers_without_embeddings: list[tuple[str, dict]]) -> str:
    now = datetime.now().strftime("%Y-%m-%d")
    sorted_papers = sorted(papers_without_embeddings, key=sort_key)

    lines = [
        "# Topic: Awaiting Embedding",
        f"Generated: {now} | Papers: {len(sorted_papers)}",
        "",
        "Papers not yet indexed in QMD (no embedding vectors available).",
        "These will be assigned to topic clusters after the next embedding run.",
        "",
        "---",
        "",
    ]

    for fname, fm in sorted_papers:
        lines.append(format_paper_entry(fname, fm))
        lines.append("")

    return "\n".join(lines)


def cmd_diagnose(args, names, matrix, emb):
    t0 = time.time()
    print(f"Building k-NN graph (k={args.k})...", file=sys.stderr)
    G = build_knn_graph(names, matrix, k=args.k)
    print(f"  Nodes: {G.vcount()}, Edges: {G.ecount()}", file=sys.stderr)

    weights = G.es['weight']
    print(f"  Edge weights: min={min(weights):.3f}, median={np.median(weights):.3f}, "
          f"mean={np.mean(weights):.3f}, max={max(weights):.3f}", file=sys.stderr)

    if args.sweep:
        print("\n=== Resolution sweep ===", file=sys.stderr)
        for r in [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 7.0, 10.0]:
            partition = detect_communities(G, resolution=r, seed=args.seed)
            n_comm = len(set(partition.membership))
            mod = partition.modularity
            sizes = sorted([partition.membership.count(c) for c in set(partition.membership)], reverse=True)
            top3 = ", ".join(str(s) for s in sizes[:3])
            print(f"  res={r:<5.1f}: {n_comm:3d} communities, modularity={mod:.4f}, "
                  f"largest: [{top3}]", file=sys.stderr)
        return G, None, None

    print(f"\nRunning Leiden at resolution={args.resolution}...", file=sys.stderr)
    partition = detect_communities(G, resolution=args.resolution, seed=args.seed)
    membership = merge_tiny_communities(partition.membership, G, min_size=args.min_community)
    n_communities = max(membership) + 1

    print(f"  Communities: {n_communities} (after merging <{args.min_community})", file=sys.stderr)

    sizes = defaultdict(int)
    for c in membership:
        sizes[c] += 1
    size_list = sorted(sizes.values(), reverse=True)
    print(f"  Sizes: min={min(size_list)}, median={int(np.median(size_list))}, "
          f"max={max(size_list)}, mean={np.mean(size_list):.1f}", file=sys.stderr)

    soft = compute_soft_membership(names, matrix, membership, percentile=args.percentile)
    membership_counts = defaultdict(int)
    for paper_communities in soft.values():
        membership_counts[len(paper_communities)] += 1
    print(f"\n=== Soft membership (percentile={args.percentile}) ===", file=sys.stderr)
    for n_topics in sorted(membership_counts):
        count = membership_counts[n_topics]
        pct = 100 * count / len(names)
        print(f"  Papers in {n_topics} topic(s): {count} ({pct:.1f}%)", file=sys.stderr)

    elapsed = time.time() - t0
    print(f"\nElapsed: {elapsed:.1f}s", file=sys.stderr)

    return G, membership, soft


def cmd_label(args, names, matrix, emb, G, membership):
    return label_communities(
        names, membership, G, VAULT_DIR,
        force_relabel=args.force_relabel,
        dry_run=args.dry_run,
    )


def cmd_generate(args, names, matrix, emb, G, membership, soft, labels):
    n_communities = max(membership) + 1

    primary_members: dict[int, list[str]] = defaultdict(list)
    secondary_members: dict[int, list[str]] = defaultdict(list)
    for paper_name, communities in soft.items():
        if communities:
            primary_members[communities[0]].append(paper_name)
            for c in communities[1:]:
                secondary_members[c].append(paper_name)

    paper_fm: dict[str, dict] = {}
    for fname in names:
        paper_fm[fname] = parse_frontmatter(VAULT_DIR / fname)

    all_vault_papers = set()
    for md in VAULT_DIR.glob("*.md"):
        if not md.name.startswith("_"):
            all_vault_papers.add(md.name)
    embedded_papers = set(names)
    unembedded = all_vault_papers - embedded_papers

    related = compute_related_communities(G, membership)

    active_slugs = set()
    files_written = 0

    NAV_DIR.mkdir(parents=True, exist_ok=True)

    for c_idx in range(n_communities):
        if c_idx not in labels:
            continue
        label = labels[c_idx]
        slug = label["slug"]
        active_slugs.add(slug)

        p_members = primary_members.get(c_idx, [])
        s_members = secondary_members.get(c_idx, [])
        p_papers = [(fname, paper_fm.get(fname, {})) for fname in p_members]
        s_papers = [(fname, paper_fm.get(fname, {})) for fname in s_members]

        related_slugs = []
        for rel_c in related.get(c_idx, []):
            if rel_c in labels:
                related_slugs.append((labels[rel_c]["slug"], labels[rel_c]["name"]))

        content = generate_topic_content(slug, label, p_papers, s_papers, related_slugs, args.resolution)

        total = len(p_members) + len(s_members)
        out_path = NAV_DIR / f"_topic-{slug}.md"
        if args.dry_run:
            print(f"  WOULD WRITE: {out_path.name} (core: {len(p_members)}, related: {len(s_members)}, total: {total})",
                  file=sys.stderr)
        else:
            out_path.write_text(content, encoding="utf-8")
            print(f"  Written: {out_path.name} (core: {len(p_members)}, related: {len(s_members)})", file=sys.stderr)
            files_written += 1

    bridges = find_bridge_papers(G, membership, top_n=args.bridge_count)
    bridge_content = generate_bridges_content(bridges, labels, VAULT_DIR)
    bridge_path = NAV_DIR / "_topic-bridges.md"
    active_slugs.add("bridges")

    if args.dry_run:
        print(f"  WOULD WRITE: {bridge_path.name} ({len(bridges)} papers)", file=sys.stderr)
    else:
        bridge_path.write_text(bridge_content, encoding="utf-8")
        print(f"  Written: {bridge_path.name} ({len(bridges)} papers)", file=sys.stderr)
        files_written += 1

    if unembedded:
        other_papers = []
        for fname in sorted(unembedded):
            fm = parse_frontmatter(VAULT_DIR / fname)
            other_papers.append((fname, fm))
        other_content = generate_other_content(other_papers)
        other_path = NAV_DIR / "_topic-other.md"
        active_slugs.add("other")

        if args.dry_run:
            print(f"  WOULD WRITE: {other_path.name} ({len(unembedded)} papers awaiting embedding)",
                  file=sys.stderr)
        else:
            other_path.write_text(other_content, encoding="utf-8")
            print(f"  Written: {other_path.name} ({len(unembedded)} papers awaiting embedding)",
                  file=sys.stderr)
            files_written += 1

    for old_topic in NAV_DIR.glob("_topic-*.md"):
        slug = old_topic.stem.replace("_topic-", "")
        if slug not in active_slugs:
            if args.dry_run:
                print(f"  WOULD REMOVE: {old_topic.name} (stale)", file=sys.stderr)
            else:
                old_topic.unlink()
                print(f"  Removed: {old_topic.name} (stale)", file=sys.stderr)

    if not args.dry_run:
        print(f"\nDone. {files_written} topic files written.", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Graph-based community detection for the vault.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = ap.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--k", type=int, default=15, help="k-NN neighbors (default: 15)")
    common.add_argument("--resolution", type=float, default=2.5,
                        help="Leiden resolution parameter (default: 2.5)")
    common.add_argument("--percentile", type=float, default=80.0,
                        help="Soft membership percentile threshold (default: 80)")
    common.add_argument("--min-community", type=int, default=3,
                        help="Merge communities smaller than N (default: 3)")
    common.add_argument("--seed", type=int, default=42, help="Random seed (default: 42)")
    common.add_argument("--dry-run", action="store_true", help="No file writes")

    p_diag = sub.add_parser("diagnose", parents=[common], help="Print community stats")
    p_diag.add_argument("--sweep", action="store_true", help="Sweep resolution values")

    p_label = sub.add_parser("label", parents=[common], help="Label communities via LLM")
    p_label.add_argument("--force-relabel", action="store_true", help="Relabel all, ignore cache")

    p_gen = sub.add_parser("generate", parents=[common], help="Write _topic-*.md files")
    p_gen.add_argument("--bridge-count", type=int, default=30, help="Bridge papers (default: 30)")
    p_gen.add_argument("--force-relabel", action="store_true", help="Relabel all, ignore cache")

    p_full = sub.add_parser("full-run", parents=[common], help="Diagnose + label + generate")
    p_full.add_argument("--bridge-count", type=int, default=30, help="Bridge papers (default: 30)")
    p_full.add_argument("--force-relabel", action="store_true", help="Relabel all, ignore cache")

    args = ap.parse_args()

    print(f"Loading embeddings from {QMD_INDEX}...", file=sys.stderr)
    paper_emb = load_embeddings(QMD_INDEX)
    vault_map = build_vault_file_map(VAULT_DIR)
    emb = build_embeddings_by_filename(paper_emb, vault_map)
    names = sorted(emb.keys())
    if not names:
        print("ERROR: no embeddings found. Has the vault been embedded yet?", file=sys.stderr)
        return 1
    matrix = np.stack([emb[f] for f in names])
    print(f"  Papers with embeddings: {len(names)}", file=sys.stderr)

    if args.command == "diagnose":
        cmd_diagnose(args, names, matrix, emb)
        return 0

    print(f"Building k-NN graph (k={args.k})...", file=sys.stderr)
    G = build_knn_graph(names, matrix, k=args.k)
    print(f"  Nodes: {G.vcount()}, Edges: {G.ecount()}", file=sys.stderr)

    print(f"Running Leiden (resolution={args.resolution})...", file=sys.stderr)
    partition = detect_communities(G, resolution=args.resolution, seed=args.seed)
    membership = merge_tiny_communities(partition.membership, G, min_size=args.min_community)
    n_communities = max(membership) + 1
    print(f"  Communities: {n_communities}", file=sys.stderr)

    soft = compute_soft_membership(names, matrix, membership, percentile=args.percentile)

    if args.command == "label":
        cmd_label(args, names, matrix, emb, G, membership)
    elif args.command == "generate":
        labels = cmd_label(args, names, matrix, emb, G, membership)
        cmd_generate(args, names, matrix, emb, G, membership, soft, labels)
    elif args.command == "full-run":
        labels = cmd_label(args, names, matrix, emb, G, membership)
        cmd_generate(args, names, matrix, emb, G, membership, soft, labels)

    return 0


if __name__ == "__main__":
    sys.exit(main())
