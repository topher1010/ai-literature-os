#!/usr/bin/env node
/**
 * score-with-claude.js — LLM scoring + summarization orchestrator.
 *
 * Reads embedding-ranked candidates from $DIGEST_RUN_DIR, scores them via
 * the Claude CLI in batches, applies thresholds, summarizes the survivors,
 * and writes to Supabase. Commits the staged seen-set ONLY after Supabase
 * write succeeds — failed runs leave dedup state untouched.
 *
 * Fail-closed: if scoring or summary failure rate exceeds the configured
 * threshold (DIGEST_SCORING_ABORT_THRESHOLD_PCT / DIGEST_SUMMARY_ABORT_THRESHOLD_PCT,
 * default 50%), the run aborts BEFORE any Supabase write.
 *
 * Usage:
 *   node score-with-claude.js papers   # score $DIGEST_RUN_DIR/embedded-papers.json
 *   node score-with-claude.js grants   # score $DIGEST_RUN_DIR/embedded-grants.json
 *
 * Required env: ANTHROPIC_API_KEY (consumed by Claude CLI), SUPABASE_URL,
 *               SUPABASE_SERVICE_KEY.
 * Optional env: CLAUDE_BIN (default 'claude' on PATH),
 *               DIGEST_SCORING_MODEL (default 'claude-sonnet-4-6').
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const supabase = require('./supabase-client');
const runCtx = require('./digest-run');

const PIPELINE_DIR = path.resolve(__dirname, '..');
const SEEN_PMIDS_PATH  = path.join(PIPELINE_DIR, 'data', 'seen-pmids.json');
const SEEN_GRANTS_PATH = path.join(PIPELINE_DIR, 'data', 'seen-grants.json');

const {
  CONFIG,
  SCORING_PROMPT,
  SUMMARY_PROMPT,
  applyScores,
  selectPapers,
  applySummaries,
  formatScoringBatch,
  formatSummaryBatch,
} = require('./score-papers');

let GRANT_SCORING_PROMPT, GRANT_SUMMARY_PROMPT;
try {
  ({ GRANT_SCORING_PROMPT, GRANT_SUMMARY_PROMPT } = require('./poll-grants'));
} catch { /* grants module not available */ }

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MODEL = process.env.DIGEST_SCORING_MODEL || 'claude-sonnet-4-6';

const SCORING_ABORT_PCT = parseFloat(process.env.DIGEST_SCORING_ABORT_THRESHOLD_PCT || '50');
const SUMMARY_ABORT_PCT = parseFloat(process.env.DIGEST_SUMMARY_ABORT_THRESHOLD_PCT || '50');

// Pure decision function — exported for tests. Returns true if the run should
// abort BEFORE writing anything to Supabase. Zero batches → false (nothing to
// score, not an error). NaN threshold → false (treat as misconfigured = open).
function decideAbort(failedBatches, totalBatches, thresholdPct) {
  if (!Number.isFinite(thresholdPct)) return false;
  if (totalBatches <= 0) return false;
  if (failedBatches <= 0) return false;
  const failurePct = (failedBatches / totalBatches) * 100;
  return failurePct > thresholdPct;
}

