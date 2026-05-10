/* ── Funding Radar — grants.js ── */

let allGrants = [];
let activeTopicFilter = 'All';
let activeMechanism = 'All';
let sortBy = 'awardDate';

const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

async function init() {
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/digest_grants?select=*&order=sonnet_combined.desc.nullslast,added_date.desc',
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
        }
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allGrants = await res.json();

    renderMeta();
    renderTopicFilters();
    renderGrants();
  } catch (e) {
    console.error('Failed to load grants:', e);
    document.getElementById('meta').textContent = 'Could not load grants data';
    document.getElementById('empty').classList.remove('hidden');
    document.getElementById('empty').textContent = 'Grant data not yet available.';
  }

  // Mechanism filter buttons
  document.getElementById('mechanism-filter').addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn');
    if (!btn || !btn.dataset.mechanism) return;
    document.querySelectorAll('#mechanism-filter .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeMechanism = btn.dataset.mechanism;
    renderGrants();
  });

  // Sort select
  document.getElementById('sort-select').addEventListener('change', e => {
    sortBy = e.target.value;
    renderGrants();
  });

  // Filters toggle
  const toggle = document.getElementById('filters-toggle');
  const filtersEl = document.getElementById('filters');
  toggle.addEventListener('click', () => {
    const open = filtersEl.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open);
    toggle.querySelector('.toggle-arrow').style.transform = open ? 'rotate(180deg)' : '';
  });

  // Delegated: abstract expand/collapse
  document.getElementById('grants').addEventListener('click', e => {
    const btn = e.target.closest('.abstract-btn');
    if (!btn) return;
    const wrap = btn.closest('.abstract-wrap');
    const text = wrap.querySelector('.abstract-text');
    const isHidden = text.classList.toggle('hidden');
    btn.textContent = isHidden ? 'Abstract ▾' : 'Abstract ▴';
  });
}

function renderMeta() {
  const el = document.getElementById('meta');
  if (!el) return;
  const count = allGrants.length;
  const dates = allGrants.map(g => g.added_date).filter(Boolean).sort();
  const latest = dates.length > 0 ? dates[dates.length - 1] : null;
  const updated = latest
    ? new Date(latest).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : '';
  const aiScored = allGrants.filter(g => g.sonnet_relevance != null).length;

  el.textContent = '';
  const addChip = (text, cls) => {
    const span = document.createElement('span');
    span.className = 'stat-chip' + (cls ? ' ' + cls : '');
    span.textContent = text;
    el.appendChild(span);
  };
  addChip(count + ' grants');
  if (updated) addChip('Updated ' + updated);
  if (aiScored > 0) addChip(aiScored + ' AI-scored', 'ai-scored');
}

// Topic filters are derived dynamically from each grant's `source` field
// (the search label that surfaced the grant in poll-grants.js). To customize
// the filter set for your field, edit the searches in
// pipeline/config/grants-config.json — the labels there flow through to
// these filter buttons.

function getTopicLabels() {
  const labelCounts = new Map();
  for (const g of allGrants) {
    const sources = (g.source || '').split(/,\s*/).filter(Boolean);
    for (const s of sources) {
      labelCounts.set(s, (labelCounts.get(s) || 0) + 1);
    }
  }
  return [...labelCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label]) => label);
}

function grantMatchesTopic(g, topicName) {
  const sources = (g.source || '').split(/,\s*/);
  return sources.includes(topicName);
}

function renderTopicFilters() {
  const filtersEl = document.getElementById('filters');
  while (filtersEl.firstChild) filtersEl.removeChild(filtersEl.firstChild);

  // All button
  const allBtn = document.createElement('button');
  allBtn.className = 'filter-btn active';
  allBtn.dataset.topic = 'All';
  allBtn.textContent = `All (${allGrants.length})`;
  allBtn.addEventListener('click', () => setTopicFilter('All', allBtn));
  filtersEl.appendChild(allBtn);

  const topics = getTopicLabels();

  for (const topic of topics) {
    const count = allGrants.filter(g => grantMatchesTopic(g, topic)).length;
    if (count === 0) continue;

    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.dataset.topic = topic;
    btn.textContent = `${topic} (${count})`;
    btn.addEventListener('click', () => setTopicFilter(topic, btn));
    filtersEl.appendChild(btn);
  }
}

