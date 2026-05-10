/* ── Paper Queue — library.js ── */

const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

// Status sets
const QUEUE_STATUSES = new Set(['selected', 'summary_pending', 'summary_ready']);
const HIDDEN_STATUSES = new Set(['vaulted', 'done']);

let allPapers = [];
let isAdmin = false;
let showAll = false;

// ── Auth ─────────────────────────────────────────────────────
function checkAuth() {
  return document.cookie.split(';').some(c => c.trim().startsWith('digest-admin='));
}

// ── Helpers ──────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paperId(p) {
  return p.paper_id || p.pmid || p.doi || '';
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ── Load ─────────────────────────────────────────────────────
async function loadPapers() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/papers?select=*&order=selected_date.desc`,
    { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  allPapers = await res.json();
  renderAll();
}

// ── Render ───────────────────────────────────────────────────
function visiblePapers() {
  if (showAll) return allPapers;
  return allPapers.filter(p => QUEUE_STATUSES.has(p.status || 'selected'));
}

function renderAll() {
  const papers = visiblePapers();
  const queueCount = allPapers.filter(p => QUEUE_STATUSES.has(p.status || 'selected')).length;

  document.getElementById('meta').innerHTML =
    `<strong>${allPapers.length}</strong> total`;
  document.getElementById('queue-count').textContent =
    `${queueCount} paper${queueCount !== 1 ? 's' : ''} in queue`;

  if (papers.length === 0) {
    document.getElementById('papers').innerHTML =
      `<div class="empty-state">
        ${showAll
          ? 'No papers saved yet. Select papers from the <a href="/">digest</a>.'
          : 'Queue is empty — all papers have been processed. <label style="color:var(--accent);cursor:pointer"><input type="checkbox" id="show-all-toggle-2"> Show all papers</label>'}
      </div>`;
    const t2 = document.getElementById('show-all-toggle-2');
    if (t2) t2.addEventListener('change', () => {
      showAll = t2.checked;
      document.getElementById('show-all-toggle').checked = showAll;
      renderAll();
    });
    return;
  }

  document.getElementById('papers').innerHTML = papers.map(p => renderCard(p)).join('');
  attachCardEvents();
}

function renderCard(p) {
  const id = esc(paperId(p));
  const status = p.status || 'selected';

  const titleHref = p.pmid
    ? `https://pubmed.ncbi.nlm.nih.gov/${esc(p.pmid)}/`
    : (p.doi ? `https://doi.org/${esc(p.doi)}` : null);
  const titleHtml = titleHref
    ? `<a href="${titleHref}" target="_blank">${esc(p.title)}</a>`
    : esc(p.title);

  const idHtml = p.pmid
    ? `<span class="id-tag">PMID: ${esc(p.pmid)}</span>`
    : (p.doi ? `<span class="id-tag">DOI: ${esc(p.doi)}</span>` : '');

  const scoresHtml = (p.relevance_score != null)
    ? `<div class="score-pills">
        <span class="score-pill relevance-score">Relevance ${Number(p.relevance_score).toFixed(1)}</span>
        <span class="score-pill surprise-score">Surprise ${Number(p.surprise_score ?? 0).toFixed(1)}</span>
       </div>` : '';

  const aiSummaryHtml = p.ai_summary
    ? `<p class="ai-summary">${esc(p.ai_summary)}</p>` : '';
  const whyHtml = p.why_it_matters
    ? `<p class="why-it-matters">${esc(p.why_it_matters)}</p>` : '';

  const abstractHtml = p.abstract
    ? `<div class="abstract-section">
        <button class="abstract-toggle-btn" data-target="abs-${id}">Abstract ▾</button>
        <p class="abstract-body hidden" id="abs-${id}">${esc(p.abstract)}</p>
       </div>` : '';

  // full_text_summary is HTML built by the pipeline (process-summary-queue.js)
  // from a fixed tag allowlist. sanitize() strips anything outside that allowlist
  // and drops all attributes — defense-in-depth so a pipeline regression can't
  // inject script tags into the library page.
  const ftsHtml = p.full_text_summary
    ? `<div class="fulltext-summary">
        <div class="fts-label">Full-Text Summary</div>
        <div class="fts-content">${sanitize(p.full_text_summary)}</div>
       </div>` : '';

  const badgeHtml = `<span class="status-badge badge-${esc(status)}">${esc(status.replace(/_/g, ' '))}</span>`;

  const vaultBtn = buildVaultButton(p, status);
  const summaryBtn = buildSummaryButton(p, status);
  const risBtn = `<button class="action-btn btn-ris" data-action="ris" data-paper-id="${id}" title="Download RIS">RIS</button>`;
  const removeBtn = `<button class="action-btn btn-remove" data-action="remove" data-paper-id="${id}">Remove</button>`;

  const adminBtns = [vaultBtn, summaryBtn, risBtn, removeBtn].filter(Boolean).join('\n');

  return `
  <article class="paper-card" data-paper-id="${id}" data-status="${esc(status)}">
    <div class="card-provenance">
      ${badgeHtml}
      ${p.journal ? `<span class="journal-badge">${esc(p.journal)}</span>` : ''}
      <span class="card-date">Saved ${esc(formatDate(p.selected_date))}</span>
      <div class="card-actions admin-only${isAdmin ? ' visible' : ''}" id="actions-${id}">
        ${adminBtns}
      </div>
    </div>
    <h2 class="paper-title">${titleHtml}</h2>
    <p class="paper-authors">
      ${p.authors ? esc(truncate(p.authors, 80)) : ''}
      ${p.pub_date ? ` &middot; ${esc(p.pub_date)}` : ''}
      ${idHtml ? ` &middot; ${idHtml}` : ''}
    </p>
    ${scoresHtml}
    ${aiSummaryHtml}
    ${whyHtml}
    ${abstractHtml}
    ${ftsHtml}
  </article>`;
}

