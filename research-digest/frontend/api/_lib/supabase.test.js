// Tests for api/_lib/supabase.js — pure-function helpers only.
// supabaseRequest itself is not tested here (would require a network mock);
// the routes are exercised end-to-end via the Vercel deploy + Sunday cron.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { quoteId, inFilter, eqFilter } = require('./supabase');

test('quoteId wraps simple values in double quotes', () => {
  assert.equal(quoteId('abc'), '"abc"');
  assert.equal(quoteId('12345'), '"12345"');
});

test('quoteId escapes embedded double quotes', () => {
  assert.equal(quoteId('he said "hi"'), '"he said \\"hi\\""');
});

test('quoteId stringifies non-string ids', () => {
  assert.equal(quoteId(42), '"42"');
});

test('inFilter produces a PostgREST in.() clause with url-encoded inner values', () => {
  // encodeURIComponent does NOT encode `(` and `)` per RFC 3986 — parens are
  // valid URI characters and PostgREST treats them as the in.() delimiter
  // literally. Inner `"` (the value-quoting) and `,` (the value separator)
  // ARE encoded, so a quoted id with a literal comma round-trips correctly.
  const out = inFilter('paper_id', ['a', 'b']);
  assert.equal(out, 'paper_id=in.(%22a%22%2C%22b%22)');
});

test('inFilter encodes DOI-shaped ids with slashes intact', () => {
  // Slashes get %2F-encoded; dots survive unencoded (dot is not in the encode set).
  const out = inFilter('paper_id', ['10.1016/j.cmet.2026.03.016']);
  assert.match(out, /^paper_id=in\.\(%22/);
  assert.match(out, /016%22\)$/);
  assert.ok(out.includes('%2F'), 'expected slash to be %2F-encoded');
  assert.ok(out.includes('.'), 'dots stay unencoded');
});

test('inFilter handles ids that contain commas (would otherwise break in.())', () => {
  // Without quoting + encoding, a comma in an id would split into two filter
  // values. The inner `,` is inside the quoted id and gets %2C-encoded so
  // PostgREST treats it as part of the value rather than the separator.
  const out = inFilter('paper_id', ['a,b', 'c']);
  assert.equal(out, 'paper_id=in.(%22a%2Cb%22%2C%22c%22)');
});

test('inFilter handles ids containing quotes by escaping', () => {
  const out = inFilter('paper_id', ['weird"id']);
  // Inner `"` is backslash-escaped first, then both backslash and quote get
  // URL-encoded: \ → %5C, " → %22.
  assert.match(out, /%5C%22/);
});

test('eqFilter produces a URL-encoded eq. clause', () => {
  assert.equal(eqFilter('paper_id', 'abc'), 'paper_id=eq.abc');
  assert.equal(eqFilter('paper_id', 'a/b'), 'paper_id=eq.a%2Fb');
  assert.equal(eqFilter('paper_id', 'has space'), 'paper_id=eq.has%20space');
});