function callClaude(prompt, timeoutMs = 120000) {
  const result = execFileSync(CLAUDE_BIN, ['-p', '--model', MODEL], {
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.trim();
}

function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found in response');
  return JSON.parse(raw.slice(start, end + 1));
}

function scoreBatch(batch, scoringPrompt) {
  const formatted = formatScoringBatch(batch);
  const prompt = `${scoringPrompt}\n\nScore these ${batch.length} papers:\n\n${formatted}`;
  const response = callClaude(prompt);
  return extractJSON(response);
}

function summarizeBatch(batch) {
  const formatted = formatSummaryBatch(batch);
  const prompt = `${SUMMARY_PROMPT}\n\nSummarize these ${batch.length} papers:\n\n${formatted}`;
  const response = callClaude(prompt);
  return extractJSON(response);
}

function scoreGrantBatch(batch) {
  if (!GRANT_SCORING_PROMPT) throw new Error('Grant scoring prompt not available');
  const formatted = batch.map((g, i) =>
    `[${i+1}] ID: ${g.id}\nTitle: ${g.title || g.project_title}\nPI: ${g.contact_pi_name || g.pi || 'Unknown'}\nOrg: ${g.organization_name || g.org || ''}\nAbstract: ${(g.abstract_text || g.abstract || '(no abstract)').slice(0, 800)}`
  ).join('\n\n---\n\n');
  const prompt = `${GRANT_SCORING_PROMPT}\n\nScore these ${batch.length} grants:\n\n${formatted}`;
  const response = callClaude(prompt);
  return extractJSON(response);
}

function summarizeGrantBatch(batch) {
  if (!GRANT_SUMMARY_PROMPT) throw new Error('Grant summary prompt not available');
  const formatted = batch.map((g, i) =>
    `[${i+1}] ID: ${g.id}\nTitle: ${g.title || g.project_title}\nPI: ${g.contact_pi_name || g.pi || 'Unknown'}\nOrg: ${g.organization_name || g.org || ''}\nAbstract: ${(g.abstract_text || g.abstract || '').slice(0, 800)}`
  ).join('\n\n---\n\n');
  const prompt = `${GRANT_SUMMARY_PROMPT}\n\nSummarize these ${batch.length} grants:\n\n${formatted}`;
  const response = callClaude(prompt);
  return extractJSON(response);
}

// ── Main: Papers ─────────────────────────────────────────────────────────────

async function scorePapers() {
  const runDir = runCtx.getRunDir();
  const inputFile = path.join(runDir, 'embedded-papers.json');
  if (!fs.existsSync(inputFile)) {
    console.log(`No embedded papers found at ${inputFile} — skipping scoring.`);
    return;
  }

  const papers = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  console.log(`\nLoaded ${papers.length} embedding-ranked papers`);

  const allScores = {};
  const batchSize = CONFIG.scoringBatchSize;
  const totalBatches = Math.ceil(papers.length / batchSize);
  let scoringFailed = 0;

  console.log(`\nScoring ${papers.length} papers in ${totalBatches} batches of ${batchSize}...`);

  for (let i = 0; i < papers.length; i += batchSize) {
    const batch = papers.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    console.log(`  Batch ${batchNum}/${totalBatches} (${batch.length} papers)...`);

    try {
      const scores = scoreBatch(batch, SCORING_PROMPT);
      for (const s of scores) {
        if (s.id) allScores[s.id] = s;
      }
      console.log(`    Got ${scores.length} scores`);
    } catch (err) {
      scoringFailed += 1;
      console.error(`    ERROR in batch ${batchNum}: ${err.message}`);
    }
  }

  console.log(`\nTotal scores collected: ${Object.keys(allScores).length} (${scoringFailed}/${totalBatches} batches failed)`);

  if (decideAbort(scoringFailed, totalBatches, SCORING_ABORT_PCT)) {
    console.error(
      `\n  [Abort] Scoring failure rate ${scoringFailed}/${totalBatches} ` +
      `(${((scoringFailed / totalBatches) * 100).toFixed(1)}%) exceeds threshold ${SCORING_ABORT_PCT}%.`
    );
    runCtx.appendRunReport(runDir, {
      stage: 'score-with-claude',
      kind: 'papers',
      result: 'abort',
      reason: 'scoring_failure_rate',
      candidates: papers.length,
      scoringBatches: totalBatches,
      scoringFailed,
      thresholdPct: SCORING_ABORT_PCT,
    });
    process.exit(1);
  }

  const scored = applyScores(papers, allScores);
  const { selected, mainCount, wildcardCount } = selectPapers(scored);
  console.log(`Selected ${selected.length} papers (${mainCount} main + ${wildcardCount} wildcards)`);

  const allSummaries = {};
  const summaryBatchSize = CONFIG.summaryBatchSize;
  const summaryBatches = Math.ceil(selected.length / summaryBatchSize);
  let summaryFailed = 0;

  console.log(`\nSummarizing ${selected.length} papers in ${summaryBatches} batches...`);

  for (let i = 0; i < selected.length; i += summaryBatchSize) {
    const batch = selected.slice(i, i + summaryBatchSize);
    const batchNum = Math.floor(i / summaryBatchSize) + 1;
    console.log(`  Summary batch ${batchNum}/${summaryBatches}...`);

    try {
      const summaries = summarizeBatch(batch);
      for (const s of summaries) {
        if (s.id) allSummaries[s.id] = s;
      }
    } catch (err) {
      summaryFailed += 1;
      console.error(`    ERROR in summary batch ${batchNum}: ${err.message}`);
    }
  }

  if (decideAbort(summaryFailed, summaryBatches, SUMMARY_ABORT_PCT)) {
    console.error(
      `\n  [Abort] Summary failure rate ${summaryFailed}/${summaryBatches} ` +
      `(${((summaryFailed / summaryBatches) * 100).toFixed(1)}%) exceeds threshold ${SUMMARY_ABORT_PCT}%.`
    );
    runCtx.appendRunReport(runDir, {
      stage: 'score-with-claude',
      kind: 'papers',
      result: 'abort',
      reason: 'summary_failure_rate',
      candidates: papers.length,
      selected: selected.length,
      summaryBatches,
      summaryFailed,
      thresholdPct: SUMMARY_ABORT_PCT,
    });
    process.exit(1);
  }

  const finalPapers = applySummaries(selected, allSummaries);

  if (!supabase.isConfigured()) {
    console.error('\n  [Supabase] Not configured — cannot write papers. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
    runCtx.appendRunReport(runDir, { stage: 'score-with-claude', kind: 'papers', result: 'supabase-unconfigured' });
    process.exit(1);
  }
  await supabase.upsertPapers(finalPapers);
  const committed = runCtx.commitSeen(runDir, 'pmids', SEEN_PMIDS_PATH);
  const partial = scoringFailed > 0 || summaryFailed > 0;
  console.log(
    `\nWrote ${finalPapers.length} new papers to Supabase` +
    (committed ? ' (seen-set committed)' : '') +
    (partial ? ' [partial — see run-report]' : '')
  );
  runCtx.appendRunReport(runDir, {
    stage: 'score-with-claude',
    kind: 'papers',
    result: partial ? 'partial' : 'success',
    candidates: papers.length,
    scoringBatches: totalBatches,
    scoringFailed,
    selected: selected.length,
    summaryBatches,
    summaryFailed,
    upserted: finalPapers.length,
    seenCommitted: committed,
  });
}

// ── Main: Grants ─────────────────────────────────────────────────────────────

async function scoreGrants() {
  const runDir = runCtx.getRunDir();
  const inputFile = path.join(runDir, 'embedded-grants.json');
  if (!fs.existsSync(inputFile)) {
    console.log(`No embedded grants found at ${inputFile} — skipping scoring.`);
    return;
  }

  const grants = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  console.log(`\nLoaded ${grants.length} embedding-ranked grants`);

  const allScores = {};
  const batchSize = CONFIG.scoringBatchSize;
  const totalBatches = Math.ceil(grants.length / batchSize);
  let scoringFailed = 0;

  console.log(`\nScoring ${grants.length} grants in ${totalBatches} batches of ${batchSize}...`);

  for (let i = 0; i < grants.length; i += batchSize) {
    const batch = grants.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    console.log(`  Batch ${batchNum}/${totalBatches} (${batch.length} grants)...`);

    try {
      const scores = scoreGrantBatch(batch);
      for (const s of scores) {
        if (s.id) allScores[s.id] = s;
      }
    } catch (err) {
      scoringFailed += 1;
      console.error(`    ERROR in batch ${batchNum}: ${err.message}`);
    }
  }

  if (decideAbort(scoringFailed, totalBatches, SCORING_ABORT_PCT)) {
    console.error(
      `\n  [Abort] Grant scoring failure rate ${scoringFailed}/${totalBatches} ` +
      `(${((scoringFailed / totalBatches) * 100).toFixed(1)}%) exceeds threshold ${SCORING_ABORT_PCT}%.`
    );
    runCtx.appendRunReport(runDir, {
      stage: 'score-with-claude',
      kind: 'grants',
      result: 'abort',
      reason: 'scoring_failure_rate',
      candidates: grants.length,
      scoringBatches: totalBatches,
      scoringFailed,
      thresholdPct: SCORING_ABORT_PCT,
    });
    process.exit(1);
  }

  const scored = grants.map(g => {
    const s = allScores[g.id];
    if (!s) return { ...g, scoringMethod: 'embedding-only' };
    const combined = CONFIG.combinedWeight.relevance * s.relevance + CONFIG.combinedWeight.surprise * s.surprise;
    return {
      ...g,
      sonnetRelevance: s.relevance,
      sonnetSurprise: s.surprise,
      sonnetCombined: parseFloat(combined.toFixed(2)),
      sonnetReason: s.reason,
      scoringMethod: 'full',
    };
  });

  const grantThreshold = parseFloat(process.env.DIGEST_GRANT_RELEVANCE_THRESHOLD || '5.0');
  const selected = scored.filter(g => (g.sonnetRelevance || 0) >= grantThreshold);
  selected.sort((a, b) => (b.sonnetCombined || 0) - (a.sonnetCombined || 0));

  for (const g of selected) {
    const c = g.sonnetCombined || 0;
    if (c >= 6.0)      g.relevance = 'high';
    else if (c >= 4.5) g.relevance = 'medium';
    else               g.relevance = 'low';
  }

  console.log(`Selected ${selected.length} grants (relevance >= ${grantThreshold})`);

  const allSummaries = {};
  const summaryBatchSize = CONFIG.summaryBatchSize;
  const summaryBatches = Math.ceil(selected.length / summaryBatchSize);
  let summaryFailed = 0;

  console.log(`\nSummarizing ${selected.length} grants in ${summaryBatches} batches...`);

  for (let i = 0; i < selected.length; i += summaryBatchSize) {
    const batch = selected.slice(i, i + summaryBatchSize);
    const batchNum = Math.floor(i / summaryBatchSize) + 1;
    console.log(`  Summary batch ${batchNum}/${summaryBatches}...`);

    try {
      const summaries = summarizeGrantBatch(batch);
      for (const s of summaries) {
        if (s.id) allSummaries[s.id] = { summary: s.summary, whyItMatters: s.whyItMatters };
      }
    } catch (err) {
      summaryFailed += 1;
      console.error(`    ERROR in summary batch ${batchNum}: ${err.message}`);
    }
  }

  if (decideAbort(summaryFailed, summaryBatches, SUMMARY_ABORT_PCT)) {
    console.error(
      `\n  [Abort] Grant summary failure rate ${summaryFailed}/${summaryBatches} ` +
      `(${((summaryFailed / summaryBatches) * 100).toFixed(1)}%) exceeds threshold ${SUMMARY_ABORT_PCT}%.`
    );
    runCtx.appendRunReport(runDir, {
      stage: 'score-with-claude',
      kind: 'grants',
      result: 'abort',
      reason: 'summary_failure_rate',
      candidates: grants.length,
      selected: selected.length,
      summaryBatches,
      summaryFailed,
      thresholdPct: SUMMARY_ABORT_PCT,
    });
    process.exit(1);
  }

  for (const g of selected) {
    if (allSummaries[g.id]) {
      g.aiSummary = allSummaries[g.id].summary;
      g.whyItMatters = allSummaries[g.id].whyItMatters;
    }
  }

  const partial = scoringFailed > 0 || summaryFailed > 0;

  if (selected.length === 0) {
    console.log('\nNo grants passed scoring threshold');
    const committed = runCtx.commitSeen(runDir, 'grants', SEEN_GRANTS_PATH);
    runCtx.appendRunReport(runDir, {
      stage: 'score-with-claude',
      kind: 'grants',
      result: 'no-grants-passed-threshold',
      candidates: grants.length,
      scoringBatches: totalBatches,
      scoringFailed,
      seenCommitted: committed,
    });
  } else {
    if (!supabase.isConfigured()) {
      console.error('\n  [Supabase] Not configured — cannot write grants. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
      runCtx.appendRunReport(runDir, { stage: 'score-with-claude', kind: 'grants', result: 'supabase-unconfigured' });
      process.exit(1);
    }
    await supabase.upsertGrants(selected);
    const committed = runCtx.commitSeen(runDir, 'grants', SEEN_GRANTS_PATH);
    console.log(
      `\nWrote ${selected.length} grants to Supabase` +
      (committed ? ' (seen-set committed)' : '') +
      (partial ? ' [partial — see run-report]' : '')
    );
    runCtx.appendRunReport(runDir, {
      stage: 'score-with-claude',
      kind: 'grants',
      result: partial ? 'partial' : 'success',
      candidates: grants.length,
      scoringBatches: totalBatches,
      scoringFailed,
      selected: selected.length,
      summaryBatches,
      summaryFailed,
      upserted: selected.length,
      seenCommitted: committed,
    });
  }
}

if (require.main === module) {
  const mode = process.argv[2];
  if (mode === 'papers') {
    scorePapers().catch(err => { console.error(err); process.exit(1); });
  } else if (mode === 'grants') {
    scoreGrants().catch(err => { console.error(err); process.exit(1); });
  } else {
    console.error('Usage: node score-with-claude.js <papers|grants>');
    process.exit(1);
  }
}

module.exports = { decideAbort };