function buildVaultButton(p, status) {
  if (p.synced_to_vault) return `<span class="summary-status-msg ready">Vaulted</span>`;
  const id = esc(paperId(p));
  return `<button class="action-btn btn-vault" data-action="vault" data-paper-id="${id}">Add to Vault</button>`;
}

function buildSummaryButton(p, status) {
  if (status === 'done') return '';
  if (status === 'summary_pending') {
    return `<span class="summary-status-msg">Summary requested</span>`;
  }
  if (status === 'summary_ready') {
    return p.full_text_summary
      ? `<span class="summary-status-msg ready">Full-text summary available</span>`
      : '';
  }
  const id = esc(paperId(p));
  return `<button class="action-btn btn-summary" data-action="request-summary" data-paper-id="${id}">Request Summary</button>`;
}

// ── Card event delegation ─────────────────────────────────────
function attachCardEvents() {
  document.querySelectorAll('.abstract-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;
      target.classList.toggle('hidden');
      btn.textContent = target.classList.contains('hidden') ? 'Abstract ▾' : 'Abstract ▴';
    });
  });

  document.getElementById('papers').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !isAdmin) return;
    const action = btn.dataset.action;
    const card = btn.closest('.paper-card');
    const pid = btn.dataset.paperId || card?.dataset.paperId;

    if (action === 'ris') { downloadRis(pid); return; }
    if (action === 'remove') { await doRemove(pid, card); return; }
    await doCardAction(action, pid, card, btn);
  });
}

// ── API actions ───────────────────────────────────────────────
async function doCardAction(action, pid, card, btn) {
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = '…';

  try {
    const res = await fetch('/api/update-paper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paperId: pid, action })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const paper = allPapers.find(p => paperId(p) === pid);
    if (paper) {
      if (action === 'vault') {
        paper.synced_to_vault = true;
      } else if (action === 'request-summary') {
        paper.wants_deep_summary = true;
        paper.status = 'summary_pending';
      }
    }

    // Re-render just this card in place
    const newHtml = renderCard(paper);
    const tmp = document.createElement('div');
    tmp.innerHTML = newHtml;
    const newCard = tmp.firstElementChild;
    card.replaceWith(newCard);
    newCard.querySelectorAll('.abstract-toggle-btn').forEach(b => {
      b.addEventListener('click', () => {
        const target = document.getElementById(b.dataset.target);
        if (!target) return;
        target.classList.toggle('hidden');
        b.textContent = target.classList.contains('hidden') ? 'Abstract ▾' : 'Abstract ▴';
      });
    });
    updateQueueCount();
  } catch (err) {
    btn.textContent = err.message;
    setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 3000);
  }
}

