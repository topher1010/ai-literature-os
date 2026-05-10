#!/usr/bin/env node
/**
 * poll-grants.js — NIH Reporter grants fetcher.
 *
 * Searches NIH Reporter API for relevant active grants, deduplicates against
 * the seen-set, scores for relevance via keyword tiers, and (with --score)
 * embeds them for downstream scoring by score-with-claude.js.
 *
 * Search queries, keyword tiers, and fiscal-year window are all configured
 * in ../config/grants-config.json. Copy from grants-config.example.json and
 * edit for your field. Scoring + summary prompts come from
 * ../prompts/grant-scoring-prompt.txt and ../prompts/grant-summary-prompt.txt.
 *
 * Usage:
 *   node poll-grants.js                  # dry run (print only)
 *   node poll-grants.js --commit         # write to Supabase
 *   node poll-grants.js --commit --score # + embed for downstream LLM scoring
 *
 * Required env (with --commit): SUPABASE_URL, SUPABASE_SERVICE_KEY.
 * Required env (with --score):  OPENROUTER_API_KEY.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const supabase = require('./supabase-client');
const runCtx = require('./digest-run');

let scorePapersModule = null;
try {
  scorePapersModule = require('./score-papers');
} catch { /* scoring module not available */ }

// ── Config ────────────────────────────────────────────────────────────────────

const PIPELINE_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PIPELINE_DIR, 'config', 'grants-config.json');
const CONFIG_EXAMPLE = path.join(PIPELINE_DIR, 'config', 'grants-config.example.json');
const PROMPTS_DIR = path.join(PIPELINE_DIR, 'prompts');

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (fs.existsSync(CONFIG_EXAMPLE)) {
    console.warn(`WARNING: ${CONFIG_PATH} not found; using ${CONFIG_EXAMPLE}. Copy and edit before relying on results.`);
    return JSON.parse(fs.readFileSync(CONFIG_EXAMPLE, 'utf8'));
  }
  throw new Error(`Neither ${CONFIG_PATH} nor ${CONFIG_EXAMPLE} exists.`);
}

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

const config = loadConfig();
const GRANT_SEARCHES = config.searches;
const KEYWORD_TIERS = config.keyword_tiers;
const USER_AGENT = process.env.DIGEST_USER_AGENT || 'ai-literature-os-digest/1.0';

const SEEN_FILE = path.resolve(__dirname, '../data/seen-grants.json');

// Current and previous fiscal year (NIH FY starts Oct 1)
const now = new Date();
const currentFY = now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
const FISCAL_YEARS = [currentFY - 1, currentFY];

const GRANT_SCORING_PROMPT = loadPrompt('grant-scoring-prompt');
const GRANT_SUMMARY_PROMPT = loadPrompt('grant-summary-prompt');

// ── Keyword scoring ───────────────────────────────────────────────────────────

function kwMatch(text, kw) {
  return text.includes(kw.toLowerCase());
}

