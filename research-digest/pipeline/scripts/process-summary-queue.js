#!/usr/bin/env node
/**
 * process-summary-queue.js - Process full-text summary requests from Supabase.
 *
 * Reads the `papers` table for rows with status 'summary_pending' or
 * 'summary_deferred' (with expired backoff). For each, attempts full-text
 * retrieval via PMC -> Europe PMC -> Unpaywall -> bioRxiv JATS, then generates
 * a structured summary via Claude Sonnet and writes it back to Supabase.
 *
 * Usage:
 *   node process-summary-queue.js [--dry-run]
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY, UNPAYWALL_EMAIL,
 *               ANTHROPIC_API_KEY (or Claude Code subscription).
 * Optional env: CLAUDE_BIN (default 'claude'),
 *               DIGEST_SUMMARY_MODEL (default claude-sonnet-4-6).
 *
 * The summary prompt lives in ../prompts/full-summary-prompt.txt.
 */

'use strict';

const https = require('https');
const http = require('http');
const child = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const UNPAYWALL_EMAIL = process.env.UNPAYWALL_EMAIL;

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MODEL = process.env.DIGEST_SUMMARY_MODEL || 'claude-sonnet-4-6';

const PIPELINE_DIR = path.resolve(__dirname, '..');
const PROMPTS_DIR = path.join(PIPELINE_DIR, 'prompts');

const CONFIG = {
  unpaywall_email: UNPAYWALL_EMAIL,
  maxFullTextChars: 60000,
  maxRetries: 4,
  retryDays: 7,
  userAgent: process.env.DIGEST_USER_AGENT || 'ai-literature-os-digest/1.0',
};

const DRY_RUN = process.argv.includes('--dry-run');

function loadPrompt(name) {
  const userPath    = path.join(PROMPTS_DIR, `${name}.txt`);
  const examplePath = path.join(PROMPTS_DIR, `${name}.example.txt`);
  if (fs.existsSync(userPath)) return fs.readFileSync(userPath, 'utf8');
  if (fs.existsSync(examplePath)) {
    console.warn(`WARNING: ${name}.txt not found; using ${name}.example.txt.`);
    return fs.readFileSync(examplePath, 'utf8');
  }
  throw new Error(`Neither ${userPath} nor ${examplePath} exists.`);
}

const SUMMARY_PROMPT = loadPrompt('full-summary-prompt');

// ── HTTP helpers ────────────────────────────────────────────────────────────────

function httpFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': CONFIG.userAgent, ...(opts.headers || {}) };
    const doRequest = (reqUrl, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const mod = reqUrl.startsWith('https') ? https : http;
      mod.get(reqUrl, { headers, timeout: 30000 }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let loc = res.headers.location;
          if (loc.startsWith('//')) loc = 'https:' + loc;
          else if (loc.startsWith('/')) {
            const u = new URL(reqUrl);
            loc = u.origin + loc;
          }
          return doRequest(loc, redirects + 1);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
        res.on('error', reject);
      }).on('error', reject);
    };
    doRequest(url);
  });
}

function callClaude(prompt, timeoutMs = 180000) {
  const result = child.execFileSync(CLAUDE_BIN, ['-p', '--model', MODEL], {
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.trim();
}

// ── Supabase helpers ────────────────────────────────────────────────────────────

function supabaseGet(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, SUPABASE_URL);
    https.get(url, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Accept': 'application/json',
      },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 300) reject(new Error(`Supabase GET ${urlPath}: ${res.statusCode} ${body}`));
        else resolve(JSON.parse(body));
      });
    }).on('error', reject);
  });
}

function supabasePatch(paperId, fields) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(fields);
    const url = new URL(`${SUPABASE_URL}/rest/v1/papers?paper_id=eq.${encodeURIComponent(paperId)}`);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 300) reject(new Error(`Supabase PATCH ${paperId}: ${res.statusCode} ${body}`));
        else resolve({ status: res.statusCode });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Full-text access cascade ────────────────────────────────────────────────────

