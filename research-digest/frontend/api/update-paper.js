// Vercel Serverless Function: POST /api/update-paper
// Updates paper status fields: vault, summary request, done. Admin auth required.

'use strict';

const { requireAdmin } = require('./_lib/auth');
const { isConfigured, supabaseRequest, eqFilter, getConfig } = require('./_lib/supabase');

const ACTION_MAP = {
  vault: { synced_to_vault: true },
  'request-summary': { wants_deep_summary: true, status: 'summary_pending' },
  'mark-done': { status: 'done' },
  'vault-and-summary': {
    synced_to_vault: true,
    wants_deep_summary: true,
    status: 'summary_pending',
  },
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const expected = process.env.DIGEST_ADMIN_PASSWORD;
  if (!expected) return res.status(500).json({ error: 'Not configured' });
  if (!requireAdmin(req, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { paperId, action } = req.body || {};
  if (!paperId || !action) {
    return res.status(400).json({ error: 'paperId and action required' });
  }

  const fields = ACTION_MAP[action];
  if (!fields) return res.status(400).json({ error: `Unknown action: ${action}` });

  if (!isConfigured()) return res.status(500).json({ error: 'Database not configured' });

  try {
    const { url } = getConfig();
    const filter = eqFilter('paper_id', paperId);
    const target = new URL(`${url}/rest/v1/papers?${filter}`);
    const result = await supabaseRequest('PATCH', target, {
      body: JSON.stringify(fields),
      headers: { Prefer: 'return=minimal' },
    });
    if (result.status >= 300) {
      return res.status(502).json({ error: 'Database update failed', detail: result.body });
    }
    return res.status(200).json({ ok: true, paperId, action, fields });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
