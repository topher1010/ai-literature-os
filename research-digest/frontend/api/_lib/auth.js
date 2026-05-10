// api/_lib/auth.js — shared admin auth helpers for Vercel API routes.
//
// Underscore-prefixed directory: Vercel excludes it from the serverless
// function build, so this file is importable from sibling api/*.js routes
// but not exposed as its own endpoint.

'use strict';

const crypto = require('crypto');

function makeToken(password) {
  return crypto
    .createHmac('sha256', password)
    .update('digest-admin')
    .digest('hex')
    .slice(0, 32);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach((c) => {
    const [k, ...v] = c.trim().split('=');
    cookies[k] = v.join('=');
  });
  return cookies;
}

// Constant-time HMAC comparison. Strings of different length aren't comparable
// with timingSafeEqual, so we always feed it equal-length buffers; if the
// candidate string is the wrong length, that's still a fail (and the compare
// itself runs over a fixed-length zero buffer to keep timing uniform).
function tokensMatch(a, b) {
  const aBuf = Buffer.from(a || '', 'utf8');
  const bBuf = Buffer.from(b || '', 'utf8');
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// Returns true if the request has a valid admin cookie.
// Returns false if not configured (caller should 500) or if invalid (caller should 401).
function requireAdmin(req, expectedPassword) {
  if (!expectedPassword) return false;
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return tokensMatch(cookies['digest-auth'], makeToken(expectedPassword));
}

module.exports = { makeToken, parseCookies, tokensMatch, requireAdmin };
