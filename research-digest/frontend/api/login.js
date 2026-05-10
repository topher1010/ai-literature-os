// Vercel Serverless Function: POST /api/login
// Validates admin password and sets auth cookie.

'use strict';

const { makeToken } = require('./_lib/auth');

module.exports = (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { password } = req.body || {};
  const expected = process.env.DIGEST_ADMIN_PASSWORD;

  if (!expected) {
    res.status(500).json({ error: 'Admin password not configured' });
    return;
  }

  if (password !== expected) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const token = makeToken(expected);

  // HttpOnly cookie for API auth + plain cookie for JS UI detection.
  res.setHeader('Set-Cookie', [
    `digest-auth=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    `digest-admin=1; Path=/; Secure; SameSite=Lax; Max-Age=2592000`,
  ]);

  res.status(200).json({ ok: true });
};
