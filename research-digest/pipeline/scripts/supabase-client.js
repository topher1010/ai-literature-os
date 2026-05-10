/**
 * supabase-client.js — Thin REST client for pipeline → Supabase writes.
 *
 * Uses SUPABASE_URL and SUPABASE_SERVICE_KEY from environment.
 * No npm dependencies — uses Node's built-in https module.
 */

'use strict';

const https = require('https');
const { URL } = require('url');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function isConfigured() {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SUPABASE_URL);
    const data = body ? JSON.stringify(body) : null;

    const opts = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request(opts, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        if (res.statusCode >= 300) {
          reject(new Error(`Supabase ${method} ${path}: ${res.statusCode} ${chunks}`));
        } else {
          resolve(chunks ? JSON.parse(chunks) : null);
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Paper mapping: pipeline JSON → Supabase row ────────────────────────────

function mapPaperToRow(p) {
  const paperId = p.id || p.pmid || p.doi;
  if (!paperId) return null; // skip papers with no identifier
  return {
    paper_id:           paperId,
    pmid:               p.pmid || null,
    doi:                p.doi || null,
    title:              p.title,
    authors:            Array.isArray(p.authors) ? p.authors : null,
    journal:            p.journal || null,
    pub_date:           p.date || null,
    abstract:           p.abstract || null,
    tags:               Array.isArray(p.tags) ? p.tags : null,
    source:             p.source || null,
    relevance:          p.relevance || null,
    batch:              p.batch || p.addedDate || null,
    embedding_core:     p.embeddingScores?.core ?? null,
    embedding_methods:  p.embeddingScores?.methods ?? null,
    embedding_adjacent: p.embeddingScores?.adjacent ?? null,
    embedding_combined: p.embeddingCombined ?? null,
    sonnet_relevance:   p.sonnetRelevance ?? null,
    sonnet_surprise:    p.sonnetSurprise ?? null,
    sonnet_combined:    p.sonnetCombined ?? null,
    sonnet_reason:      p.sonnetReason || null,
    scoring_method:     p.scoringMethod || null,
    ai_summary:         p.aiSummary || null,
    why_it_matters:     p.whyItMatters || null,
    full_summary:       p.fullSummary || null,
    is_wildcard:        p.isWildcard || false,
    is_preprint:        p.isPreprint || false,
  };
}

// ── Grant mapping: pipeline JSON → Supabase row ────────────────────────────

function mapGrantToRow(g) {
  return {
    grant_id:           g.id,
    title:              g.title || g.project_title || 'Untitled',
    pi:                 g.pi || g.contact_pi_name || null,
    organization:       g.organization || g.organization_name || null,
    org_city:           g.orgCity || null,
    org_state:          g.orgState || null,
    mechanism:          g.mechanism || null,
    amount:             g.amount || null,
    fiscal_year:        g.fiscalYear || null,
    start_date:         g.startDate || null,
    end_date:           g.endDate || null,
    award_date:         g.awardDate || null,
    abstract:           g.abstract || g.abstract_text || null,
    url:                g.url || null,
    source:             g.source || null,
    tags:               Array.isArray(g.tags) ? g.tags : null,
    relevance:          g.relevance || null,
    embedding_combined: g.embeddingCombined ?? null,
    sonnet_relevance:   g.sonnetRelevance ?? null,
    sonnet_surprise:    g.sonnetSurprise ?? null,
    sonnet_combined:    g.sonnetCombined ?? null,
    sonnet_reason:      g.sonnetReason || null,
    scoring_method:     g.scoringMethod || null,
    ai_summary:         g.aiSummary || null,
    why_it_matters:     g.whyItMatters || null,
    is_new:             g.isNew ?? true,
    batch:              g.batch || g.addedDate || null,
    study_section:      g.studySection || null,
  };
}

// ── Batch upsert (chunks of 50 to stay under payload limits) ───────────────

async function upsertBatch(table, rows, conflictKey) {
  const CHUNK = 50;
  let total = 0;
  // Ensure all rows in each chunk have identical keys (PostgREST requirement)
  const allKeys = Object.keys(rows[0] || {});
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map(row => {
      const normalized = {};
      for (const k of allKeys) normalized[k] = row[k] ?? null;
      return normalized;
    });
    await request('POST', `/rest/v1/${table}?on_conflict=${conflictKey}`, chunk);
    total += chunk.length;
  }
  return total;
}

async function upsertPapers(papers) {
  const rows = papers.map(mapPaperToRow).filter(Boolean);
  if (rows.length === 0) return 0;
  const count = await upsertBatch('digest_papers', rows, 'paper_id');
  console.log(`  [Supabase] Upserted ${count} papers to digest_papers`);
  return count;
}

async function upsertGrants(grants) {
  const rows = grants.map(mapGrantToRow).filter(Boolean);
  if (rows.length === 0) return 0;
  const count = await upsertBatch('digest_grants', rows, 'grant_id');
  console.log(`  [Supabase] Upserted ${count} grants to digest_grants`);
  return count;
}

module.exports = { isConfigured, upsertPapers, upsertGrants, mapPaperToRow, mapGrantToRow };
