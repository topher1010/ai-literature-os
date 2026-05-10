/* ── Research Digest — app.js ── */

const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

let allPapers = [];
let activeFilter = 'All';
let selectedPaperIds = new Set();
let isAdmin = false;
let savedPaperIds = new Set(); // papers already saved to library

// Stable identifier for a paper. Prefer the canonical paper_id from digest_papers;
// fall back to PMID or DOI for legacy rows that predate paper_id.
function paperId(p) {
  return p.paper_id || p.pmid || p.doi || '';
}

async function loadSavedPaperIds() {
  // Load paper_id + pmid + doi from the library. Library rows historically use
  // raw PMID/DOI as paper_id, while digest_papers uses a slugified form
  // (pmid_12345, doi-with-slashes-replaced). To make the "Saved" badge work
  // across both formats, we add every identifier from each library row to the
  // Set and check against any of the digest card's identifiers.
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/papers?select=paper_id,pmid,doi',
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
        }
      }
    );
    if (res.ok) {
      const rows = await res.json();
      rows.forEach(r => {
        if (r.paper_id) savedPaperIds.add(String(r.paper_id));
        if (r.pmid) savedPaperIds.add(String(r.pmid));
        if (r.doi) savedPaperIds.add(String(r.doi));
      });
    }
  } catch (e) { /* non-fatal */ }
}

async function init() {
  // Check admin cookie
  isAdmin = document.cookie.split(';').some(c => c.trim().startsWith('digest-admin='));

  // Load saved paper IDs and digest_papers from Supabase in parallel
  const [_, papersRes] = await Promise.all([
    loadSavedPaperIds(),
    fetch(
      SUPABASE_URL + '/rest/v1/digest_papers?select=*&order=sonnet_combined.desc.nullslast,added_date.desc',
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
        }
      }
    )
  ]);
  allPapers = await papersRes.json();

  // Filter out reviewed batches
  const reviewed = JSON.parse(localStorage.getItem('reviewedBatches') || '[]');
  allPapers = allPapers.filter(p => !reviewed.includes(p.batch));

  renderMeta();
  renderFilters();
  renderPapers(allPapers);

  if (isAdmin) {
    document.body.classList.add('admin-mode');
    renderDownloadBar();
    const loginBtn = document.getElementById('admin-login-btn');
    loginBtn.textContent = 'Logout';
    loginBtn.title = 'Logged in as admin — click to logout';
  }

  // Delegated checkbox listener (admin only)
  document.getElementById('papers').addEventListener('change', e => {
    if (!isAdmin) return;
    if (e.target.classList.contains('paper-checkbox')) {
      togglePaper(e.target.dataset.paperId, e.target.checked);
    }
  });

  // Delegated "Why this?" toggle
  document.getElementById('papers').addEventListener('click', e => {
    const btn = e.target.closest('.why-btn');
    if (!btn) return;
    const wrap = btn.closest('.why-wrap');
    const text = wrap.querySelector('.why-text');
    const isHidden = text.classList.toggle('hidden');
    btn.textContent = isHidden ? 'Why this? \u25BE' : 'Why this? \u25B4';
  });

  // Delegated "Abstract" toggle
  document.getElementById('papers').addEventListener('click', e => {
    const btn = e.target.closest('.abstract-btn');
    if (!btn) return;
    const wrap = btn.closest('.abstract-wrap');
    const text = wrap.querySelector('.abstract-text');
    const isHidden = text.classList.toggle('hidden');
    btn.textContent = isHidden ? 'Read Abstract \u25BE' : 'Hide Abstract \u25B4';
  });

  // Delegated "Full summary" toggle
  document.getElementById('papers').addEventListener('click', e => {
    const btn = e.target.closest('.summary-toggle');
    if (!btn) return;
    const wrap = btn.closest('.summary-wrap');
    const text = wrap.querySelector('.summary-content');
    const isHidden = text.classList.toggle('hidden');
    btn.textContent = isHidden ? 'Read summary \u25BE' : 'Hide summary \u25B4';
  });

  // Batch dismiss (two-step confirmation)
  document.getElementById('papers').addEventListener('click', e => {
    const btn = e.target.closest('.batch-dismiss');
    if (!btn || !isAdmin) return;

    const batch = btn.dataset.batch;

    if (btn.dataset.confirming) {
      // Second click — do it
      dismissBatch(batch, btn);
    } else {
      // First click — ask for confirmation
      btn.dataset.confirming = 'true';
      btn.textContent = '';
      const span = document.createElement('span');
      span.style.color = 'var(--error)';
      span.textContent = 'Remove this batch? ';
      const strong = document.createElement('strong');
      strong.textContent = 'Confirm';
      const sep = document.createTextNode(' \u00B7 ');
      const em = document.createElement('em');
      em.textContent = 'Cancel';
      btn.append(span, strong, sep, em);

      // Cancel on click outside or explicit cancel
      const cancel = () => {
        delete btn.dataset.confirming;
        btn.textContent = 'Done reviewing';
      };

      btn.addEventListener('click', function handler(ev) {
        if (ev.target.tagName === 'EM') {
          ev.stopPropagation();
          cancel();
          btn.removeEventListener('click', handler);
        }
      });

      // Auto-cancel after 5 seconds
      setTimeout(() => {
        if (btn.dataset.confirming) cancel();
      }, 5000);
    }
  });

  // Login modal
  setupLoginModal();
}

