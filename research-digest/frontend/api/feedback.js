// Vercel Serverless Function: POST /api/feedback
// Validates admin auth, queries digest_papers by paper_id, copies selected
// rows into the saved-library `papers` table, and logs a feedback event.

'use strict';

const { requireAdmin } = require('./_lib/auth');
const {
  isConfigured,
  supabaseRequest,
  inFilter,
  getConfig,
} = require('./_lib/supabase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expected = process.env.DIGEST_ADMIN_PASSWORD;
  if (!expected) return res.status(500).json({ error: 'Not configured' });
  if (!requireAdmin(req, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { selected, shown } = req.body || {};
  if (!Array.isArray(selected) || selected.length === 0) {
    return res.status(400).json({ error: 'No papers selected' });
  }

  if (!isConfigured()) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const { url } = getConfig();

    // Look up the canonical digest_papers rows for the selected paper_ids.
    const digestUrl = new URL(
      `${url}/rest/v1/digest_papers?select=*&${inFilter('paper_id', selected)}`
    );
    const digestResp = await supabaseRequest('GET', digestUrl);

    if (digestResp.status >= 300) {
      console.error('Failed to query digest_papers:', digestResp.status, digestResp.body);
      return res.status(502).json({ error: 'Failed to look up papers' });
    }

    const digestPapers = JSON.parse(digestResp.body || '[]');
    const papersMap = {};
    digestPapers.forEach((p) => {
      if (p.paper_id) papersMap[p.paper_id] = p;
    });

    // Build rows for the saved-library `papers` table.
    const now = new Date().toISOString();
    const week = getISOWeek(new Date());
    const rows = [];

    for (const id of selected) {
      const p = papersMap[id];
      // Unknown paper_ids (e.g. an old browser tab from before the stable-ID
      // migration) are skipped rather than fabricating rows with title="Unknown".
      if (!p || !p.paper_id) continue;

      // The library `papers.paper_id` historically held raw PMID/DOI rather
      // than the slugified digest_papers.paper_id. Preserve that format on
      // the write path so upserts de-duplicate against existing library rows.
      // See docs/Supabase-Backend-Migration.md § Schema.
      const libraryPaperId = p.pmid || p.doi || p.paper_id;
      if (!libraryPaperId) continue;

      rows.push({
        paper_id: libraryPaperId,
        pmid: p.pmid || null,
        doi: p.doi || null,
        title: p.title || 'Unknown',
        authors: Array.isArray(p.authors) ? p.authors.join(', ') : p.authors || null,
        journal: p.journal || null,
        pub_date: p.pub_date || null,
        abstract: p.abstract || null,
        ai_summary: p.ai_summary || null,
        why_it_matters: p.why_it_matters || null,
        relevance_score: p.sonnet_relevance || null,
        surprise_score: p.sonnet_surprise || null,
        combined_score: p.sonnet_combined || null,
        status: 'selected',
        selected_date: now,
        batch_week: week,
        full_summary: p.full_summary || null,
      });
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: 'No papers to save' });
    }

    // Upsert into `papers` using paper_id as the conflict key.
    const upsertUrl = new URL(`${url}/rest/v1/papers?on_conflict=paper_id`);
    const dbResp = await supabaseRequest('POST', upsertUrl, {
      body: JSON.stringify(rows),
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    });

    if (dbResp.status >= 300) {
      console.error('Supabase error:', dbResp.status, dbResp.body);
      return res.status(502).json({ error: 'Database write failed', detail: dbResp.body });
    }

    const savedRows = JSON.parse(dbResp.body || '[]');

    // Log the feedback event (positive: selected, negative: shown-but-not-selected).
    // Column names retain `_pmids` for schema compatibility; values are paper_ids
    // since the 2026-04-26 stable-ID migration. Future schema rename is harmless.
    const eventUrl = new URL(`${url}/rest/v1/feedback_events`);
    const eventBody = JSON.stringify({
      selected_pmids: selected,
      shown_pmids: shown || [],
      batch_week: week,
      total_selected: selected.length,
      total_shown: (shown || []).length,
    });
    await supabaseRequest('POST', eventUrl, {
      body: eventBody,
      headers: { Prefer: 'return=minimal' },
    }).catch(() => {}); // non-fatal

    return res.status(200).json({
      ok: true,
      papersSubmitted: selected.length,
      savedToDatabase: savedRows.length,
    });
  } catch (err) {
    console.error('Feedback error:', err.message, err.stack);
    return res.status(502).json({ error: 'Internal error', detail: err.message });
  }
};

function getISOWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum =
    1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}