async function getPMCID(pmid) {
  try {
    const res = await httpFetch(
      `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${pmid}&format=json&tool=ai-literature-os&email=${CONFIG.unpaywall_email}`
    );
    const data = JSON.parse(res.body.toString());
    return data?.records?.[0]?.pmcid || null;
  } catch { return null; }
}

function extractTextFromPMCXML(xml) {
  const bodyMatch = xml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return null;
  let text = bodyMatch[1];
  text = text.replace(/<table-wrap[\s\S]*?<\/table-wrap>/gi, '');
  text = text.replace(/<fig[\s\S]*?<\/fig>/gi, '');
  text = text.replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, '\n## $1\n');
  text = text.replace(/<p[^>]*>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text.length > 500 ? text : null;
}

async function tryPMC(pmid) {
  try {
    const pmcid = await getPMCID(pmid);
    if (!pmcid) return null;
    const xmlRes = await httpFetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${pmcid}&rettype=xml`
    );
    return extractTextFromPMCXML(xmlRes.body.toString());
  } catch (err) {
    console.log(`    PMC error: ${err.message}`);
    return null;
  }
}

async function tryEuropePMC(pmid) {
  try {
    const pmcid = await getPMCID(pmid);
    if (!pmcid) return null;
    const pmcNum = pmcid.replace('PMC', '');
    const pdfRes = await httpFetch(
      `https://europepmc.org/backend/ptpmcrender.fcgi?accid=PMC${pmcNum}&blobtype=pdf`
    );
    if (pdfRes.status !== 200 || pdfRes.body.length < 1000) return null;
    if (!pdfRes.body.slice(0, 5).toString().startsWith('%PDF')) return null;
    const tmpPath = `/tmp/paper-${pmid}-${Date.now()}.pdf`;
    fs.writeFileSync(tmpPath, pdfRes.body);
    try {
      const text = child.execFileSync('pdftotext', [tmpPath, '-'], { maxBuffer: 10 * 1024 * 1024 }).toString();
      return text.length > 500 ? text : null;
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  } catch (err) {
    console.log(`    Europe PMC error: ${err.message}`);
    return null;
  }
}

async function tryUnpaywall(doi) {
  try {
    const res = await httpFetch(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${CONFIG.unpaywall_email}`
    );
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body.toString());
    if (!data.is_oa) return null;
    const loc = data.best_oa_location;
    if (!loc) return null;
    const pdfUrl = loc.url_for_pdf;
    if (pdfUrl) {
      try {
        const pdfRes = await httpFetch(pdfUrl);
        if (pdfRes.status === 200 && pdfRes.body.slice(0, 5).toString().startsWith('%PDF')) {
          const tmpPath = `/tmp/paper-unpaywall-${Date.now()}.pdf`;
          fs.writeFileSync(tmpPath, pdfRes.body);
          try {
            const text = child.execFileSync('pdftotext', [tmpPath, '-'], { maxBuffer: 10 * 1024 * 1024 }).toString();
            if (text.length > 500) return text;
          } finally {
            try { fs.unlinkSync(tmpPath); } catch {}
          }
        }
      } catch {}
    }
    return null;
  } catch (err) {
    console.log(`    Unpaywall error: ${err.message}`);
    return null;
  }
}

async function tryBioRxivJATS(doi) {
  try {
    const slug = doi.includes('/') ? doi.split('/').slice(1).join('/') : doi;
    for (const server of ['biorxiv', 'medrxiv']) {
      const apiRes = await httpFetch(`https://api.${server}.org/details/${server}/${slug}`);
      if (apiRes.status !== 200) continue;
      const data = JSON.parse(apiRes.body.toString());
      const art = data?.collection?.[0];
      if (!art) continue;

      let jatsUrl = art.jatsxml || '';
      if (!jatsUrl && art.doi && art.date) {
        const artSlug = art.doi.includes('/') ? art.doi.split('/').slice(1).join('/') : art.doi;
        const datePath = art.date.replace(/-/g, '/');
        jatsUrl = `https://www.${server}.org/content/early/${datePath}/${artSlug}.source.xml`;
      }
      if (!jatsUrl) continue;

      jatsUrl = jatsUrl.replace(/(?<!:)\/\//g, '/');
      console.log(`    Fetching JATS XML: ${jatsUrl}`);

      const xmlRes = await httpFetch(jatsUrl);
      if (xmlRes.status !== 200) continue;
      const xml = xmlRes.body.toString();
      const text = extractTextFromJATSXML(xml);
      if (text) return text;
    }
    return null;
  } catch (err) {
    console.log(`    BioRxiv JATS error: ${err.message}`);
    return null;
  }
}

function extractTextFromJATSXML(xml) {
  const bodyMatch = xml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return null;
  let text = bodyMatch[1];
  text = text.replace(/<table-wrap[\s\S]*?<\/table-wrap>/gi, '');
  text = text.replace(/<fig[\s\S]*?<\/fig>/gi, '');
  text = text.replace(/<supplementary-material[\s\S]*?<\/supplementary-material>/gi, '');
  text = text.replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, '\n## $1\n');
  text = text.replace(/<p[^>]*>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<list-item[^>]*>/gi, '\n• ');
  text = text.replace(/<\/list-item>/gi, '');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text.length > 500 ? text : null;
}

