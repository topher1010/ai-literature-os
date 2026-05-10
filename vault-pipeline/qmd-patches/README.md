# QMD patches

Two patches against [QMD](https://github.com/tobi/qmd) at commit `96634da`. Required for the vault pipeline.

## What the patches do

### `llm.ts.patched` — OpenRouter transport with fail-loud

Routes embeddings through OpenRouter's OpenAI-compatible API (`OPENAI_BASE_URL=https://openrouter.ai/api/v1`) instead of the local GGUF embeddinggemma model QMD ships with.

- Real production embedding model (default `google/gemini-embedding-2-preview`, 3072-dim).
- Outages **fail loudly** instead of silently falling back to the local model. Earlier silent-fallback behavior corrupted the vector space — vectors from the wrong model give nonsense neighbors.

### `store.ts.patched` — vec0 UNIQUE handling + refuse-DROP-on-dim-mismatch

Two related fixes in the same file.

**UNIQUE handling.** QMD's original `insertEmbedding` caught any exception whose message contained `UNIQUE` and treated it as "chunk already embedded, skip silently." That swallowed any vec0 error mentioning "unique" — dimension mismatches, marshaling failures, extension-load issues. `content_vectors` advanced via `INSERT OR REPLACE` while `vectors_vec` stayed empty; `vsearch` silently broke while OpenRouter kept billing.

The patch narrows the catch to the actual UNIQUE-constraint code path on the only INSERT in that try block (the vec0 insert) and lets other errors propagate. The regex matches all sqlite-vec versions (older: `hash_seq`; newer: `vectors_vec primary key`).

**Refuse-DROP-on-dim-mismatch.** The patch also refuses to silently drop a populated `vectors_vec` table when the existing schema's dimension doesn't match the incoming embedding's dimension. Legitimate model migrations require `QMD_ALLOW_VEC_RECREATE=1`. Without this guard, a single off-dimension embedding (for example, a bare `qmd embed` falling back to a smaller default model when the wrapper isn't sourced) silently wipes the vector store while leaving `content_vectors` intact — invisible until a downstream tool queries vec0.

## How to apply

QMD is a single-file Bun script. The patches replace the corresponding upstream files entirely.

```bash
# Pin QMD at the commit these patches are tested against
git clone https://github.com/tobi/qmd.git ~/code/qmd
cd ~/code/qmd
git checkout 96634da

# Drop in the patched files
cp /path/to/ai-literature-os/vault-pipeline/qmd-patches/llm.ts.patched src/llm.ts
cp /path/to/ai-literature-os/vault-pipeline/qmd-patches/store.ts.patched src/store.ts

# Build / install via Bun (see QMD's own README)
bun install
bun link
```

Verify with `qmd --version` and a small `qmd embed` against a test directory.

## When to re-apply

After any `bun update -g qmd` or any QMD source pull. The patches do not survive upstream upgrades — keep your patched copies (this directory) so you can re-apply them.

## Upstream status

Both patches are local. Upstream issue tracker: https://github.com/tobi/qmd/issues — search for OpenRouter / OpenAI-compatible embedding transport, and for the vec0 UNIQUE catch behavior ([tobi/qmd#558](https://github.com/tobi/qmd/issues/558)).

If you upgrade QMD past `96634da` without re-applying these patches, `embed` will silently use the local model and `vsearch` will silently break on certain error paths — the pipeline will lie about working.
