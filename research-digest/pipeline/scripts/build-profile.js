#!/usr/bin/env node
/**
 * build-profile.js — Build the research-profile embedding from seed papers.
 *
 * Fetches abstracts for the seed PMIDs in data/seed-pmids.json, embeds them via
 * the configured embedding model (default: google/gemini-embedding-2-preview via
 * OpenRouter), and writes mean-vector profiles for three sub-profiles:
 * Core, Methods, Adjacent. Used by the scoring pipeline to rank candidate papers.
 *
 * Output: embeddings/profile.json
 *
 * Required env: OPENROUTER_API_KEY.
 *
 * Usage: node build-profile.js
 *
 * Bootstrap your own profile by editing data/seed-pmids.example.json:
 * pick 50-100 representative papers from your field across the three buckets,
 * rename to data/seed-pmids.json (gitignored), then run this script.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SEED_FILE   = path.resolve(__dirname, '../data/seed-pmids.json');
const OUTPUT_DIR  = path.resolve(__dirname, '../embeddings');
const OUTPUT_FILE = path.resolve(OUTPUT_DIR, 'profile.json');

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const EMBED_MODEL = process.env.DIGEST_EMBED_MODEL || 'google/gemini-embedding-2-preview';
const EMBED_DIM   = parseInt(process.env.EMBEDDING_DIMS || '3072', 10);
const USER_AGENT  = process.env.DIGEST_USER_AGENT || 'ai-literature-os-digest/1.0';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function post(hostname, path, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    };
    const req = https.request(options, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch { resolve(out); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); res.on('error', reject);
    }).on('error', reject);
  });
}

// ── PubMed fetch ──────────────────────────────────────────────────────────────

function parsePubMedXML(xml) {
  const results = {};
  const articles = [...xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)];
  for (const match of articles) {
    const block = match[1];
    const pmid = block.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
    if (!pmid) continue;

    const title = block.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/)?.[1]
      ?.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim() || '';

    const abstractBlocks = [...block.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)];
    const abstract = abstractBlocks.map(m => m[1].replace(/<[^>]+>/g, '').trim()).join(' ');

    results[pmid] = { title, abstract };
  }
  return results;
}

async function fetchAbstracts(pmids) {
  const results = {};
  const BATCH = 200; // PubMed efetch limit
  for (let i = 0; i < pmids.length; i += BATCH) {
    const batch = pmids.slice(i, i + BATCH);
    console.log(`  Fetching PubMed batch ${Math.floor(i/BATCH)+1}: ${batch.length} PMIDs...`);
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${batch.join(',')}&retmode=xml`;
    const xml = await fetchUrl(url);
    const parsed = parsePubMedXML(xml);
    Object.assign(results, parsed);
    await sleep(400); // NCBI rate limit
  }
  return results;
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
  // OpenRouter routing to the configured embedding model.
  // Retries on 429/5xx/network errors.
  const MAX_ATTEMPTS = 5;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await post(
        'openrouter.ai',
        '/api/v1/embeddings',
        { model: EMBED_MODEL, input: texts },
        { 'Authorization': `Bearer ${OPENROUTER_KEY}` }
      );
    } catch (netErr) {
      lastErr = netErr;
      if (attempt === MAX_ATTEMPTS) break;
      const waitSec = Math.min(30, 2 ** attempt);
      console.warn(`  [embed] network error (attempt ${attempt}/${MAX_ATTEMPTS}): ${netErr.message}. Retry in ${waitSec}s.`);
      await sleep(waitSec * 1000);
      continue;
    }

    if (!response.error) return response.data.map(d => d.embedding);

    const code = response.error.code;
    lastErr = new Error(`Embed error: ${JSON.stringify(response.error)}`);

    if (code === 429) {
      const hinted = parseRetryDelay(response);
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
    // 4xx other than 429 — unrecoverable.
    throw lastErr;
  }
  throw lastErr;
}

async function embedBatched(texts, batchSize = 10) {
  const all = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    process.stdout.write(`  Embedding ${i+1}–${Math.min(i+batchSize, texts.length)} of ${texts.length}...`);
    const vecs = await embedTexts(batch);
    all.push(...vecs);
    process.stdout.write(` ✓\n`);
    if (i + batchSize < texts.length) await sleep(500); // avoid rate limiting
  }
  return all;
}

// ── Vector math ───────────────────────────────────────────────────────────────

function meanVector(vecs) {
  if (!vecs.length) return [];
  const dim = vecs[0].length;
  const mean = new Array(dim).fill(0);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) mean[i] += v[i];
  }
  for (let i = 0; i < dim; i++) mean[i] /= vecs.length;
  return mean;
}

function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!OPENROUTER_KEY) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }
  if (!fs.existsSync(SEED_FILE)) {
    console.error(`Seed file not found: ${SEED_FILE}`);
    console.error(`Copy data/seed-pmids.example.json to data/seed-pmids.json and edit for your field.`);
    process.exit(1);
  }

  const seeds = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const allPmids = [...seeds.core, ...seeds.methods, ...seeds.adjacent];
  console.log(`Seed PMIDs: ${allPmids.length} (Core: ${seeds.core.length}, Methods: ${seeds.methods.length}, Adjacent: ${seeds.adjacent.length})`);

  let existing = {};
  const ABSTRACTS_CACHE = path.resolve(OUTPUT_DIR, 'abstracts-cache.json');
  if (fs.existsSync(ABSTRACTS_CACHE)) {
    existing = JSON.parse(fs.readFileSync(ABSTRACTS_CACHE, 'utf8'));
    console.log(`Loaded ${Object.keys(existing).length} cached abstracts`);
  }

  const missing = allPmids.filter(id => !existing[id]);
  if (missing.length) {
    console.log(`\nFetching ${missing.length} abstracts from PubMed...`);
    const fetched = await fetchAbstracts(missing);
    Object.assign(existing, fetched);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(ABSTRACTS_CACHE, JSON.stringify(existing, null, 2));
    console.log(`  Total cached: ${Object.keys(existing).length}`);
  }

  const makeText = (pmid) => {
    const p = existing[pmid];
    if (!p) return null;
    const text = `${p.title}\n\n${p.abstract}`.trim();
    return text.length > 50 ? text : null;
  };

  console.log('\nEmbedding Core papers...');
  const coreTexts = seeds.core.map(makeText).filter(Boolean);
  const coreVecs  = await embedBatched(coreTexts, 20);

  console.log('\nEmbedding Methods papers...');
  const methodsTexts = seeds.methods.map(makeText).filter(Boolean);
  const methodsVecs  = await embedBatched(methodsTexts, 20);

  console.log('\nEmbedding Adjacent papers...');
  const adjTexts = seeds.adjacent.map(makeText).filter(Boolean);
  const adjVecs  = await embedBatched(adjTexts, 20);

  const profile = {
    built: new Date().toISOString(),
    model: EMBED_MODEL,
    dim: EMBED_DIM,
    counts: { core: coreVecs.length, methods: methodsVecs.length, adjacent: adjVecs.length },
    vectors: {
      core:     meanVector(coreVecs),
      methods:  meanVector(methodsVecs),
      adjacent: meanVector(adjVecs),
    },
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(profile, null, 2));
  console.log(`\nProfile saved to ${OUTPUT_FILE}`);
  console.log(`Vectors: Core(${coreVecs.length}) Methods(${methodsVecs.length}) Adjacent(${adjVecs.length})`);

  console.log('\nSanity check (should be ~1.0):');
  console.log(`  Core·Core:     ${cosineSim(profile.vectors.core, profile.vectors.core).toFixed(4)}`);
  console.log(`  Methods·Methods: ${cosineSim(profile.vectors.methods, profile.vectors.methods).toFixed(4)}`);

  console.log('\nCross-profile similarity (should be < 1.0):');
  console.log(`  Core·Methods:  ${cosineSim(profile.vectors.core, profile.vectors.methods).toFixed(4)}`);
  console.log(`  Core·Adjacent: ${cosineSim(profile.vectors.core, profile.vectors.adjacent).toFixed(4)}`);
  console.log(`  Methods·Adjacent: ${cosineSim(profile.vectors.methods, profile.vectors.adjacent).toFixed(4)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
