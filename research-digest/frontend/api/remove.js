// Vercel Serverless Function: POST /api/remove
// Removes saved papers from Supabase (admin only).

'use strict';

const { requireAdmin } = require('./_lib/auth');
const { isConfigured, supabaseRequest, inFilter, getConfig } = require('./_lib/supabase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expected = process.env.DIGEST_ADMIN_PASSWORD;
  if (!expected) return res.status(500).json({ error: 'Not configured' });
  if (!requireAdmin(req, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { paperIds } = req.body || {};
  if (!Array.isArray(paperIds) || paperIds.length === 0) {
    return res.status(400).json({ error: 'No papers specified' });
  }

  if (!isConfigured()) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const { url } = getConfig();
    const filter = inFilter('paper_id', paperIds);
    const target = new URL(`${url}/rest/v1/papers?${filter}`);
    const dbResp = await supabaseRequest('DELETE', target, {
      headers: { Prefer: 'return=representation' },
    });

    if (dbResp.status >= 300) {
      return res.status(502).json({ error: 'Delete failed', detail: dbResp.body });
    }

    const deleted = JSON.parse(dbResp.body || '[]');
    return res.status(200).json({ ok: true, removed: deleted.length });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