function scoreRelevance(grant) {
  const text = `${grant.title} ${grant.abstract} ${grant.terms}`.toLowerCase();
  let score = 0;
  const matched = [];

  for (const kw of (KEYWORD_TIERS.high || [])) {
    if (kwMatch(text, kw)) { score += 3; matched.push(kw); }
  }
  for (const kw of (KEYWORD_TIERS.medium || [])) {
    if (kwMatch(text, kw)) { score += 1; matched.push(kw); }
  }

  const normalized = Math.min(score / 10, 1.0);
  let label = 'low';
  if (normalized >= 0.6) label = 'high';
  else if (normalized >= 0.3) label = 'medium';

  return { score: normalized, label, matched: [...new Set(matched)] };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, res => {
      let result = '';
      res.on('data', chunk => result += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(result)); }
        catch (e) { reject(new Error(`JSON parse error: ${result.slice(0, 200)}`)); }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function formatPI(name) {
  if (!name) return '';
  // "LAST, FIRST" → "First Last"
  const parts = name.split(',');
  if (parts.length === 2) {
    const last = parts[0].trim();
    const first = parts[1].trim();
    const tc = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    return `${tc(first)} ${tc(last)}`;
  }
  return name;
}

// ── Seen-grants persistent store ──────────────────────────────────────────────

function loadSeen() {
  try {
    const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    return { grants: new Map(Object.entries(data.grants || {})) };
  } catch {
    return { grants: new Map() };
  }
}

function seenPayload(seen) {
  const obj = {};
  for (const [k, v] of seen.grants) obj[k] = v;
  return { updated: new Date().toISOString().slice(0, 10), grants: obj };
}

function stageSeen(runDir, seen) {
  runCtx.writePendingSeen(runDir, 'grants', seenPayload(seen));
}

function commitSeen(runDir) {
  return runCtx.commitSeen(runDir, 'grants', SEEN_FILE);
}

// ── NIH Reporter API ──────────────────────────────────────────────────────────

async function searchGrants(searchLabel, searchText, operator = 'and') {
  const body = {
    criteria: {
      advanced_text_search: {
        operator: operator,
        search_field: 'projecttitle,terms,abstracttext',
        search_text: searchText,
      },
      fiscal_years: FISCAL_YEARS,
      include_active_projects: true,
    },
    offset: 0,
    limit: 50,
    sort_field: 'award_notice_date',
    sort_order: 'desc',
  };

  try {
    const res = await postJSON('https://api.reporter.nih.gov/v2/projects/search', body);
    const results = res.results || [];
    return results.map(r => extractGrant(r, searchLabel));
  } catch (e) {
    console.error(`  Error searching "${searchLabel}": ${e.message}`);
    return [];
  }
}

function extractGrant(result, searchLabel) {
  const org = result.organization || {};
  const pis = result.principal_investigators || [];

  return {
    id: result.core_project_num || '',
    title: result.project_title || '',
    pi: formatPI(result.contact_pi_name),
    piTitle: pis[0]?.title || '',
    allPIs: pis.map(p => p.full_name || p.last_name || '').filter(Boolean),
    organization: org.org_name || '',
    orgCity: org.org_city || '',
    orgState: org.org_state || '',
    mechanism: result.activity_code || '',
    projectNum: result.project_num || '',
    amount: result.award_amount || null,
    directCost: result.direct_cost_amt || null,
    indirectCost: result.indirect_cost_amt || null,
    fiscalYear: result.fiscal_year || null,
    isNew: result.is_new || false,
    startDate: result.project_start_date?.slice(0, 10) || '',
    endDate: result.project_end_date?.slice(0, 10) || '',
    awardDate: result.award_notice_date?.slice(0, 10) || '',
    abstract: result.abstract_text || '',
    terms: result.terms || '',
    studySection: result.full_study_section?.name || '',
    url: result.project_detail_url || `https://reporter.nih.gov/search/${result.core_project_num}`,
    source: searchLabel,
    addedDate: new Date().toISOString().slice(0, 10),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const commit = process.argv.includes('--commit');
  const useScoring = process.argv.includes('--score') && scorePapersModule !== null;

  const runDir = runCtx.getRunDir();
  console.log(`Run dir: ${runDir}`);

  console.log(`NIH Reporter grants fetch — ${new Date().toISOString().slice(0, 10)}`);
  console.log(`Fiscal years: ${FISCAL_YEARS.join(', ')}`);
  console.log(`Mode: ${commit ? 'COMMIT' : 'DRY RUN'}${useScoring ? ' + SCORING' : ''}\n`);

  const seen = loadSeen();
  console.log(`Seen grants: ${seen.grants.size}`);

  const grantMap = new Map();
  let totalHits = 0;

  for (const search of GRANT_SEARCHES) {
    console.log(`\nSearching: "${search.label}"...`);
    await sleep(300);

    const grants = await searchGrants(search.label, search.text, search.operator || 'and');
    console.log(`  Found ${grants.length} results`);
    totalHits += grants.length;

    for (const grant of grants) {
      if (!grant.id) continue;
      const existing = grantMap.get(grant.id);
      if (existing) {
        if ((grant.fiscalYear || 0) > (existing.fiscalYear || 0)) {
          grantMap.set(grant.id, grant);
        } else if (!existing.source.includes(search.label)) {
          existing.source += `, ${search.label}`;
        }
      } else {
        grantMap.set(grant.id, grant);
      }
    }
  }

  console.log(`\nTotal raw hits: ${totalHits}`);
  console.log(`Unique grants (by core_project_num): ${grantMap.size}`);

  const allFound = [];
  for (const [coreNum, grant] of grantMap) {
    const relevance = scoreRelevance(grant);
    grant.relevance = relevance.label;
    grant.relevanceScore = parseFloat(relevance.score.toFixed(2));
    grant.tags = relevance.matched.slice(0, 6);
    allFound.push(grant);
  }

  const newGrants = [];
  const updatedGrants = [];

  for (const grant of allFound) {
    const seenFY = seen.grants.get(grant.id);
    if (seenFY === undefined) {
      newGrants.push(grant);
    } else if ((grant.fiscalYear || 0) > seenFY) {
      updatedGrants.push(grant);
    }
  }

  console.log(`\n── Summary ─────────────────────────`);
  console.log(`New grants:     ${newGrants.length}`);
  console.log(`Updated (new FY): ${updatedGrants.length}`);
  console.log(`Already seen:   ${allFound.length - newGrants.length - updatedGrants.length}`);

  const allNew = [...newGrants, ...updatedGrants];
  console.log(`\nNew + updated grants: ${allNew.length}`);
  console.log(`  High relevance:   ${allNew.filter(g => g.relevance === 'high').length}`);
  console.log(`  Medium relevance: ${allNew.filter(g => g.relevance === 'medium').length}`);
  console.log(`  Low relevance:    ${allNew.filter(g => g.relevance === 'low').length}`);

  if (allNew.length > 0) {
    console.log('\nSample new grants:');
    allNew.slice(0, 5).forEach(g => {
      console.log(`  [${g.relevance.toUpperCase()}] ${g.mechanism} ${g.id} — ${g.title.slice(0, 60)}`);
      console.log(`         PI: ${g.pi} @ ${g.organization}`);
      if (g.amount) console.log(`         Amount: $${g.amount.toLocaleString()}`);
    });
  }

  if (!commit) {
    console.log('\n[DRY RUN] Pass --commit to write to Supabase.');
    if (useScoring) console.log('[DRY RUN] --score flag detected but skipped in dry run.');
    return;
  }

  for (const [coreNum, grant] of grantMap) {
    seen.grants.set(coreNum, grant.fiscalYear || 0);
  }
  stageSeen(runDir, seen);

  if (useScoring && allNew.length > 0) {
    console.log(`\n── Embedding + Ranking ──────────────────`);
    try {
      const grantsForEmbedding = allNew.map(g => ({ ...g, abstract: g.abstract || '' }));
      const { topPapers: topGrants } = await scorePapersModule.embedAndRank(grantsForEmbedding);

      const embeddedPath = path.join(runDir, 'embedded-grants.json');
      fs.writeFileSync(embeddedPath, JSON.stringify(topGrants, null, 2));
      console.log(`\nEmbedding complete: ${allNew.length} collected → ${topGrants.length} ranked`);
      console.log(`Wrote ${embeddedPath} — score-with-claude.js will handle scoring.`);
      runCtx.appendRunReport(runDir, {
        stage: 'poll-grants',
        result: 'embedded',
        collected: allNew.length,
        ranked: topGrants.length,
      });
      return;
    } catch (e) {
      console.error(`Embedding failed: ${e.message}`);
      console.log('Falling back to all collected grants (keyword scoring only).');
    }
  }

  const allGrants = [...newGrants, ...updatedGrants];

  if (allGrants.length === 0) {
    console.log('\nNo new or updated grants to write.');
    commitSeen(runDir);
    runCtx.appendRunReport(runDir, { stage: 'poll-grants', result: 'no-grants-to-add' });
    return;
  }

  if (!supabase.isConfigured()) {
    console.error('[Supabase] Not configured — cannot write grants.');
    runCtx.appendRunReport(runDir, { stage: 'poll-grants', result: 'supabase-unconfigured' });
    process.exit(1);
  }
  await supabase.upsertGrants(allGrants);
  commitSeen(runDir);
  console.log(`\nWrote ${allGrants.length} grants to Supabase`);
  runCtx.appendRunReport(runDir, {
    stage: 'poll-grants',
    result: 'direct-upsert',
    upserted: allGrants.length,
  });
}

module.exports = { GRANT_SCORING_PROMPT, GRANT_SUMMARY_PROMPT };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
