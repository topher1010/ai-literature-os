// Tests for score-with-claude.js — exercises the pure decideAbort() helper.
//
// The full scoring pipeline isn't tested here: it requires the Claude CLI,
// a Supabase connection, and live PubMed data. The threshold-decision logic
// IS pure and IS exhaustively tested below — that's the part most likely to
// regress and the part whose correctness gates whether a partial run lands
// in Supabase or aborts cleanly.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideAbort } = require('./score-with-claude');

test('returns false when no batches ran (zero-batch run is not a failure)', () => {
  assert.equal(decideAbort(0, 0, 50), false);
});

test('returns false when no batches failed', () => {
  assert.equal(decideAbort(0, 10, 50), false);
});

test('returns false when failure rate equals the threshold (strict greater-than)', () => {
  // 50% failure with 50% threshold → continue. Threshold is the cap, not the trigger.
  assert.equal(decideAbort(5, 10, 50), false);
});

test('returns true when failure rate exceeds the threshold', () => {
  assert.equal(decideAbort(6, 10, 50), true);
  assert.equal(decideAbort(10, 10, 50), true);
});

test('respects custom thresholds', () => {
  // Tight threshold (10%): one failure in ten triggers abort? 1/10 = 10%, not > 10% → continue.
  assert.equal(decideAbort(1, 10, 10), false);
  // 2/10 = 20% > 10% → abort.
  assert.equal(decideAbort(2, 10, 10), true);

  // Loose threshold (90%): even 80% failure continues.
  assert.equal(decideAbort(8, 10, 90), false);
  // 10/10 = 100% > 90% → abort.
  assert.equal(decideAbort(10, 10, 90), true);
});

test('handles single-batch runs', () => {
  // Either fully succeeds or fully fails — at any reasonable threshold (<100),
  // a single failed batch is 100% failure → abort.
  assert.equal(decideAbort(0, 1, 50), false);
  assert.equal(decideAbort(1, 1, 50), true);
  assert.equal(decideAbort(1, 1, 99), true);
  // Threshold ≥100 means "never abort" — only a value strictly greater than
  // 100% would trigger, which is impossible.
  assert.equal(decideAbort(1, 1, 100), false);
});

test('treats NaN threshold as misconfigured = open (don\'t abort)', () => {
  // If env var is malformed (DIGEST_SCORING_ABORT_THRESHOLD_PCT="abc"),
  // parseFloat returns NaN. Better to continue than to silently abort
  // every run because of a typo in env config.
  assert.equal(decideAbort(10, 10, NaN), false);
  assert.equal(decideAbort(0, 0, NaN), false);
});

test('treats negative or undefined inputs defensively', () => {
  // These shouldn't happen in normal operation, but the helper shouldn't crash.
  assert.equal(decideAbort(-1, 10, 50), false);
  assert.equal(decideAbort(5, -1, 50), false); // totalBatches <= 0
  assert.equal(decideAbort(0, 0, 50), false);
});