// ── Auth ───────────────────────────────────────────────────────────────────────

function setupLoginModal() {
  const loginBtn = document.getElementById('admin-login-btn');
  const modal = document.getElementById('login-modal');
  const form = document.getElementById('login-form');
  const cancel = document.getElementById('login-cancel');
  const pwInput = document.getElementById('login-password');
  const errEl = document.getElementById('login-error');

  loginBtn.addEventListener('click', () => {
    if (isAdmin) {
      // Logout
      fetch('/api/logout', { method: 'POST' }).then(() => location.reload());
    } else {
      modal.classList.remove('hidden');
      pwInput.focus();
    }
  });

  cancel.addEventListener('click', () => {
    modal.classList.add('hidden');
    errEl.classList.add('hidden');
    pwInput.value = '';
  });

  modal.addEventListener('click', e => {
    if (e.target === modal) {
      modal.classList.add('hidden');
      errEl.classList.add('hidden');
      pwInput.value = '';
    }
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    errEl.classList.add('hidden');
    const password = pwInput.value;

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      if (res.ok) {
        location.reload();
      } else {
        errEl.classList.remove('hidden');
        pwInput.value = '';
        pwInput.focus();
      }
    } catch {
      errEl.textContent = 'Connection error';
      errEl.classList.remove('hidden');
    }
  });
}

function renderMeta() {
  const el = document.getElementById('hero-stats');
  if (!el) return;
  const count = allPapers.length;
  const aiScored = allPapers.filter(p => p.sonnet_relevance != null).length;
  const summarized = allPapers.filter(p => p.full_summary).length;
  // Derive "updated" from most recent added_date
  const dates = allPapers.map(p => p.added_date).filter(Boolean).sort();
  const latest = dates.length > 0 ? dates[dates.length - 1] : null;
  const updated = latest ? new Date(latest).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  }) : '';

  // Build stat chips via DOM
  el.textContent = '';
  const addChip = (text, cls) => {
    const span = document.createElement('span');
    span.className = 'stat-chip' + (cls ? ' ' + cls : '');
    span.textContent = text;
    el.appendChild(span);
  };
  addChip(count + ' papers');
  if (updated) addChip('Updated ' + updated);
  if (aiScored > 0) addChip(aiScored + ' AI-scored', 'ai-scored');
  if (summarized > 0) addChip(summarized + ' summarized', 'summarized');
}

function renderFilters() {
  const tagCounts = {};
  allPapers.forEach(p => (p.tags || []).forEach(t => {
    tagCounts[t] = (tagCounts[t] || 0) + 1;
  }));

  const tags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);

  const container = document.getElementById('filters');
  ['All', ...tags].forEach(tag => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn' + (tag === 'All' ? ' active' : '');
    btn.textContent = tag === 'All' ? 'All papers' : tag;
    btn.addEventListener('click', () => {
      activeFilter = tag;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderPapers(activeFilter === 'All'
        ? allPapers
        : allPapers.filter(p => (p.tags || []).includes(activeFilter)));
    });
    container.appendChild(btn);
  });
}

