// Tests for digest-run.js — run-scoped artifact + pending-seen helpers.
//
// Uses a real temp directory so we exercise the actual filesystem behavior:
// file creation, JSON round-trip, append semantics, and the contract that
// commitSeen returns false (and writes nothing) when no pending file exists.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runCtx = require('./digest-run');

function makeTempRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'digest-run-test-'));
}

test('writePendingSeen serializes JSON-able payloads', () => {
  const dir = makeTempRunDir();
  runCtx.writePendingSeen(dir, 'pmids', { pmids: ['1', '2', '3'] });
  const written = fs.readFileSync(runCtx.pendingSeenPath(dir, 'pmids'), 'utf8');
  assert.deepEqual(JSON.parse(written), { pmids: ['1', '2', '3'] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitSeen returns false and writes nothing when no pending file exists', () => {
  const dir = makeTempRunDir();
  const finalPath = path.join(dir, 'final', 'seen-pmids.json');
  const result = runCtx.commitSeen(dir, 'pmids', finalPath);
  assert.equal(result, false);
  assert.equal(fs.existsSync(finalPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitSeen copies pending to final and returns true', () => {
  const dir = makeTempRunDir();
  const payload = { pmids: ['12345', '67890'] };
  runCtx.writePendingSeen(dir, 'pmids', payload);

  const finalPath = path.join(dir, 'data', 'seen-pmids.json');
  const result = runCtx.commitSeen(dir, 'pmids', finalPath);

  assert.equal(result, true);
  assert.equal(fs.existsSync(finalPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(finalPath, 'utf8')), payload);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitSeen creates the parent directory of finalPath if missing', () => {
  // Critical for first-time runs where data/ doesn't exist yet.
  const dir = makeTempRunDir();
  runCtx.writePendingSeen(dir, 'grants', { grants: ['G1'] });
  const deepFinal = path.join(dir, 'a', 'b', 'c', 'seen-grants.json');
  assert.equal(runCtx.commitSeen(dir, 'grants', deepFinal), true);
  assert.equal(fs.existsSync(deepFinal), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('appendRunReport creates the file and writes one event', () => {
  const dir = makeTempRunDir();
  runCtx.appendRunReport(dir, { stage: 'test-stage', result: 'success' });
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'run-report.json'), 'utf8'));
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].stage, 'test-stage');
  assert.equal(report.events[0].result, 'success');
  // Each event gets an ISO timestamp from appendRunReport itself.
  assert.match(report.events[0].time, /^\d{4}-\d{2}-\d{2}T/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('appendRunReport appends to an existing file rather than overwriting', () => {
  const dir = makeTempRunDir();
  runCtx.appendRunReport(dir, { stage: 'first', result: 'ok' });
  runCtx.appendRunReport(dir, { stage: 'second', result: 'partial', upserted: 5 });
  runCtx.appendRunReport(dir, { stage: 'third', result: 'abort', reason: 'test' });

  const report = JSON.parse(fs.readFileSync(path.join(dir, 'run-report.json'), 'utf8'));
  assert.equal(report.events.length, 3);
  assert.deepEqual(report.events.map(e => e.stage), ['first', 'second', 'third']);
  // Custom event fields survive.
  assert.equal(report.events[1].upserted, 5);
  assert.equal(report.events[2].reason, 'test');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('appendRunReport recovers from a corrupted run-report.json', () => {
  // If a previous run left a partial/corrupt file, the helper should NOT throw —
  // it should start fresh. (The contract: append events, never crash the run
  // because of a bad report file.)
  const dir = makeTempRunDir();
  fs.writeFileSync(path.join(dir, 'run-report.json'), '{this is not valid json');

  assert.doesNotThrow(() => runCtx.appendRunReport(dir, { stage: 'recovery', result: 'ok' }));
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'run-report.json'), 'utf8'));
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].stage, 'recovery');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('seen-state lifecycle: pending stays uncommitted if commit is never called', () => {
  // This mirrors the "Supabase write failed → exit before commitSeen" flow.
  // The pending file should still exist (so a retry script could pick it up),
  // and the final seen file should remain untouched.
  const dir = makeTempRunDir();
  const finalPath = path.join(dir, 'data', 'seen-pmids.json');
  // Pretend a pre-existing seen file is in place.
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.writeFileSync(finalPath, JSON.stringify({ pmids: ['old-1', 'old-2'] }));

  // Stage a pending update — but do NOT commit (simulating a Supabase failure).
  runCtx.writePendingSeen(dir, 'pmids', { pmids: ['old-1', 'old-2', 'new-3'] });

  // Final file is unchanged.
  const finalContent = JSON.parse(fs.readFileSync(finalPath, 'utf8'));
  assert.deepEqual(finalContent, { pmids: ['old-1', 'old-2'] });
  // Pending file IS present, available for retry inspection.
  assert.equal(fs.existsSync(runCtx.pendingSeenPath(dir, 'pmids')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
