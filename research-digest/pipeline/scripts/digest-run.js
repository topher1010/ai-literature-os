/**
 * digest-run.js — Run-scoped artifact + pending seen-state helpers.
 *
 * Each pipeline run gets its own directory under runs/<timestamp>/.
 * The orchestrator (research-digest.sh) sets DIGEST_RUN_DIR; scripts honor it.
 * If DIGEST_RUN_DIR is unset (ad-hoc invocation), a fresh dir is generated.
 *
 * Pending seen-set pattern: poll-* scripts stage seen-set additions in the run
 * dir; the downstream stage (score-with-claude.js, or the poll-* fallback path)
 * commits them to data/seen-*.json only AFTER Supabase writes succeed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PIPELINE_DIR = path.resolve(__dirname, '..');
const RUNS_ROOT = path.join(PIPELINE_DIR, 'runs');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
         `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function getRunDir() {
  let dir = process.env.DIGEST_RUN_DIR;
  if (!dir) dir = path.join(RUNS_ROOT, timestamp());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pendingSeenPath(runDir, kind) {
  return path.join(runDir, `pending-seen-${kind}.json`);
}

function writePendingSeen(runDir, kind, payload) {
  fs.writeFileSync(pendingSeenPath(runDir, kind), JSON.stringify(payload, null, 2));
}

function commitSeen(runDir, kind, finalPath) {
  const pending = pendingSeenPath(runDir, kind);
  if (!fs.existsSync(pending)) return false;
  const data = fs.readFileSync(pending, 'utf8');
  const dir = path.dirname(finalPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(finalPath, data);
  return true;
}

function appendRunReport(runDir, event) {
  const reportPath = path.join(runDir, 'run-report.json');
  let report = { events: [] };
  try {
    const existing = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (Array.isArray(existing.events)) report = existing;
  } catch { /* fresh report */ }
  report.events.push({ time: new Date().toISOString(), ...event });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

module.exports = {
  getRunDir,
  pendingSeenPath,
  writePendingSeen,
  commitSeen,
  appendRunReport,
};