function renderDownloadBar() {
  const bar = document.createElement('div');
  bar.id = 'download-bar';
  bar.className = 'download-bar hidden';

  const countSpan = document.createElement('span');
  countSpan.id = 'selected-count';
  countSpan.textContent = '0 selected';
  bar.appendChild(countSpan);

  const actions = document.createElement('div');
  actions.className = 'bar-actions';

  const clearBtn = document.createElement('button');
  clearBtn.className = 'bar-btn secondary';
  clearBtn.id = 'clear-btn';
  clearBtn.textContent = 'Clear';

  const risBtn = document.createElement('button');
  risBtn.className = 'bar-btn primary';
  risBtn.id = 'ris-btn';
  risBtn.textContent = 'Download RIS';

  const feedbackBtn = document.createElement('button');
  feedbackBtn.className = 'bar-btn feedback';
  feedbackBtn.id = 'feedback-btn';
  feedbackBtn.textContent = 'Save Papers';

  actions.append(clearBtn, risBtn, feedbackBtn);
  bar.appendChild(actions);
  document.body.appendChild(bar);

  risBtn.addEventListener('click', downloadRIS);
  clearBtn.addEventListener('click', clearSelection);
  feedbackBtn.addEventListener('click', submitFeedback);
}

function updateDownloadBar() {
  const bar = document.getElementById('download-bar');
  if (!bar) return;
  const count = selectedPaperIds.size;
  document.getElementById('selected-count').textContent =
    count === 1 ? '1 paper selected' : count + ' papers selected';
  bar.classList.toggle('hidden', count === 0);
}

function clearSelection() {
  selectedPaperIds.clear();
  document.querySelectorAll('.paper-checkbox').forEach(cb => cb.checked = false);
  document.querySelectorAll('.paper-card').forEach(c => c.classList.remove('selected'));
  updateDownloadBar();
}

function togglePaper(pid, checked) {
  if (checked) selectedPaperIds.add(pid);
  else selectedPaperIds.delete(pid);
  const card = document.querySelector('[data-paper-id="' + pid + '"]');
  if (card) card.classList.toggle('selected', checked);
  updateDownloadBar();
}

// ── RIS Download ───────────────────────────────────────────────────────────────

function downloadRIS() {
  const papers = allPapers.filter(p => selectedPaperIds.has(paperId(p)));
  const ris = papers.map(toRIS).join('\n');
  const blob = new Blob([ris], { type: 'application/x-research-info-systems' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'digest-' + new Date().toISOString().slice(0,10) + '.ris';
  a.click();
  URL.revokeObjectURL(url);
}

function toRIS(p) {
  const lines = ['TY  - JOUR'];
  if (p.title)    lines.push('TI  - ' + p.title);
  (p.authors || []).forEach(a => lines.push('AU  - ' + a));
  if (p.journal)  lines.push('JO  - ' + p.journal);
  if (p.pub_date)     lines.push('PY  - ' + p.pub_date.slice(0, 4));
  if (p.pub_date)     lines.push('DA  - ' + p.pub_date);
  if (p.abstract) lines.push('AB  - ' + p.abstract);
  if (p.doi)      lines.push('DO  - ' + p.doi);
  if (p.pmid)     lines.push('AN  - ' + p.pmid);
  if (p.pmid)     lines.push('UR  - https://pubmed.ncbi.nlm.nih.gov/' + p.pmid + '/');
  lines.push('ER  - ');
  return lines.join('\n');
}

// ── Batch Dismiss ──────────────────────────────────────────────────────────────

async function dismissBatch(batch, btn) {
  // Mark as reviewed in localStorage
  const reviewed = JSON.parse(localStorage.getItem('reviewedBatches') || '[]');
  if (!reviewed.includes(batch)) reviewed.push(batch);
  localStorage.setItem('reviewedBatches', JSON.stringify(reviewed));

  // Remove from UI
  allPapers = allPapers.filter(p => (p.batch || 'legacy') !== batch);
  const filtered = activeFilter === 'All' ? allPapers : allPapers.filter(p => (p.tags || []).includes(activeFilter));
  renderPapers(filtered);
  renderMeta();
}

// ── Feedback Submission ────────────────────────────────────────────────────────

async function submitFeedback() {
  const btn = document.getElementById('feedback-btn');
  const selected = Array.from(selectedPaperIds);
  const shown = allPapers.map(paperId).filter(Boolean);

  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected, shown })
    });

    if (res.ok) {
      const data = await res.json();
      btn.textContent = data.papersSubmitted + ' papers saved';
      // Mark saved papers in UI
      selected.forEach(id => savedPaperIds.add(id));
      const filtered = activeFilter === 'All' ? allPapers : allPapers.filter(p => (p.tags || []).includes(activeFilter));
      renderPapers(filtered);
      setTimeout(() => {
        btn.textContent = 'Save Papers';
        btn.disabled = false;
      }, 3000);
    } else if (res.status === 401) {
      btn.textContent = 'Session expired — reload';
      setTimeout(() => location.reload(), 2000);
    } else {
      const err = await res.json().catch(() => ({}));
      btn.textContent = 'Error — try again';
      console.error('Feedback error:', err);
      setTimeout(() => {
        btn.textContent = 'Save Papers';
        btn.disabled = false;
      }, 3000);
    }
  } catch (err) {
    btn.textContent = 'Connection error';
    console.error(err);
    setTimeout(() => {
      btn.textContent = 'Save Papers';
      btn.disabled = false;
    }, 3000);
  }
}

