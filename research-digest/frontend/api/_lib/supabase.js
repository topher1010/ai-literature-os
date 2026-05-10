// api/_lib/supabase.js — shared Supabase REST helpers for Vercel API routes.
//
// Wraps the boilerplate that was duplicated across feedback.js, update-paper.js,
// and remove.js: HTTPS request construction, header set, JSON-on-end response
// shape, and PostgREST filter escaping.

'use strict';

const https = require('https');

function getConfig() {
  return {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_KEY,
  };
}

function isConfigured() {
  const { url, key } = getConfig();
  return Boolean(url && key);
}

// Low-level request: returns { status, body } where body is the raw response
// string. Caller is responsible for JSON.parse — REST endpoints sometimes
// return empty bodies (e.g. with Prefer: return=minimal).
function supabaseRequest(method, urlObj, options = {}) {
  const { key } = getConfig();
  return new Promise((resolve, reject) => {
    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      ...(options.headers || {}),
    };
    if (options.body !== undefined && options.body !== null) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(options.body);
    }
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    if (options.body !== undefined && options.body !== null) req.write(options.body);
    req.end();
  });
}

// PostgREST `in.()` requires double-quoted values for IDs that may contain
// special characters (commas, parens, slashes). DOIs frequently do.
function quoteId(id) {
  return '"' + String(id).replace(/"/g, '\\"') + '"';
}

// Build a fully URL-encoded `field=in.(...)` filter clause. Caller appends
// the result directly into the query string; no further encoding needed.
function inFilter(field, ids) {
  const value = '(' + ids.map(quoteId).join(',') + ')';
  return `${field}=in.${encodeURIComponent(value)}`;
}

// Build a fully URL-encoded `field=eq.value` filter clause.
function eqFilter(field, value) {
  return `${field}=eq.${encodeURIComponent(value)}`;
}

module.exports = {
  getConfig,
  isConfigured,
  supabaseRequest,
  quoteId,
  inFilter,
  eqFilter,
};