function isBioRxivDoi(doi) {
  if (!doi) return false;
  return /^10\.(1101|64898)\//.test(doi);
}

async function getFullText(paper) {
  const pmid = paper.pmid;
  const doi = paper.doi;
  console.log(`  [${pmid || doi}] Trying access cascade...`);

  if (isBioRxivDoi(doi)) {
    const jatsText = await tryBioRxivJATS(doi);
    if (jatsText) { console.log(`    ✓ BioRxiv JATS XML (${jatsText.length} chars)`); return { text: jatsText, source: 'biorxiv' }; }
  }

  if (pmid) {
    const pmcText = await tryPMC(pmid);
    if (pmcText) { console.log(`    ✓ PMC XML (${pmcText.length} chars)`); return { text: pmcText, source: 'pmc' }; }
  }

  if (pmid) {
    const epmcText = await tryEuropePMC(pmid);
    if (epmcText) { console.log(`    ✓ Europe PMC PDF (${epmcText.length} chars)`); return { text: epmcText, source: 'europepmc' }; }
  }

  if (doi) {
    const unpText = await tryUnpaywall(doi);
    if (unpText) { console.log(`    ✓ Unpaywall OA (${unpText.length} chars)`); return { text: unpText, source: 'unpaywall' }; }
  }

  console.log(`    ✗ No full text available`);
  return null;
}

// ── Summary generation ──────────────────────────────────────────────────────────

function generateSummary(paper, fullText) {
  let text = fullText;
  if (text.length > CONFIG.maxFullTextChars) {
    text = text.slice(0, CONFIG.maxFullTextChars) + '\n\n[TRUNCATED — full paper continues]';
  }

  const authors = typeof paper.authors === 'string'
    ? paper.authors
    : (Array.isArray(paper.authors) ? paper.authors.slice(0, 3).join(', ') : 'Unknown');

  const prompt = `${SUMMARY_PROMPT}\n\nPaper: "${paper.title}" by ${authors} et al.\nJournal: ${paper.journal || 'Unknown'}\n\nFull text:\n${text}`;

  const result = callClaude(prompt);

  const fenced = result.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : result.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse summary JSON from Claude response');
  return JSON.parse(match[0]);
}

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function renderSummaryHtml(summary) {
  const parts = [];
  if (summary.keyFindings?.length) {
    parts.push('<h4>Key Findings</h4><ul>');
    summary.keyFindings.forEach(f => parts.push(`<li>${esc(f)}</li>`));
    parts.push('</ul>');
  }
  if (summary.methods) parts.push(`<h4>Methods</h4><p>${esc(summary.methods)}</p>`);
  if (summary.relevance) parts.push(`<h4>Relevance</h4><p>${esc(summary.relevance)}</p>`);
  if (summary.notableData) parts.push(`<h4>Notable Data</h4><p>${esc(summary.notableData)}</p>`);
  if (summary.limitations) parts.push(`<h4>Limitations</h4><p>${esc(summary.limitations)}</p>`);
  return parts.join('\n');
}

// ── Queue processing ────────────────────────────────────────────────────────────

