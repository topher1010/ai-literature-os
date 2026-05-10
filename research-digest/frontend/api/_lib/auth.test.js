// Tests for api/_lib/auth.js — run via `npm test` (node --test).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeToken, parseCookies, tokensMatch, requireAdmin } = require('./auth');

test('makeToken is deterministic for a given password', () => {
  const a = makeToken('hunter2');
  const b = makeToken('hunter2');
  assert.equal(a, b);
  assert.equal(a.length, 32);
});

test('makeToken returns different tokens for different passwords', () => {
  assert.notEqual(makeToken('a'), makeToken('b'));
});

test('parseCookies handles missing or empty header', () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(''), {});
});

test('parseCookies splits on semicolons and trims whitespace', () => {
  const out = parseCookies('foo=1; bar=two ; baz=three');
  assert.deepEqual(out, { foo: '1', bar: 'two', baz: 'three' });
});

test('parseCookies preserves equals signs inside cookie values', () => {
  // HMAC tokens don't contain `=`, but encoded values (base64, JWT) often do.
  const out = parseCookies('digest-auth=abc=def=ghi');
  assert.equal(out['digest-auth'], 'abc=def=ghi');
});

test('tokensMatch returns true for identical strings', () => {
  assert.equal(tokensMatch('aaaa', 'aaaa'), true);
});

test('tokensMatch returns false for different strings of same length', () => {
  assert.equal(tokensMatch('aaaa', 'aaab'), false);
});

test('tokensMatch returns false for different-length strings without throwing', () => {
  // Different-length buffers cannot be timing-safe-compared; the helper must
  // handle that itself rather than throw.
  assert.doesNotThrow(() => tokensMatch('a', 'aaaa'));
  assert.equal(tokensMatch('a', 'aaaa'), false);
  assert.equal(tokensMatch('', 'a'), false);
  assert.equal(tokensMatch('a', ''), false);
});

test('tokensMatch handles null/undefined inputs', () => {
  assert.equal(tokensMatch(null, 'a'), false);
  assert.equal(tokensMatch(undefined, undefined), true); // both empty buffers
});

test('requireAdmin rejects when password env unset', () => {
  const req = { headers: { cookie: 'digest-auth=anything' } };
  assert.equal(requireAdmin(req, undefined), false);
  assert.equal(requireAdmin(req, ''), false);
});

test('requireAdmin rejects when cookie missing', () => {
  const req = { headers: {} };
  assert.equal(requireAdmin(req, 'hunter2'), false);
});

test('requireAdmin rejects when cookie token is wrong', () => {
  const req = { headers: { cookie: 'digest-auth=wrong' } };
  assert.equal(requireAdmin(req, 'hunter2'), false);
});

test('requireAdmin accepts when cookie token matches makeToken(password)', () => {
  const password = 'hunter2';
  const validToken = makeToken(password);
  const req = { headers: { cookie: `digest-auth=${validToken}` } };
  assert.equal(requireAdmin(req, password), true);
});

test('requireAdmin handles missing headers object', () => {
  // Vercel always provides headers, but a defensive check shouldn't crash.
  assert.equal(requireAdmin({}, 'hunter2'), false);
});