// ── Sorting & grouping ────────────────────────────────────────────────────────

const RELEVANCE_ORDER = { high: 0, medium: 1, low: 2 };

function sortAiScored(papers) {
  return [...papers].sort((a, b) => (b.sonnet_combined || 0) - (a.sonnet_combined || 0));
}

function sortKeyword(papers) {
  return [...papers].sort((a, b) => {
    const ra = RELEVANCE_ORDER[a.relevance] ?? 2;
    const rb = RELEVANCE_ORDER[b.relevance] ?? 2;
    if (ra !== rb) return ra - rb;
    return (b.pub_date || '').localeCompare(a.pub_date || '');
  });
}

function renderPapers(papers) {
  const container = document.getElementById('papers');
  const empty = document.getElementById('empty');

  if (!papers.length) {
    container.textContent = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  // Group by batch (newest first), fallback batch for legacy papers
  const batches = {};
  for (const p of papers) {
    const batch = p.batch || 'legacy';
    if (!batches[batch]) batches[batch] = [];
    batches[batch].push(p);
  }

  // Sort batch keys: newest first, legacy last
  function batchSortKey(key) {
    if (key === 'legacy') return '0000-00-00';
    const weekMatch = key.match(/^(\d{4})-W(\d{2})$/);
    if (weekMatch) {
      const jan4 = new Date(parseInt(weekMatch[1]), 0, 4);
      const weekStart = new Date(jan4.getTime() + (parseInt(weekMatch[2]) - 1) * 7 * 86400000);
      return weekStart.toISOString().slice(0, 10);
    }
    return key;
  }
  const batchKeys = Object.keys(batches).sort((a, b) => {
    return batchSortKey(b).localeCompare(batchSortKey(a));
  });

  // Build HTML via document fragment for the bulk content
  // We use a temporary container since paperCard returns HTML strings
  const fragment = document.createDocumentFragment();

  for (const batchKey of batchKeys) {
    const batchPapers = batches[batchKey];
    const aiScored   = batchPapers.filter(p => p.sonnet_relevance != null);
    const keywordOnly = batchPapers.filter(p => p.sonnet_relevance == null);
    const wildcards  = aiScored.filter(p => p.is_wildcard);
    const mainAi     = aiScored.filter(p => !p.is_wildcard);

    let batchLabel;
    if (batchKey === 'legacy') {
      batchLabel = 'Earlier Papers';
    } else if (batchKey.includes('-W')) {
      batchLabel = 'Week ' + batchKey;
    } else {
      const d = new Date(batchKey + 'T00:00:00');
      batchLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
    const batchCount = batchPapers.length;

    // Batch header
    const batchHeader = document.createElement('div');
    batchHeader.className = 'batch-header';
    batchHeader.dataset.batch = batchKey;

    const batchInfo = document.createElement('div');
    batchInfo.className = 'batch-info';

    const batchTitleEl = document.createElement('h2');
    batchTitleEl.className = 'batch-title';
    batchTitleEl.textContent = batchLabel;

    const batchCountEl = document.createElement('span');
    batchCountEl.className = 'batch-count';
    batchCountEl.textContent = batchCount + (batchCount === 1 ? ' entry' : ' entries');

    batchInfo.append(batchTitleEl, batchCountEl);

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'batch-dismiss admin-only';
    dismissBtn.dataset.batch = batchKey;
    dismissBtn.title = 'Remove this batch from scout feed';
    dismissBtn.textContent = 'Done reviewing';

    batchHeader.append(batchInfo, dismissBtn);
    fragment.appendChild(batchHeader);

    // Helper to append cards from HTML string
    const appendCards = (cardsHtml) => {
      if (!cardsHtml) return;
      const temp = document.createElement('div');
      temp.innerHTML = cardsHtml; // eslint-disable-line -- all content goes through esc()
      while (temp.firstChild) {
        fragment.appendChild(temp.firstChild);
      }
    };

    if (aiScored.length > 0) {
      if (mainAi.length > 0) {
        appendCards(sectionHeader('AI-Scored', mainAi.length + ' papers ranked by relevance &amp; surprise'));
        appendCards(sortAiScored(mainAi).map(p => paperCard(p)).join(''));
      }
      if (wildcards.length > 0) {
        appendCards(sectionHeader('Wild Cards', 'High surprise — unexpected but potentially interesting'));
        appendCards(sortAiScored(wildcards).map(p => paperCard(p)).join(''));
      }
      if (keywordOnly.length > 0) {
        appendCards(sectionHeader('Keyword-Matched', keywordOnly.length + ' additional papers — keyword scoring'));
        appendCards(sortKeyword(keywordOnly).map(p => paperCard(p)).join(''));
      }
    } else {
      appendCards(sortKeyword(batchPapers).map(p => paperCard(p)).join(''));
    }
  }

  container.textContent = '';
  container.appendChild(fragment);

  // Restore checkbox state
  container.querySelectorAll('.paper-checkbox').forEach(cb => {
    const pid = cb.dataset.paperId;
    cb.checked = selectedPaperIds.has(pid);
    if (cb.checked) cb.closest('.paper-card').classList.add('selected');
  });
}

function sectionHeader(title, subtitle) {
  return '<div class="section-header">' +
    '<h3 class="section-title">' + title + '</h3>' +
    (subtitle ? '<span class="section-sub">' + subtitle + '</span>' : '') +
    '</div>';
}

// ── Paper card ─────────────────────────────────────────────────────────────────

function paperCard(p) {
  const rel = (p.relevance || 'medium').toLowerCase();
  const authors = Array.isArray(p.authors) ? p.authors.join(', ') : (p.authors || '');
  const shortAuthors = authors.length > 100 ? authors.slice(0, 100) + '...' : authors;
  const tags = (p.tags || []).map(t => '<span class="tag">' + esc(t) + '</span>').join('');
  const id = paperId(p);

  const doiLink = p.doi
    ? '<a class="pmid-link" href="https://doi.org/' + p.doi + '" target="_blank" rel="noopener">DOI</a>'
    : (p.pmid
      ? '<a class="pmid-link" href="https://pubmed.ncbi.nlm.nih.gov/' + p.pmid + '/" target="_blank" rel="noopener">PubMed</a>'
      : '');

  const titleHtml = p.pmid
    ? '<a href="https://pubmed.ncbi.nlm.nih.gov/' + p.pmid + '/" target="_blank" rel="noopener">' + esc(p.title) + '</a>'
    : (p.doi
      ? '<a href="https://doi.org/' + p.doi + '" target="_blank" rel="noopener">' + esc(p.title) + '</a>'
      : esc(p.title));

  const dateStr = p.pub_date ? new Date(p.pub_date + 'T00:00:00').toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric'
  }) : '';

  // AI score pills
  const hasAiScore = p.sonnet_relevance != null;
  var scoreRow = '';
  if (hasAiScore) {
    scoreRow = '<div class="score-row">' +
      '<span class="score-pill relevance-score" title="Relevance to your research (1-10)">Relevance ' + p.sonnet_relevance.toFixed(1) + '</span>' +
      '<span class="score-pill surprise-score" title="Surprise factor (1-10)">Surprise ' + p.sonnet_surprise.toFixed(1) + '</span>' +
      (p.is_wildcard ? '<span class="wildcard-tag">Wild card</span>' : '') +
      '</div>';
  }

  // Body: show only the short AI summary if available
  const body = p.ai_summary ? '<p class="paper-body">' + esc(p.ai_summary) + '</p>' : '';

  // "Why this?" expandable
  var whySection = '';
  if (p.why_it_matters) {
    whySection = '<div class="why-wrap">' +
      '<button class="why-btn" aria-expanded="false">Why this? \u25BE</button>' +
      '<p class="why-text hidden">' + esc(p.why_it_matters) + '</p>' +
      '</div>';
  }

  // Abstract expandable — always available if abstract exists
  var abstractSection = '';
  if (p.abstract) {
    abstractSection = '<div class="abstract-wrap">' +
      '<button class="abstract-btn">Read Abstract \u25BE</button>' +
      '<p class="abstract-text hidden">' + esc(p.abstract) + '</p>' +
      '</div>';
  }

  // Full summary section
  var summarySection = '';
  if (p.full_summary) {
    summarySection = '<div class="summary-wrap">' +
      '<button class="summary-toggle">Read summary \u25BE</button>' +
      '<div class="summary-content hidden">' + renderFullSummary(p.full_summary) + '</div>' +
      '</div>';
  }

  // Checkbox
  const checkbox = '<label class="checkbox-wrap admin-only" title="Select for RIS download or feedback">' +
    '<input type="checkbox" class="paper-checkbox" data-paper-id="' + esc(id) + '">' +
    '<span class="checkmark"></span>' +
    '</label>';

  // Journal badge
  const journalBadge = p.journal
    ? '<span class="journal-badge">' + esc(p.journal) + '</span>'
    : '';

  // Preprint badge
  const preprintBadge = p.is_preprint === true
    ? '<span class="preprint-badge">Preprint</span>'
    : '';

  // Saved badge — match against any of the paper's identifiers, since the
  // library and digest_papers tables historically use different paper_id formats.
  const isSaved = savedPaperIds.has(String(id)) ||
                  (p.pmid && savedPaperIds.has(String(p.pmid))) ||
                  (p.doi && savedPaperIds.has(String(p.doi)));
  const savedBadge = isSaved ? '<span class="saved-badge">Saved</span>' : '';

  // Relevance badge (keyword-only papers)
  const relevanceBadge = !hasAiScore
    ? '<span class="relevance-badge relevance-' + rel + '">' + rel + '</span>'
    : '';

  const cardClasses = 'paper-card' +
    (p.is_wildcard ? ' wildcard' : '') +
    (p.full_summary ? ' has-summary' : '') +
    (isSaved ? ' is-saved' : '');

  return '<article class="' + cardClasses + '" data-paper-id="' + esc(id) + '">' +
    '<div class="card-provenance">' +
      checkbox +
      journalBadge +
      preprintBadge +
      savedBadge +
      relevanceBadge +
      '<span class="card-date">' + dateStr + '</span>' +
    '</div>' +
    '<h2 class="paper-title">' + titleHtml + '</h2>' +
    '<p class="paper-authors">' + esc(shortAuthors) + '</p>' +
    scoreRow +
    body +
    abstractSection +
    whySection +
    summarySection +
    '<div class="card-footer">' +
      '<div class="tags">' + tags + '</div>' +
      doiLink +
    '</div>' +
  '</article>';
}

