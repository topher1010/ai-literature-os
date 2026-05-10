#!/usr/bin/env node
/**
 * poll-journals.js — PubMed + bioRxiv literature poller.
 *
 * Runs PubMed journal sweeps + keyword searches + bioRxiv pre-filter,
 * deduplicates against seen-pmids.json (persistent across runs), scores by
 * keyword tier, and (with --score) embeds candidates for downstream scoring
 * by score-with-claude.js.
 *
 * Journal list, PubMed search queries, and keyword tiers all live in
 * ../config/journals-config.json. Copy from journals-config.example.json and
 * edit for your field. The scoring/summary prompts (used downstream by
 * score-with-claude.js) live in ../prompts/.
 *
 * Usage:
 *   node poll-journals.js                  # dry run (print only)
 *   node poll-journals.js --commit         # write to Supabase
 *   node poll-journals.js --commit --score # + embed for downstream LLM scoring
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
const CONFIG_PATH = path.join(PIPELINE_DIR, 'config', 'journals-config.json');
const CONFIG_EXAMPLE = path.join(PIPELINE_DIR, 'config', 'journals-config.example.json');
const SEEN_FILE = path.resolve(__dirname, '../data/seen-pmids.json');

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (fs.existsSync(CONFIG_EXAMPLE)) {
    console.warn(`WARNING: ${CONFIG_PATH} not found; using ${CONFIG_EXAMPLE}.`);
    return JSON.parse(fs.readFileSync(CONFIG_EXAMPLE, 'utf8'));
  }
  throw new Error(`Neither ${CONFIG_PATH} nor ${CONFIG_EXAMPLE} exists.`);
}

const config = loadConfig();
const JOURNAL_SWEEPS = config.journal_sweeps || [];
const PUBMED_SEARCHES = config.pubmed_searches || [];
const KEYWORD_TIERS = config.keyword_tiers || { high: [], medium: [] };
const PUBMED_RELDAYS = config.pubmed_reldays || 10;
const PUBMED_MAX = config.pubmed_max || 100;
const USER_AGENT = process.env.DIGEST_USER_AGENT || 'ai-literature-os-digest/1.0';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode === 403 || res.statusCode === 404) {
        resolve('');
        res.resume();
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function getBatchLabel(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function kwMatch(text, kw) {
  if (kw.startsWith('~')) {
    // Word-boundary match for short abbreviations
    const term = kw.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${term}\\b`).test(text);
  }
  return text.includes(kw);
}

function scoreRelevance(paper) {
  const text = `${paper.title} ${paper.abstract}`.toLowerCase();
  let score = 0;
  const matched = [];

  for (const kw of (KEYWORD_TIERS.high || [])) {
    if (kwMatch(text, kw)) { score += 3; matched.push(kw.replace(/^~/, '')); }
  }
  for (const kw of (KEYWORD_TIERS.medium || [])) {
    if (kwMatch(text, kw)) { score += 1; matched.push(kw.replace(/^~/, '')); }
  }

  const normalized = Math.min(score / 10, 1.0);
  let label = 'low';
  if (normalized >= 0.6) label = 'high';
  else if (normalized >= 0.3) label = 'medium';

  return { score: normalized, label, matched: [...new Set(matched)] };
}

function makePaperEntry(paper, relevance) {
  const pubmedSearch = paper.pmid
    ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`
    : `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(paper.doi)}`;

  return {
    id: paper.doi
      ? paper.doi.replace(/\//g, '_').replace(/\./g, '-')
      : `pmid_${paper.pmid}`,
    title: paper.title,
    authors: paper.authors.length > 3
      ? [...paper.authors.slice(0, 3), 'et al.']
      : paper.authors,
    journal: paper.journal,
    year: (paper.date || '').slice(0, 4),
    date: paper.date || '',
    doi: paper.doi || null,
    pmid: paper.pmid || null,
    url: pubmedSearch,
    doiUrl: paper.doi ? `https://doi.org/${paper.doi}` : null,
    abstract: paper.abstract || null,
    relevance: relevance.label,
    relevanceScore: parseFloat(relevance.score.toFixed(2)),
    tags: relevance.matched.slice(0, 5),
    source: paper.source || paper.journal,
    addedDate: new Date().toISOString().slice(0, 10),
    batch: getBatchLabel(new Date()),
  };
}

// ── Seen-PMID persistent store ────────────────────────────────────────────────

function loadSeen() {
  try {
    const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    return {
      pmids: new Set(data.pmids || []),
      dois:  new Set(data.dois  || []),
    };
  } catch {
    return { pmids: new Set(), dois: new Set() };
  }
}

function seenPayload(seen) {
  return {
    updated: new Date().toISOString().slice(0, 10),
    pmids: [...seen.pmids].sort(),
    dois:  [...seen.dois].sort(),
  };
}

function stageSeen(runDir, seen) {
  runCtx.writePendingSeen(runDir, 'pmids', seenPayload(seen));
}

function commitSeen(runDir) {
  return runCtx.commitSeen(runDir, 'pmids', SEEN_FILE);
}

function isSeen(seen, paper) {
  if (paper.doi  && seen.dois.has(paper.doi))   return true;
  if (paper.pmid && seen.pmids.has(paper.pmid)) return true;
  return false;
}

function markSeen(seen, paper) {
  if (paper.doi)  seen.dois.add(paper.doi);
  if (paper.pmid) seen.pmids.add(paper.pmid);
}

// ── PubMed ────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pubmedSearch(term) {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed` +
    `&term=${encodeURIComponent(term)}&reldate=${PUBMED_RELDAYS}&datetype=pdat` +
    `&retmax=${PUBMED_MAX}&retmode=json`;
  const res = await fetch(url);
  if (!res) return [];
  const data = JSON.parse(res);
  return data.esearchresult?.idlist || [];
}

async function pubmedFetch(pmids) {
  if (!pmids.length) return [];
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed` +
    `&id=${pmids.join(',')}&retmode=xml`;
  const xml = await fetch(url);
  return parsePubMedXML(xml || '');
}

function parsePubMedXML(xml) {
  const papers = [];
  const articles = [...xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)];

  for (const match of articles) {
    const block = match[1];

    const getTag = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
      return m ? m[1].trim() : '';
    };

    const pmid = getTag('PMID');
    const title = block.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/)?.[1]
      .replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim() || '';

    const abstractBlocks = [...block.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)];
    const abstract = abstractBlocks.map(m => m[1].replace(/<[^>]+>/g, '').trim()).join(' ');

    const authorBlocks = [...block.matchAll(/<Author[^>]*>([\s\S]*?)<\/Author>/g)];
    const authors = authorBlocks.map(ab => {
      const last = ab[1].match(/<LastName>([^<]*)<\/LastName>/)?.[1] || '';
      const fore = ab[1].match(/<ForeName>([^<]*)<\/ForeName>/)?.[1] || '';
      return fore ? `${fore} ${last}` : last;
    }).filter(Boolean);

    const doiMatch = block.match(/<ArticleId IdType="doi">([^<]*)<\/ArticleId>/);
    const doi = doiMatch ? doiMatch[1].trim() : '';
    const journal = block.match(/<Title>([\s\S]*?)<\/Title>/)?.[1]?.trim() || '';

    const year  = getTag('Year')  || new Date().getFullYear().toString();
    const month = getTag('Month') || '01';
    const day   = getTag('Day')   || '01';
    const monthNum = isNaN(month) ? new Date(`${month} 1`).getMonth() + 1 : parseInt(month);
    const date = `${year}-${String(monthNum).padStart(2,'0')}-${String(day).padStart(2,'0')}`;

    if (!title || !pmid) continue;
    papers.push({ title, authors, doi, pmid, journal, date, abstract, link: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` });
  }

  return papers;
}

// ── bioRxiv ───────────────────────────────────────────────────────────────────

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchBioRxiv(seen) {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - PUBMED_RELDAYS);
  const fromDate = toISODate(from);
  const toDate = toISODate(now);

  console.log(`\nbioRxiv: fetching ${fromDate} → ${toDate}...`);

  const newPapers = [];
  let cursor = 0;
  const pageSize = 100;
  let totalFetched = 0;
  let totalFiltered = 0;

  while (true) {
    const url = `https://api.biorxiv.org/details/biorxiv/${fromDate}/${toDate}/${cursor}/${pageSize}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      console.error(`  bioRxiv fetch error at cursor ${cursor}: ${e.message}`);
      break;
    }
    if (!res) break;

    let data;
    try {
      data = JSON.parse(res);
    } catch (e) {
      console.error(`  bioRxiv parse error at cursor ${cursor}`);
      break;
    }

    const collection = data.collection || [];
    if (!collection.length) break;

    const total = data.messages?.[0]?.total || 0;
    totalFetched += collection.length;

    for (const item of collection) {
      const doi = item.doi || '';
      const title = item.title || '';

      if (doi && seen.dois.has(doi)) continue;
      const normTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normTitle && seen._bioTitles && seen._bioTitles.has(normTitle)) continue;

      const authors = typeof item.authors === 'string'
        ? item.authors.split(';').map(a => a.trim()).filter(Boolean)
        : (Array.isArray(item.authors) ? item.authors : []);

      const paper = {
        title,
        authors,
        doi,
        pmid: null,
        journal: 'bioRxiv',
        date: item.date || '',
        abstract: item.abstract || '',
        source: 'bioRxiv',
        isPreprint: true,
      };

      const relevance = scoreRelevance(paper);
      if (relevance.label === 'low') {
        totalFiltered++;
        continue;
      }

      seen.dois.add(doi);
      if (!seen._bioTitles) seen._bioTitles = new Set();
      seen._bioTitles.add(normTitle);

      const entry = makePaperEntry(paper, relevance);
      entry.source = 'bioRxiv';
      entry.isPreprint = true;
      entry.pmid = null;
      entry.url = doi ? `https://doi.org/${doi}` : '';
      entry.doiUrl = entry.url;

      console.log(`  [NEW ${relevance.label.toUpperCase()}] ${title.slice(0, 70)}`);
      if (relevance.matched.length) console.log(`         keywords: ${relevance.matched.slice(0,4).join(', ')}`);
      newPapers.push(entry);
    }

    if (cursor + pageSize >= total || collection.length < pageSize) break;
    cursor += pageSize;
    await sleep(300);
  }

  console.log(`  bioRxiv: fetched ${totalFetched} total, ${totalFiltered} filtered, ${newPapers.length} kept`);
  return newPapers;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const commit = process.argv.includes('--commit');
  const useScoring = process.argv.includes('--score') && scorePapersModule !== null;

  const runDir = runCtx.getRunDir();
  console.log(`Run dir: ${runDir}`);

  const seen = loadSeen();
  console.log(`Seen PMIDs: ${seen.pmids.size} | Seen DOIs: ${seen.dois.size}`);

  const newPapers = [];

  for (const sweep of JOURNAL_SWEEPS) {
    console.log(`\nJournal sweep: ${sweep.label}...`);
    const pmids = await pubmedSearch(sweep.journal);
    console.log(`  Found ${pmids.length} PMIDs`);
    if (!pmids.length) { await sleep(400); continue; }

    const unseenPmids = pmids.filter(id => !seen.pmids.has(id));
    console.log(`  Unseen: ${unseenPmids.length}`);
    if (!unseenPmids.length) { await sleep(400); continue; }

    await sleep(400);
    const papers = await pubmedFetch(unseenPmids);

    for (const paper of papers) {
      if (isSeen(seen, paper)) continue;
      markSeen(seen, paper);

      const relevance = scoreRelevance(paper);
      const entry = makePaperEntry(paper, relevance);
      entry.source = `Journal: ${sweep.label}`;

      console.log(`  [NEW ${relevance.label.toUpperCase()}] ${paper.title.slice(0, 70)}`);
      if (relevance.matched.length) console.log(`         keywords: ${relevance.matched.slice(0,4).join(', ')}`);
      newPapers.push(entry);
    }
    await sleep(400);
  }

  for (const search of PUBMED_SEARCHES) {
    console.log(`\nPubMed: "${search.label}"...`);
    const pmids = await pubmedSearch(search.term);
    console.log(`  Found ${pmids.length} PMIDs`);
    if (!pmids.length) { await sleep(400); continue; }

    const unseenPmids = pmids.filter(id => !seen.pmids.has(id));
    console.log(`  Unseen: ${unseenPmids.length}`);
    if (!unseenPmids.length) { await sleep(400); continue; }

    await sleep(400);
    const papers = await pubmedFetch(unseenPmids);

    for (const paper of papers) {
      if (isSeen(seen, paper)) continue;
      markSeen(seen, paper);

      const relevance = scoreRelevance(paper);
      // PubMed keyword hits: minimum 'medium' (deliberate search = intentional signal)
      if (relevance.label === 'low') { relevance.label = 'medium'; relevance.score = Math.max(relevance.score, 0.3); }

      const entry = makePaperEntry(paper, relevance);
      entry.source = `PubMed: ${search.label}`;
      entry.url = paper.link;

      console.log(`  [NEW ${relevance.label.toUpperCase()}] ${paper.title.slice(0, 70)}`);
      newPapers.push(entry);
    }
    await sleep(400);
  }

  const bioRxivPapers = await fetchBioRxiv(seen);
  for (const entry of bioRxivPapers) {
    if (entry.pmid) seen.pmids.add(entry.pmid);
    newPapers.push(entry);
  }

  console.log(`\n── Summary ─────────────────────────`);
  console.log(`New papers found: ${newPapers.length}`);
  console.log(`  High:   ${newPapers.filter(p => p.relevance === 'high').length}`);
  console.log(`  Medium: ${newPapers.filter(p => p.relevance === 'medium').length}`);
  console.log(`  Low:    ${newPapers.filter(p => p.relevance === 'low').length}`);

  if (newPapers.length === 0) {
    console.log('Nothing new — digest unchanged.');
    if (commit) {
      stageSeen(runDir, seen);
      commitSeen(runDir);
      runCtx.appendRunReport(runDir, { stage: 'poll-journals', result: 'no-new-papers' });
    }
    return;
  }

  if (!commit) {
    console.log('\n[DRY RUN] Pass --commit to write and push changes.');
    if (useScoring) console.log('[DRY RUN] --score flag detected but skipped in dry run.');
    return;
  }

  stageSeen(runDir, seen);

  let papersToAdd = newPapers;

  if (useScoring && newPapers.length > 0) {
    console.log(`\n── Embedding + Ranking ──────────────────`);
    try {
      const { topPapers } = await scorePapersModule.embedAndRank(newPapers);
      const embeddedPath = path.join(runDir, 'embedded-papers.json');
      fs.writeFileSync(embeddedPath, JSON.stringify(topPapers, null, 2));
      console.log(`\nEmbedding complete: ${newPapers.length} → ${topPapers.length} ranked`);
      console.log(`Wrote ${embeddedPath} — score-with-claude.js will handle scoring.`);
      runCtx.appendRunReport(runDir, {
        stage: 'poll-journals',
        result: 'embedded',
        collected: newPapers.length,
        ranked: topPapers.length,
      });
      papersToAdd = null;
    } catch (e) {
      console.error(`Embedding failed: ${e.message}`);
      console.log('Falling back to all collected papers (keyword scoring only).');
      papersToAdd = newPapers;
    }
  }

  if (papersToAdd === null) {
    console.log('\nPapers collected and embedded. score-with-claude.js will complete scoring.');
    return;
  }

  if (papersToAdd.length === 0) {
    console.log('No papers selected for digest after scoring.');
    commitSeen(runDir);
    runCtx.appendRunReport(runDir, { stage: 'poll-journals', result: 'no-papers-to-add' });
    return;
  }

  if (!supabase.isConfigured()) {
    console.error('[Supabase] Not configured — cannot write papers.');
    runCtx.appendRunReport(runDir, { stage: 'poll-journals', result: 'supabase-unconfigured' });
    process.exit(1);
  }
  await supabase.upsertPapers(papersToAdd);
  commitSeen(runDir);
  console.log(`\nWrote ${papersToAdd.length} papers to Supabase`);
  runCtx.appendRunReport(runDir, {
    stage: 'poll-journals',
    result: 'direct-upsert',
    upserted: papersToAdd.length,
  });
}

main().catch(err => { console.error(err); process.exit(1); });
