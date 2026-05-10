#!/usr/bin/env node
/**
 * summarize-papers.js — Full-text access cascade + structured summary generation.
 *
 * For each PMID:
 *   1. Try PMC eutils XML → Europe PMC PDF → Unpaywall OA cascade
 *   2. Extract full text
 *   3. Generate structured JSON summary via Claude Sonnet
 *   4. Update papers.json with `fullSummary` field
 *   5. Optional: send a digest email (--email flag; requires email-utils.js)
 *
 * Usage:
 *   node summarize-papers.js --pmids=12345678,23456789 [--commit] [--email]
 *
 * Required env: ANTHROPIC_API_KEY, UNPAYWALL_EMAIL.
 * Optional env: DIGEST_PAPERS_JSON (default ../data/papers.json),
 *               DIGEST_SUMMARY_MODEL (default claude-sonnet-4-6),
 *               DIGEST_DOMAIN (used in email body links),
 *               DIGEST_ADMIN_EMAIL (recipient for --email).
 *
 * The summary prompt lives in ../prompts/full-summary-prompt.txt — copy from
 * .example.txt and edit for your research focus.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────────

const PIPELINE_DIR = path.resolve(__dirname, '..');
const PROMPTS_DIR = path.join(PIPELINE_DIR, 'prompts');
const UNPAYWALL_EMAIL = process.env.UNPAYWALL_EMAIL;
if (!UNPAYWALL_EMAIL) {
  console.error('ERROR: UNPAYWALL_EMAIL not set. Unpaywall API requires an email per their ToS.');
  process.exit(1);
}

const CONFIG = {
  papersJsonPath: process.env.DIGEST_PAPERS_JSON || path.join(PIPELINE_DIR, 'data', 'papers.json'),
  unpaywall_email: UNPAYWALL_EMAIL,
  sonnetModel: process.env.DIGEST_SUMMARY_MODEL || 'claude-sonnet-4-6',
  maxFullTextChars: 60000,
  userAgent: process.env.DIGEST_USER_AGENT || 'ai-literature-os-digest/1.0',
  digestDomain: process.env.DIGEST_DOMAIN || '',
  adminEmail: process.env.DIGEST_ADMIN_EMAIL || '',
};

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

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': CONFIG.userAgent, ...(opts.headers || {}) };

    const doRequest = (reqUrl, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const reqMod = reqUrl.startsWith('https') ? https : http;
      reqMod.get(reqUrl, { headers, timeout: 30000 }, res => {
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
        res.on('end', () => resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks),
          headers: res.headers,
        }));
        res.on('error', reject);
      }).on('error', reject);
    };

    doRequest(url);
  });
}

function postJSON(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    };

    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          resolve({ raw: Buffer.concat(chunks).toString() });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Full-text access cascade ────────────────────────────────────────────────────

async function getFullText(paper) {
  const pmid = paper.pmid;
  const doi = paper.doi;

  console.log(`  [${pmid || doi}] Trying access cascade...`);

  if (pmid) {
    const pmcText = await tryPMC(pmid);
    if (pmcText) {
      console.log(`    ✓ PMC XML (${pmcText.length} chars)`);
      return { text: pmcText, source: 'pmc' };
    }
  }

  if (pmid) {
    const epmcText = await tryEuropePMC(pmid);
    if (epmcText) {
      console.log(`    ✓ Europe PMC PDF (${epmcText.length} chars)`);
      return { text: epmcText, source: 'europepmc' };
    }
  }

  if (doi) {
    const unpText = await tryUnpaywall(doi);
    if (unpText) {
      console.log(`    ✓ Unpaywall OA (${unpText.length} chars)`);
      return { text: unpText, source: 'unpaywall' };
    }
  }

  console.log(`    ✗ No full text available`);
  return null;
}

async function getPMCID(pmid) {
  try {
    const res = await fetch(
      `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${pmid}&format=json&tool=ai-literature-os&email=${CONFIG.unpaywall_email}`
    );
    const data = JSON.parse(res.body.toString());
    const record = data?.records?.[0];
    return record?.pmcid || null;
  } catch {
    return null;
  }
}

async function tryPMC(pmid) {
  try {
    const pmcid = await getPMCID(pmid);
    if (!pmcid) return null;

    const xmlRes = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${pmcid}&rettype=xml`
    );
    const xml = xmlRes.body.toString();

    return extractTextFromPMCXML(xml);
  } catch (err) {
    console.log(`    PMC error: ${err.message}`);
    return null;
  }
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

async function tryEuropePMC(pmid) {
  // Skipped in the public version: the original implementation downloaded a
  // PDF from Europe PMC and ran pdftotext to extract text. That works when
  // pdftotext is on PATH; not all installs have it. The PMC XML path above
  // is preferred. Re-enable this branch if you need broader OA coverage.
  return null;
}

async function tryUnpaywall(doi) {
  try {
    const res = await fetch(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${CONFIG.unpaywall_email}`
    );
    if (res.status !== 200) return null;

    const data = JSON.parse(res.body.toString());
    if (!data.is_oa) return null;

    // We only return text from the JSON metadata path here. Downloading and
    // parsing the OA PDF requires pdftotext + a temp file write, omitted in
    // the public version for portability.
    return null;
  } catch (err) {
    console.log(`    Unpaywall error: ${err.message}`);
    return null;
  }
}

// ── Summary generation ──────────────────────────────────────────────────────────

async function generateSummary(paper, fullText) {
  let text = fullText;
  if (text.length > CONFIG.maxFullTextChars) {
    text = text.slice(0, CONFIG.maxFullTextChars) + '\n\n[TRUNCATED — full paper continues]';
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const body = {
    model: CONFIG.sonnetModel,
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `Paper: "${paper.title}" by ${(paper.authors || []).slice(0, 3).join(', ')} et al.\nJournal: ${paper.journal || 'Unknown'}\n\nFull text:\n${text}`,
    }],
    system: SUMMARY_PROMPT,
  };

  const result = await postJSON('https://api.anthropic.com/v1/messages', body, {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  });

  if (result.error) throw new Error(`Sonnet error: ${JSON.stringify(result.error)}`);

  const content = result.content?.[0]?.text;
  if (!content) throw new Error('Empty response from Sonnet');

  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse summary JSON');
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const pmidArg = args.find(a => a.startsWith('--pmids='));
  const doCommit = args.includes('--commit');
  const doEmail = args.includes('--email');

  if (!pmidArg) {
    console.error('Usage: node summarize-papers.js --pmids=123,456,789 [--commit] [--email]');
    process.exit(1);
  }

  const pmids = pmidArg.replace('--pmids=', '').split(',').map(s => s.trim()).filter(Boolean);
  console.log(`\n── Summarize papers pipeline ──────────────`);
  console.log(`Papers to summarize: ${pmids.length}`);

  const data = JSON.parse(fs.readFileSync(CONFIG.papersJsonPath, 'utf8'));
  const papers = data.papers || [];

  const results = { success: [], noFullText: [], error: [] };

  for (const pmid of pmids) {
    const paper = papers.find(p => p.pmid === pmid || p.doi === pmid);
    if (!paper) {
      console.log(`  [${pmid}] Not found in papers.json — skipping`);
      results.error.push({ id: pmid, reason: 'not found' });
      continue;
    }

    console.log(`\n  Processing: ${paper.title?.slice(0, 60)}...`);

    const fullText = await getFullText(paper);
    if (!fullText) {
      results.noFullText.push(paper);
      paper.fullTextStatus = 'unavailable';
      continue;
    }

    try {
      console.log(`  Generating summary...`);
      const summary = await generateSummary(paper, fullText.text);
      paper.fullSummary = summary;
      paper.fullTextSource = fullText.source;
      paper.fullTextStatus = 'summarized';
      paper.summarizedDate = new Date().toISOString().slice(0, 10);
      results.success.push(paper);
      console.log(`    ✓ Summary generated`);
    } catch (err) {
      console.log(`    ✗ Summary error: ${err.message}`);
      results.error.push({ id: pmid, reason: err.message });
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  data.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(CONFIG.papersJsonPath, JSON.stringify(data, null, 2));
  console.log(`\nSaved ${CONFIG.papersJsonPath}`);

  console.log(`\n── Results ──────────────────────────────`);
  console.log(`  Summarized:     ${results.success.length}`);
  console.log(`  No full text:   ${results.noFullText.length}`);
  console.log(`  Errors:         ${results.error.length}`);

  if (results.noFullText.length > 0) {
    console.log(`\n  Papers without full text:`);
    results.noFullText.forEach(p => console.log(`    - ${p.title?.slice(0, 60)}... (${p.pmid || p.doi})`));
  }

  if (doCommit && results.success.length > 0) {
    console.log(`\npapers.json updated with ${results.success.length} summaries. Commit/push handled by your wrapper script if any.`);
  }

  if (doEmail && results.success.length > 0) {
    await sendSummaryEmail(results);
  }

  const output = {
    summarized: results.success.map(p => ({ pmid: p.pmid, title: p.title, source: p.fullTextSource })),
    noFullText: results.noFullText.map(p => ({ pmid: p.pmid, doi: p.doi, title: p.title })),
    errors: results.error,
  };

  console.log(`\n── JSON output ──────────────────────────`);
  console.log(JSON.stringify(output, null, 2));

  return output;
}

// ── Email (optional) ────────────────────────────────────────────────────────────

async function sendSummaryEmail(results) {
  if (!CONFIG.adminEmail) {
    console.log('  --email requested but DIGEST_ADMIN_EMAIL not set; skipping');
    return;
  }
  console.log(`\nSending summary email to ${CONFIG.adminEmail}...`);

  let emailUtils;
  try {
    emailUtils = require('./email-utils');
  } catch {
    console.log('  email-utils.js not found in this directory; skipping email send');
    console.log('  (Implement email-utils.js with buildEmail() and sendEmail() to enable.)');
    return;
  }

  try {
    const count = results.success.length;
    const noTextCount = results.noFullText.length;
    const date = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    let text = `Research Digest — ${count} Paper${count > 1 ? 's' : ''} Summarized\n${date}\n\n`;
    text += `${count} paper${count > 1 ? 's' : ''} summarized.`;
    if (noTextCount > 0) text += ` (${noTextCount} paper${noTextCount > 1 ? 's' : ''} had no accessible full text.)`;
    text += '\n\n';

    results.success.forEach((p, i) => {
      text += `${i + 1}. ${p.title}\n`;
      text += `   ${p.journal || ''} · ${p.date || ''}\n`;
      if (p.fullSummary?.keyFindings) {
        p.fullSummary.keyFindings.forEach(f => { text += `   • ${f}\n`; });
      }
      text += '\n';
    });

    if (CONFIG.digestDomain) {
      text += `Full summaries: ${CONFIG.digestDomain}\n`;
    }

    const payload = emailUtils.buildEmail({
      to: CONFIG.adminEmail,
      subject: `Research Digest: ${count} paper${count > 1 ? 's' : ''} summarized`,
      textBody: text,
    });

    const result = await emailUtils.sendEmail(payload);
    console.log(`  ✓ Email sent: ${result.message_id || 'ok'}`);
  } catch (err) {
    console.log(`  ✗ Email error: ${err.message}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