function renderFullSummary(summary) {
  if (typeof summary === 'string') return '<p>' + esc(summary) + '</p>';

  var html = '';
  if (summary.keyFindings) {
    html += '<h4>Key Findings</h4><ul>' +
      summary.keyFindings.map(function(f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>';
  }
  if (summary.methods) {
    html += '<h4>Methods</h4><p>' + esc(summary.methods) + '</p>';
  }
  if (summary.relevance) {
    html += '<h4>Relevance to Your Work</h4><p>' + esc(summary.relevance) + '</p>';
  }
  if (summary.limitations) {
    html += '<h4>Limitations</h4><p>' + esc(summary.limitations) + '</p>';
  }
  if (summary.notableData) {
    html += '<h4>Notable Data</h4><p>' + esc(summary.notableData) + '</p>';
  }
  return html;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init().catch(function(err) {
  var el = document.getElementById('papers');
  var p = document.createElement('p');
  p.style.color = 'var(--error)';
  p.style.padding = '2rem';
  p.textContent = 'Failed to load papers: ' + err.message;
  el.textContent = '';
  el.appendChild(p);
});

// ── Mobile filter toggle ──────────────────────────────────────────────────────
var toggleBtn = document.getElementById('filters-toggle');
var filtersEl = document.getElementById('filters');
if (toggleBtn && filtersEl) {
  toggleBtn.addEventListener('click', function() {
    var open = filtersEl.classList.toggle('open');
    toggleBtn.setAttribute('aria-expanded', open);
    toggleBtn.querySelector('.toggle-arrow').textContent = open ? '\u25B4' : '\u25BE';
  });
}