async function fetchQueue() {
  const cutoff = new Date(Date.now() - CONFIG.retryDays * 86400000).toISOString();
  const pending = await supabaseGet(
    `/rest/v1/papers?status=eq.summary_pending&wants_deep_summary=eq.true&select=paper_id,pmid,doi,title,authors,journal,abstract,retry_count`
  );
  const deferred = await supabaseGet(
    `/rest/v1/papers?status=eq.summary_deferred&retry_count=lt.${CONFIG.maxRetries}&last_attempt=lt.${cutoff}&select=paper_id,pmid,doi,title,authors,journal,abstract,retry_count`
  );
  return [...pending, ...deferred];
}

async function processPaper(paper) {
  const id = paper.paper_id;
  const retryNum = (paper.retry_count || 0) + 1;
  console.log(`\n  Processing: ${paper.title?.slice(0, 70)}...`);
  console.log(`    Attempt ${retryNum}/${CONFIG.maxRetries}`);

  const fullText = await getFullText(paper);

  if (!fullText) {
    if (retryNum >= CONFIG.maxRetries) {
      console.log(`    ✗ Giving up after ${CONFIG.maxRetries} attempts`);
      await supabasePatch(id, {
        status: 'summary_failed',
        retry_count: retryNum,
        last_attempt: new Date().toISOString(),
        notes: `Full text unavailable after ${CONFIG.maxRetries} attempts over ~${CONFIG.maxRetries * CONFIG.retryDays} days`,
      });
    } else {
      console.log(`    → Deferred — will retry in ${CONFIG.retryDays} days`);
      await supabasePatch(id, {
        status: 'summary_deferred',
        retry_count: retryNum,
        last_attempt: new Date().toISOString(),
      });
    }
    return 'deferred';
  }

  try {
    console.log(`    Generating summary via Claude Sonnet...`);
    const summary = generateSummary(paper, fullText.text);
    const renderedText = renderSummaryHtml(summary);

    await supabasePatch(id, {
      status: 'summary_ready',
      full_summary: summary,
      full_text_summary: renderedText,
      access_method: fullText.source,
      summarized_date: new Date().toISOString(),
      retry_count: retryNum,
      last_attempt: new Date().toISOString(),
    });

    console.log(`    ✓ Summary ready (${fullText.source})`);
    return 'success';
  } catch (err) {
    console.log(`    ✗ Summary generation failed: ${err.message}`);
    await supabasePatch(id, {
      status: 'summary_deferred',
      retry_count: retryNum,
      last_attempt: new Date().toISOString(),
      notes: `Summary generation error: ${err.message}`,
    });
    return 'error';
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY required');
    process.exit(1);
  }
  if (!UNPAYWALL_EMAIL) {
    console.error('ERROR: UNPAYWALL_EMAIL required (Unpaywall API ToS)');
    process.exit(1);
  }
  if (!DRY_RUN) {
    try {
      child.execFileSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', timeout: 5000 });
    } catch {
      console.error(`ERROR: Claude CLI not found at "${CLAUDE_BIN}". Set CLAUDE_BIN env var.`);
      process.exit(1);
    }
  }

  console.log(`\n── Process summary queue ──────────────────`);
  if (DRY_RUN) console.log('  (DRY RUN — no writes)');

  const queue = await fetchQueue();
  console.log(`  Queue: ${queue.length} paper(s) to process`);

  if (queue.length === 0) {
    console.log('  Nothing to do.');
    return;
  }

  const results = { success: 0, deferred: 0, error: 0 };

  for (const paper of queue) {
    if (DRY_RUN) {
      console.log(`  [DRY] Would process: ${paper.title?.slice(0, 60)}... (${paper.pmid || paper.doi})`);
      continue;
    }

    const result = await processPaper(paper);
    results[result === 'success' ? 'success' : result === 'error' ? 'error' : 'deferred']++;

    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n── Results ──────────────────────────────`);
  console.log(`  Summarized:  ${results.success}`);
  console.log(`  Deferred:    ${results.deferred}`);
  console.log(`  Errors:      ${results.error}`);
  console.log(`── Done ─────────────────────────────────\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
