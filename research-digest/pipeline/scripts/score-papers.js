#!/usr/bin/env node
/**
 * score-papers.js — Embedding + ranking; prompt formatting helpers.
 *
 * Handles the embedding + vector-similarity ranking step. LLM scoring and
 * summary generation are done by score-with-claude.js, which spawns Claude
 * subprocess calls for each batch. The prompts themselves live in plain
 * text files under ../prompts/ so users can edit them without touching code.
 *
 * Module exports:
 *   embedAndRank, applyScores, selectPapers, applySummaries,
 *   formatScoringBatch, formatSummaryBatch,
 *   CONFIG, SCORING_PROMPT, SUMMARY_PROMPT
 *
 * CLI (embedding only):
 *   node score-papers.js <papers.json>
 *
 * Required env: OPENROUTER_API_KEY.
 * Required files:
 *   ../embeddings/profile.json    (build via build-profile.js)
 *   ../prompts/scoring-prompt.txt (copy from .example.txt and edit)
 *   ../prompts/summary-prompt.txt (copy from .example.txt and edit)
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const PIPELINE_DIR = path.resolve(__dirname, '..');
const PROFILE_FILE = path.join(PIPELINE_DIR, 'embeddings/profile.json');
const PROMPTS_DIR  = path.join(PIPELINE_DIR, 'prompts');
const EMBED_MODEL  = process.env.DIGEST_EMBED_MODEL || 'google/gemini-embedding-2-preview';

// ── Scoring config ────────────────────────────────────────────────────────────

const CONFIG = {
  embedBatchSize:   20,    // papers per embedding API call
  topByEmbedding:  500,    // max papers passed to LLM after embedding pre-filter
  scoringBatchSize: 15,    // papers per Claude scoring call
  summaryBatchSize: 10,    // papers per summary call
  relevanceThreshold: parseFloat(process.env.DIGEST_RELEVANCE_THRESHOLD || '3.0'),
  wildcardThreshold:  parseFloat(process.env.DIGEST_WILDCARD_THRESHOLD  || '2.5'),
  wildcardSurprise:   parseFloat(process.env.DIGEST_WILDCARD_SURPRISE   || '7.5'),
  wildcardSlots:    parseInt(process.env.DIGEST_WILDCARD_SLOTS || '10', 10),
  combinedWeight: { relevance: 0.7, surprise: 0.3 },
};

// ── Load prompts from text files ──────────────────────────────────────────────
// The user's research-specific scoring + summary prompts live in plain text
// files so they can be edited without touching this script. The repo ships
// .example.txt versions; users copy to .txt (gitignored) and edit.

function loadPrompt(name) {
  const userPath    = path.join(PROMPTS_DIR, `${name}.txt`);
  const examplePath = path.join(PROMPTS_DIR, `${name}.example.txt`);
  if (fs.existsSync(userPath)) {
    return fs.readFileSync(userPath, 'utf8');
  }
  if (fs.existsSync(examplePath)) {
    console.warn(`WARNING: ${name}.txt not found; using ${name}.example.txt. Copy and edit before relying on results.`);
    return fs.readFileSync(examplePath, 'utf8');
  }
  throw new Error(
    `Neither ${userPath} nor ${examplePath} exists. ` +
    `The pipeline can't score papers without a scoring/summary prompt.`
  );
}

const SCORING_PROMPT = loadPrompt('scoring-prompt');
const SUMMARY_PROMPT = loadPrompt('summary-prompt');

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function postJSON(hostname, urlPath, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request(
      { hostname, path: urlPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } },
      res => {
        let out = '';
        res.on('data', c => out += c);
        res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve(out); } });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Vector math ───────────────────────────────────────────────────────────────

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function profileScore(vec, profile) {
  const cs = cosineSim(vec, profile.vectors.core);
  const ms = cosineSim(vec, profile.vectors.methods);
  const as = cosineSim(vec, profile.vectors.adjacent);
  return { core: cs, methods: ms, adjacent: as, combined: 0.5*cs + 0.3*ms + 0.2*as };
}

// ── Embedding ─────────────────────────────────────────────────────────────────

function parseRetryDelay(errBody) {
  const details = errBody?.error?.details;
  if (!Array.isArray(details)) return null;
  const retryInfo = details.find(d => d['@type']?.includes('RetryInfo'));
  const raw = retryInfo?.retryDelay;
  if (!raw) return null;
  const m = raw.match(/^([\d.]+)s$/);
  return m ? Math.ceil(parseFloat(m[1])) : null;
}

async function embedTexts(texts) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');

  const MAX_ATTEMPTS = 5;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await postJSON(
        'openrouter.ai', '/api/v1/embeddings',
        { model: EMBED_MODEL, input: texts },
        { 'Authorization': `Bearer ${key}` }
      );
    } catch (netErr) {
      lastErr = netErr;
      if (attempt === MAX_ATTEMPTS) break;
      const waitSec = Math.min(30, 2 ** attempt);
      console.warn(`  [embed] network error (attempt ${attempt}/${MAX_ATTEMPTS}): ${netErr.message}. Retry in ${waitSec}s.`);
      await sleep(waitSec * 1000);
      continue;
    }

    if (!res.error) return res.data.map(d => d.embedding);

    const code = res.error.code;
    lastErr = new Error(`Embed error: ${JSON.stringify(res.error)}`);

    if (code === 429) {
      const hinted = parseRetryDelay(res);
      const waitSec = hinted ? hinted + 2 : 30 + Math.random() * 5;
      if (attempt === MAX_ATTEMPTS) break;
      console.warn(`  [embed] 429 rate-limited (attempt ${attempt}/${MAX_ATTEMPTS}). Waiting ${waitSec.toFixed(0)}s.`);
      await sleep(waitSec * 1000);
      continue;
    }
    if (typeof code === 'number' && code >= 500 && code < 600) {
      if (attempt === MAX_ATTEMPTS) break;
      const waitSec = Math.min(30, 2 ** attempt);
      console.warn(`  [embed] 5xx (attempt ${attempt}/${MAX_ATTEMPTS}) code=${code}. Retry in ${waitSec}s.`);
      await sleep(waitSec * 1000);
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

async function embedPapers(papers, log = console.log) {
  const texts = papers.map(p => `${p.title}\n\n${p.abstract || ''}`.trim().slice(0, 2000));
  const vecs = [];
  const bsz = CONFIG.embedBatchSize;
  for (let i = 0; i < texts.length; i += bsz) {
    const batch = texts.slice(i, i + bsz);
    log(`  Embedding ${i+1}-${Math.min(i+bsz, texts.length)} of ${texts.length}...`);
    const bvecs = await embedTexts(batch);
    vecs.push(...bvecs);
    if (i + bsz < texts.length) await sleep(300);
  }
  return vecs;
}

// ── embedAndRank: Step 1+2 (no LLM) ──────────────────────────────────────────

async function embedAndRank(papers, opts = {}) {
  const log = opts.log || console.log;
  if (!fs.existsSync(PROFILE_FILE)) {
    throw new Error(`Profile not found at ${PROFILE_FILE}. Run build-profile.js first.`);
  }
  const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));

  log(`\nEmbedding and ranking ${papers.length} papers...`);

  const scoreable = papers.filter(p => (p.title || '').length > 10);
  log(`  Scoreable: ${scoreable.length}`);

  log('\nStep 1: Embedding papers...');
  const vecs = await embedPapers(scoreable, log);

  log('\nStep 2: Profile similarity scoring...');
  const withSim = scoreable.map((p, i) => {
    const sim = profileScore(vecs[i], profile);
    return { ...p, embeddingScores: sim, embeddingCombined: sim.combined };
  });

  withSim.sort((a, b) => b.embeddingCombined - a.embeddingCombined);
  const topPapers = withSim.slice(0, CONFIG.topByEmbedding);
  const skipped = withSim.slice(CONFIG.topByEmbedding);

  log(`  Top ${topPapers.length} by embedding (${skipped.length} skipped)`);
  if (topPapers.length > 0) {
    log(`  Embedding score range: ${topPapers[topPapers.length-1].embeddingCombined.toFixed(3)} - ${topPapers[0].embeddingCombined.toFixed(3)}`);
  }

  return { topPapers, skipped };
}

// ── Batch formatting helpers ─────────────────────────────────────────────────

function formatScoringBatch(papers) {
  return papers.map((p, i) =>
    `[${i+1}] ID: ${p.id}\nTitle: ${p.title}\nJournal: ${p.journal || ''}\nAbstract: ${(p.abstract || '(no abstract)').slice(0, 800)}`
  ).join('\n\n---\n\n');
}

function formatSummaryBatch(papers) {
  return papers.map((p, i) =>
    `[${i+1}] ID: ${p.id}\nTitle: ${p.title}\nAbstract: ${(p.abstract || '').slice(0, 800)}`
  ).join('\n\n---\n\n');
}

// ── applyScores: merge LLM scores back into papers ─────────────────────────

function applyScores(papers, scores) {
  return papers.map(p => {
    const s = scores[p.id];
    if (!s) return { ...p, scoringMethod: 'embedding-only' };
    const combined = CONFIG.combinedWeight.relevance * s.relevance + CONFIG.combinedWeight.surprise * s.surprise;
    return {
      ...p,
      sonnetRelevance:  s.relevance,
      sonnetSurprise:   s.surprise,
      sonnetCombined:   parseFloat(combined.toFixed(2)),
      sonnetReason:     s.reason,
      scoringMethod:    'full',
    };
  });
}

// ── selectPapers: threshold + wildcard selection ──────────────────────────────

function selectPapers(scored, log = console.log) {
  log('\nSelecting papers...');

  const mainSelected = scored.filter(p => p.sonnetRelevance >= CONFIG.relevanceThreshold);
  const wildcardPool = scored.filter(p =>
    p.sonnetRelevance >= CONFIG.wildcardThreshold &&
    p.sonnetRelevance <  CONFIG.relevanceThreshold &&
    p.sonnetSurprise  >= CONFIG.wildcardSurprise
  ).sort((a, b) => b.sonnetSurprise - a.sonnetSurprise);
  const wildcards = wildcardPool.slice(0, CONFIG.wildcardSlots);

  log(`  Main (relevance >= ${CONFIG.relevanceThreshold}): ${mainSelected.length}`);
  log(`  Wild cards: ${wildcards.length} (of ${wildcardPool.length} eligible)`);

  const selected = [...mainSelected, ...wildcards];
  selected.sort((a, b) => (b.sonnetCombined || 0) - (a.sonnetCombined || 0));

  for (const p of wildcards) p.isWildcard = true;

  for (const p of selected) {
    const c = p.sonnetCombined || 0;
    if (c >= 6.0)      p.relevance = 'high';
    else if (c >= 4.5) p.relevance = 'medium';
    else               p.relevance = 'low';
    p.relevanceScore = p.sonnetCombined || p.relevanceScore;
  }

  return { selected, mainCount: mainSelected.length, wildcardCount: wildcards.length };
}

function applySummaries(papers, summaries) {
  for (const p of papers) {
    if (summaries[p.id]) {
      p.aiSummary    = summaries[p.id].summary;
      p.whyItMatters = summaries[p.id].whyItMatters;
    }
  }
  return papers;
}

// ── CLI entry point (embedding only) ──────────────────────────────────────────

if (require.main === module) {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('Usage: node score-papers.js <papers.json>');
    console.error('This runs embedding + ranking only. LLM scoring is done by score-with-claude.js.');
    process.exit(1);
  }
  const papers = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const arr = Array.isArray(papers) ? papers : papers.papers;

  const runCtx = require('./digest-run');
  embedAndRank(arr)
    .then(({ topPapers }) => {
      const outFile = path.join(runCtx.getRunDir(), 'embedded-papers.json');
      fs.writeFileSync(outFile, JSON.stringify(topPapers, null, 2));
      console.log(`\nWrote ${topPapers.length} embedding-ranked papers to ${outFile}`);
    })
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
  embedAndRank,
  applyScores,
  selectPapers,
  applySummaries,
  formatScoringBatch,
  formatSummaryBatch,
  CONFIG,
  SCORING_PROMPT,
  SUMMARY_PROMPT,
};