function setTopicFilter(topic, btn) {
  activeTopicFilter = topic;
  document.querySelectorAll('#filters .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderGrants();
}

function getFilteredGrants() {
  let grants = allGrants;

  // Topic filter
  if (activeTopicFilter !== 'All') {
    grants = grants.filter(g => grantMatchesTopic(g, activeTopicFilter));
  }

  // Mechanism filter
  if (activeMechanism !== 'All') {
    if (activeMechanism === 'K') {
      grants = grants.filter(g => (g.mechanism || '').startsWith('K'));
    } else if (activeMechanism === 'U') {
      grants = grants.filter(g => (g.mechanism || '').startsWith('U'));
    } else {
      grants = grants.filter(g => g.mechanism === activeMechanism);
    }
  }

  // Sort
  grants = [...grants].sort((a, b) => {
    if (sortBy === 'relevanceScore') {
      return (b.sonnet_combined || 0) - (a.sonnet_combined || 0);
    }
    if (sortBy === 'amount') {
      return (b.amount || 0) - (a.amount || 0);
    }
    // Default: award date
    return (b.award_date || '').localeCompare(a.award_date || '');
  });

  return grants;
}

function formatMoney(n) {
  if (!n) return null;
  return '$' + Math.round(n).toLocaleString('en-US');
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00Z');
  return dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function mechanismColor(mech) {
  if (!mech) return 'mech-other';
  if (mech === 'R01') return 'mech-r01';
  if (mech === 'R21') return 'mech-r21';
  if (mech.startsWith('P')) return 'mech-p';
  if (mech.startsWith('K')) return 'mech-k';
  if (mech.startsWith('U')) return 'mech-u';
  return 'mech-other';
}

function renderGrants() {
  const grants = getFilteredGrants();
  const container = document.getElementById('grants');
  const empty = document.getElementById('empty');

  if (grants.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  container.innerHTML = grants.map(g => renderGrantCard(g)).join('');
}

function renderGrantCard(g) {
  const mechClass = mechanismColor(g.mechanism);
  const amount = formatMoney(g.amount);
  const startDate = formatDate(g.start_date);
  const endDate = formatDate(g.end_date);
  const awardDate = g.award_date ? formatDate(g.award_date) : '';

  const newBadge = g.is_new
    ? `<span class="new-grant-badge">New</span>`
    : '';

  const relevanceClass = `relevance-${g.relevance || 'low'}`;
  const relevanceBadge = `<span class="relevance-badge ${relevanceClass}">${g.relevance || 'low'}</span>`;

  // AI score row (same pattern as papers)
  const hasAiScore = g.sonnet_relevance != null;
  const scoreRow = hasAiScore ? `
<div class="score-row">
  <span class="score-pill relevance-score" title="Relevance to your research (1–10)">Relevance ${g.sonnet_relevance.toFixed(1)}</span>
  <span class="score-pill surprise-score" title="Surprise factor (1–10)">Surprise ${g.sonnet_surprise.toFixed(1)}</span>
</div>` : '';

  const mechBadge = g.mechanism
    ? `<span class="mechanism-badge ${mechClass}">${g.mechanism}</span>`
    : '';

  const tags = (g.tags || []).length > 0
    ? `<div class="tags">${g.tags.slice(0, 5).map(t => `<span class="tag">${escapeHTML(t)}</span>`).join('')}</div>`
    : '';

  const piInfo = [
    g.pi ? `<strong>${escapeHTML(g.pi)}</strong>` : '',
    g.organization ? escapeHTML(g.organization) : '',
    (g.org_city && g.org_state) ? `${escapeHTML(g.org_city)}, ${escapeHTML(g.org_state)}` : (g.org_state || ''),
  ].filter(Boolean).join(' · ');

  const fundingLine = amount
    ? `<span class="funding-amount">${amount}</span>${g.fiscal_year ? ` <span class="fy-label">FY${g.fiscal_year}</span>` : ''}`
    : '';

  const periodLine = (startDate || endDate)
    ? `<span class="project-period">${startDate}${endDate ? ` → ${endDate}` : ''}</span>`
    : '';

  const studySection = g.study_section
    ? `<span class="study-section">Study section: ${escapeHTML(g.study_section)}</span>`
    : '';

  const hasAbstract = g.abstract && g.abstract.trim().length > 0;
  const abstractBlock = hasAbstract ? `
    <div class="abstract-wrap">
      <button class="abstract-btn">Abstract ▾</button>
      <div class="abstract-text hidden">${escapeHTML(g.abstract)}</div>
    </div>` : '';

  const whySection = g.sonnet_reason ? `
    <p class="paper-abstract" style="font-style:italic;color:var(--muted)">${escapeHTML(g.sonnet_reason)}</p>` : '';

  const awardLine = awardDate
    ? `<span class="award-date">Awarded: ${awardDate}</span>`
    : '';

  return `
    <article class="paper-card grant-card">
      <div class="card-provenance">
        ${mechBadge}
        ${newBadge}
        ${relevanceBadge}
        ${awardLine ? `<span class="card-date">${awardDate}</span>` : ''}
      </div>
      <h2 class="paper-title">
        <a href="${escapeHTML(g.url)}" target="_blank" rel="noopener">${escapeHTML(g.title || 'Untitled')}</a>
      </h2>
      <p class="paper-authors">${piInfo}</p>
      ${scoreRow}
      <div class="grant-meta">
        ${fundingLine}
        ${periodLine ? `${periodLine}` : ''}
      </div>
      ${studySection ? `<p class="paper-meta">${studySection}</p>` : ''}
      ${whySection}
      ${abstractBlock}
      <div class="card-footer">
        ${tags}
        <a class="pmid-link" href="${escapeHTML(g.url)}" target="_blank" rel="noopener">${escapeHTML(g.grant_id || '')}</a>
      </div>
    </article>
  `;
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

init();