async function doRemove(pid, card) {
  if (!confirm('Remove this paper from your saved list?')) return;
  try {
    const res = await fetch('/api/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paperIds: [pid] })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    allPapers = allPapers.filter(p => paperId(p) !== pid);
    card.style.transition = 'opacity 0.3s';
    card.style.opacity = '0';
    setTimeout(() => { card.remove(); updateQueueCount(); }, 320);
  } catch (err) {
    alert('Remove failed: ' + err.message);
  }
}

function updateQueueCount() {
  const queueCount = allPapers.filter(p => QUEUE_STATUSES.has(p.status || 'selected')).length;
  document.getElementById('queue-count').textContent =
    `${queueCount} paper${queueCount !== 1 ? 's' : ''} in queue`;
  document.getElementById('meta').innerHTML =
    `<strong>${allPapers.length}</strong> total`;
}

// ── RIS download (single paper) ───────────────────────────────
function downloadRis(pid) {
  const paper = allPapers.find(p => paperId(p) === pid);
  if (!paper) return;
  let entry = 'TY  - JOUR\n';
  if (paper.title)   entry += `TI  - ${paper.title}\n`;
  if (paper.authors) {
    paper.authors.split(/,\s*/).forEach(a => { entry += `AU  - ${a.trim()}\n`; });
  }
  if (paper.journal)  entry += `JO  - ${paper.journal}\n`;
  if (paper.pub_date) entry += `DA  - ${paper.pub_date}\n`;
  if (paper.doi)      entry += `DO  - ${paper.doi}\n`;
  if (paper.pmid)     entry += `AN  - ${paper.pmid}\n`;
  if (paper.abstract) entry += `AB  - ${paper.abstract}\n`;
  entry += 'ER  - \n';

  const blob = new Blob([entry], { type: 'application/x-research-info-systems' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `paper-${pid || 'export'}.ris`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Show-all toggle ───────────────────────────────────────────
document.getElementById('show-all-toggle').addEventListener('change', e => {
  showAll = e.target.checked;
  renderAll();
});

// ── Admin login ───────────────────────────────────────────────
const loginBtn   = document.getElementById('admin-login-btn');
const loginModal = document.getElementById('login-modal');

loginBtn.addEventListener('click', () => {
  if (isAdmin) {
    document.cookie = 'digest-admin=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/';
    fetch('/api/logout', { method: 'POST' }).catch(() => {});
    isAdmin = false;
    loginBtn.textContent = 'Login';
    document.querySelectorAll('.card-actions.admin-only').forEach(el => el.classList.remove('visible'));
    return;
  }
  loginModal.classList.remove('hidden');
  document.getElementById('login-password').focus();
});

document.getElementById('login-cancel').addEventListener('click', () => {
  loginModal.classList.add('hidden');
});

document.getElementById('login-submit').addEventListener('click', async () => {
  const pw   = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    if (res.ok) {
      isAdmin = true;
      loginBtn.textContent = 'Admin';
      loginModal.classList.add('hidden');
      document.querySelectorAll('.card-actions.admin-only').forEach(el => el.classList.add('visible'));
    } else {
      errEl.textContent = 'Wrong password';
      errEl.classList.remove('hidden');
    }
  } catch {
    errEl.textContent = 'Login failed';
    errEl.classList.remove('hidden');
  }
});

document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('login-submit').click();
});

// ── Init ──────────────────────────────────────────────────────
isAdmin = checkAuth();
if (isAdmin) loginBtn.textContent = 'Admin';

loadPapers().catch(err => {
  document.getElementById('papers').innerHTML =
    `<div class="empty-state" style="color:red">Error loading papers: ${esc(err.message)}</div>`;
});
