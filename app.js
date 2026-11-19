const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unesc = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
const LABEL = { ready: 'Ready', 'needs-you': 'Needs you', waiting: 'Waiting', claimed: 'Claimed', blocked: 'Blocked', epic: 'Epic' };
const STATUSES = [['all', 'All'], ...Object.entries(LABEL)];
const VIEWS = [['board', 'Board'], ['graph', 'Map'], ['inbox', 'Inbox']];
const CLAIMABLE = ['ready', 'needs-you', 'waiting'];
const CONFIRM = {
  claim: { title: 'CLAIM QUEST?', label: 'Claim', ok: 'QUEST CLAIMED', fail: 'CLAIM FAILED',
    body: (q) => `Pushes an empty commit to ${claimBranch(q.id)}, opens a draft PR, and switches the ${q.project} checkout to that branch.` },
  release: { title: 'RELEASE CLAIM?', label: 'Release', ok: 'CLAIM RELEASED', fail: 'RELEASE FAILED',
    body: () => 'Deletes the claim branch and closes its draft PR. Only works while the branch holds just the claim commit.' },
};
const claimBranch = (id) => id.replace(/\.md$/, '');
const keyOf = (project, id) => project + '::' + id;
const key = (q) => keyOf(q.project, q.id);
const label = (q) => LABEL[q.display] ?? q.display;
const szChip = (q) => q.size ? `<span class="sz ${q.size}">${q.size}</span>` : '';

let data = null, health = null, claims = {}, loadError = null, busy = false, returnFocus = null, scrolledTo = null;
const claimsPending = new Set(); // projects whose open PRs are being fetched
const outputs = {};              // last action output per quest key: { text, err }
const state = { project: 'all', status: 'all', q: '', sel: null, view: 'board', iso: false, theme: null };
try { Object.assign(state, JSON.parse(localStorage.getItem('quest-board') || '{}'), { sel: null }); } catch {}
if (state.theme) document.documentElement.dataset.theme = state.theme;

async function api(url, body) {
  try {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-quest-board': '1' }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok && !j.error) j.error = `HTTP ${r.status}`;
    return j;
  } catch (e) { return { error: e.message || 'network error' }; }
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3500); }

/** Inline Markdown for plan text: `code`, http(s) links, and links to other quests in the tree. */
function md(s, project) {
  const parts = String(s ?? '').split('`');
  if (parts.length % 2 === 0) parts[parts.length - 2] += '`' + parts.pop(); // unmatched backtick
  return parts.map((seg, i) => i % 2 ? `<code>${esc(seg)}</code>` : esc(seg).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
    const url = unesc(href);
    if (/^https?:\/\//.test(url)) return `<a class="link" href="${esc(url)}" target="_blank" rel="noopener">${text}</a>`;
    const quest = /^\/?(quest\/[^#?]+\.md)/.exec(url);
    return quest && project ? `<a class="link" data-k="${esc(keyOf(project, quest[1]))}" tabindex="0" role="button">${text}</a>` : m;
  })).join('');
}

// ---- loading -------------------------------------------------------------
let loadedAt = 0, running = false, queued = null;
/** Load every tree. A call made while one is running queues a single follow-up; the promise settles when its load is done. */
function load(quiet) {
  return new Promise((resolve) => {
    if (running) {
      if (queued) { queued.quiet = queued.quiet && !!quiet; queued.waiters.push(resolve); } else queued = { quiet: !!quiet, waiters: [resolve] };
      return;
    }
    runLoad(!!quiet, [resolve]);
  });
}
function setRunning(on) {
  running = on;
  const b = $('#refresh');
  b.disabled = on;
  b.textContent = on ? 'Loading…' : 'Refresh';
}
async function runLoad(quiet, waiters) {
  setRunning(true);
  try { await fetchBoard(); } catch (e) { loadError = e.message; render(); }
  finally {
    setRunning(false); loadedAt = Date.now();
    waiters.forEach((r) => r());
    if (queued) { const n = queued; queued = null; runLoad(n.quiet, n.waiters); }
  }
}
async function fetchBoard() {
  const [board, h] = await Promise.all([api('/api/board'), health ? health : api('/api/health')]);
  if (!health && !h.error) health = h;
  if (board.error || !Array.isArray(board.projects)) { loadError = board.error || 'unexpected response from the server'; render(); return; }
  loadError = null;
  data = board;
  for (const n of Object.keys(claims)) if (!data.projects.some(p => p.name === n)) delete claims[n];
  const names = data.projects.filter(p => !p.error).map(p => p.name);
  names.forEach(n => claimsPending.add(n)); // previous claims stay until the new ones arrive
  render();
  await Promise.all(names.map(async (n) => {
    const res = await api('/api/claims?project=' + encodeURIComponent(n));
    claims[n] = res.error && claims[n] ? { ...claims[n], error: res.error } : res;
    claimsPending.delete(n);
    render();
  }));
}

// ---- derived data ----------------------------------------------------------
let cache = null;
function all() {
  if (cache) return cache.list;
  const list = [];
  for (const p of data.projects) {
    const byBranch = new Map((claims[p.name]?.prs || []).map(x => [x.headRefName, x]));
    for (const q of p.quests) {
      const pr = byBranch.get(claimBranch(q.id));
      list.push({ ...q, project: p.name, pr, display: pr ? 'claimed' : q.status });
    }
  }
  cache = { list, byKey: new Map(list.map(q => [key(q), q])) };
  return list;
}
const find = (k) => (all(), cache.byKey.get(k));
const inProject = (q) => state.project === 'all' || q.project === state.project;
const matches = (q, extra = '') => { const s = state.q.toLowerCase(); return !s || (q.title + ' ' + q.id + ' ' + q.goal + ' ' + extra).toLowerCase().includes(s); };

function visible() {
  return all().filter(q => q.kind !== 'root' && inProject(q) && (state.status === 'all' || q.display === state.status) && matches(q));
}

// ---- focus -------------------------------------------------------------------
function focusTarget(el) {
  if (!el || el === document.body) return null;
  const box = el.closest?.('#board,#panel,#viewChips,#statusChips');
  if (!box) return null;
  for (const a of ['k', 'a', 'v', 's', 'copy']) if (el.dataset?.[a] !== undefined) return `#${box.id} [data-${a}="${CSS.escape(el.dataset[a])}"]`;
  return el.id ? `#${box.id} #${CSS.escape(el.id)}` : null;
}

function render() {
  const focus = focusTarget(document.activeElement);
  cache = null;
  renderBanners();
  renderThemeButton();
  if (!data) {
    for (const id of ['#viewChips', '#project', '#q', '#statusChips']) $(id).hidden = true;
    $('#board').innerHTML = loadError ? '' : '<div class="loading press">NOW LOADING…</div>';
    renderPanel();
    return;
  }
  if (state.project !== 'all' && !data.projects.some(p => p.name === state.project)) state.project = 'all';
  const empty = !data.projects.length;
  for (const id of ['#viewChips', '#project', '#q', '#statusChips']) $(id).hidden = empty;
  if (empty) { $('#board').innerHTML = startScreen(); renderPanel(); save(); return; }

  const every = all().filter(q => q.kind !== 'root' && inProject(q));
  const count = (st) => st === 'all' ? every.length : every.filter(q => q.display === st).length;
  const claimsKnown = !data.projects.some(p => claimsPending.has(p.name) && !claims[p.name]);
  $('#project').innerHTML = '<option value="all">All projects</option>' + data.projects.map(p => `<option value="${esc(p.name)}" ${p.name === state.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const inbox = every.filter(q => q.waitsOnYou).length;
  $('#viewChips').innerHTML = VIEWS.map(([k, l]) => `<button class="chip ${state.view === k ? 'on' : ''}" data-v="${k}" aria-pressed="${state.view === k}" title="${VIEWS.findIndex(v => v[0] === k) + 1}">${l.toUpperCase()}${k === 'inbox' && inbox ? `<b>${inbox}</b>` : ''}</button>`).join('');
  $('#statusChips').innerHTML = STATUSES.map(([k, l]) => `<button class="chip ${k} ${state.status === k ? 'on' : ''}" data-s="${k}" aria-pressed="${state.status === k}">${l.toUpperCase()}<b>${k === 'claimed' && !claimsKnown ? '…' : count(k)}</b></button>`).join('');
  $('#statusChips').hidden = state.view === 'inbox'; // the Inbox lists waiting items whatever their status

  if (state.view === 'inbox') renderInbox();
  else if (state.view === 'graph') renderGraph(visible());
  else renderBoard(visible());
  renderPanel();
  save();
  if (focus) document.querySelector(focus)?.focus({ preventScroll: true });
}

function renderBanners() {
  const b = [];
  if (loadError) b.push(`<b>Could not load the board:</b> ${esc(loadError)}`);
  if (data) {
    if (health && !health.quest) b.push('<code>quest</code> not found: nothing can be ranked ready. <a href="https://github.com/moq-dev/quest#try-it" target="_blank" rel="noopener">Install it</a> or set <code>QUEST_BIN</code>.');
    if (health && !health.gh) b.push('<code>gh</code> not found: claims are not shown.');
    for (const p of data.projects) {
      if (p.error) b.push(`<b>${esc(p.name)}</b>: ${esc(p.error)}`);
      else if (p.readyError) b.push(`<b>${esc(p.name)}</b>: quest unblocked failed: ${esc(p.readyError)}`);
      else if (p.check && !p.check.ok) b.push(`<b>${esc(p.name)}</b>: quest check failed: ${esc(p.check.message)}`);
      const c = claims[p.name];
      if (c?.error && health?.gh) b.push(`<b>${esc(p.name)}</b>: could not list PRs: ${esc(c.error)}`);
    }
  }
  $('#banners').innerHTML = b.map(x => `<div class="banner" role="alert">${x}</div>`).join('');
}

function isDark() { return state.theme ? state.theme === 'night' : !matchMedia('(prefers-color-scheme: light)').matches; }
function renderThemeButton() {
  const b = $('#theme'), dark = isDark();
  b.textContent = dark ? '☼' : '☾';
  b.setAttribute('aria-label', dark ? 'Switch to day palette' : 'Switch to night palette');
  b.title = b.getAttribute('aria-label');
}

function startScreen() {
  return `<div class="start">
    <p>No projects yet. Add a repository that has a <code>quest/</code> directory.</p>
    <button class="primary press" id="addProj">PRESS START</button>
    <p class="muted">Or run <code>quest-board ~/path/to/repo</code>.</p></div>`;
}

const emptyState = (msg) => `<div class="empty">${msg}<br>${state.status !== 'all' || state.q ? '<button data-clear>Clear filters</button>' : ''}</div>`;

// ---- board and inbox -----------------------------------------------------------
function meta(q, { status = true, pre = '', post = '' } = {}) {
  return `<div class="meta">${pre}${szChip(q)}${status ? `<span class="st ${q.display}">${label(q)}</span>` : ''}${q.dependents ? `<span title="Quests this unlocks">unlocks ${q.dependents}</span>` : ''}${q.pr ? `<span>PR #${q.pr.number}${q.pr.isDraft ? ' draft' : ''}</span>` : ''}${data.projects.length > 1 ? `<span class="tag">${esc(q.project)}</span>` : ''}${post}</div>`;
}

function renderBoard(list) {
  const cols = {};
  for (const q of list) (cols[q.milestone || '—'] ||= []).push(q);
  const names = Object.keys(cols).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  $('#board').innerHTML = names.length ? names.map(m => {
    const items = cols[m].sort((a, b) => (b.dependents ?? -1) - (a.dependents ?? -1) || a.id.localeCompare(b.id));
    return `<section class="col"><h2>STAGE ${esc(m)} <span>${items.length}</span></h2>${items.map(card).join('')}</section>`;
  }).join('') : emptyState('No quests match.');
}

function card(q) {
  const epic = q.epic ? `<span class="tag">${esc(q.epic.split('/').slice(-2, -1)[0])}</span>` : '';
  return `<div class="card ${q.display} ${state.sel === key(q) ? 'sel' : ''}" data-k="${esc(key(q))}" tabindex="0" role="button">
    <div class="t">${esc(q.title)}</div>${meta(q, { post: epic })}</div>`;
}

function renderInbox() {
  const items = all().filter(q => q.waiting.length && inProject(q) && matches(q, q.waiting.map(w => w.party + ' ' + w.text).join(' ')));
  const rank = (a, b) => (a.milestone || '').localeCompare(b.milestone || '', undefined, { numeric: true }) || ((b.dependents ?? 0) - (a.dependents ?? 0)) || a.id.localeCompare(b.id);
  const wait = (q, w) => `<div class="w md">${/^maintainer$/i.test(w.party) ? '' : `<b>${esc(w.party)}:</b> `}${md(w.text, q.project)}</div>`;
  const row = (q) => `<div class="row ${q.waitsOnYou ? 'needs-you' : 'blocked'} ${state.sel === key(q) ? 'sel' : ''}" data-k="${esc(key(q))}" tabindex="0" role="button">
    <div class="t">${esc(q.title)}</div>${q.waiting.map(w => wait(q, w)).join('')}
    ${meta(q, { status: false, pre: q.milestone ? `<span class="tag">Stage ${esc(q.milestone)}</span>` : '' })}</div>`;
  const mine = items.filter(q => q.waitsOnYou).sort(rank), others = items.filter(q => !q.waitsOnYou).sort(rank);
  const group = (title, list) => list.length ? `<h2>${title} <span class="muted">${list.length}</span></h2>${list.map(row).join('')}` : '';
  $('#board').innerHTML = items.length
    ? `<div class="inbox">${group('NEEDS YOU', mine)}${group('WAITING ON OTHERS', others)}</div>`
    : emptyState(state.q ? 'No waiting items match.' : 'Nothing is waiting.');
}

// ---- map -----------------------------------------------------------------------
function renderGraph(list) {
  const board = $('#board'), old = board.querySelector('.graphwrap');
  const sl = old?.scrollLeft || 0, st = old?.scrollTop || 0;
  const byId = new Map(list.map(q => [key(q), q]));
  const edges = [], inn = new Map();
  const push = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v);
  for (const q of list) for (const r of q.required) {
    const a = keyOf(q.project, r.target), b = key(q);
    if (!byId.has(a)) continue;
    edges.push([a, b]); push(inn, b, a);
  }
  const connected = new Set(edges.flat());
  const nodes = list.filter(q => state.iso || connected.has(key(q)));
  const unlinked = list.length - list.filter(q => connected.has(key(q))).length;
  const legend = (n, e) => `<div class="glegend"><b>${n} QUESTS · ${e} LINKS</b><label><input type="checkbox" id="iso" ${state.iso ? 'checked' : ''}> Show unlinked (${unlinked})</label></div>`;
  if (!nodes.length) { board.innerHTML = list.length ? `<div class="graphwrap">${legend(0, 0)}${emptyState('No links between the quests shown.')}</div>` : emptyState('No quests match.'); return; }
  // Longest-path layering: a quest sits one column right of its deepest blocker.
  const layer = new Map(), onStack = new Set();
  const depth = (k) => {
    if (layer.has(k)) return layer.get(k);
    if (onStack.has(k)) return 0; // a cycle; quest check reports these
    onStack.add(k);
    const l = (inn.get(k) || []).reduce((m, p) => Math.max(m, depth(p) + 1), 0);
    onStack.delete(k);
    layer.set(k, l);
    return l;
  };
  nodes.forEach(q => depth(key(q)));
  const layers = [];
  nodes.map(key).sort().forEach(k => (layers[layer.get(k)] ||= []).push(k));
  for (let i = 0; i < layers.length; i++) layers[i] ||= [];
  // An edge spanning several layers gets a dummy node in each layer it crosses, so it takes a row
  // slot there instead of running behind real nodes.
  const sout = new Map(), sin = new Map();
  const chains = edges.map(([a, b], i) => {
    const chain = [a];
    for (let l = layer.get(a) + 1; l < layer.get(b); l++) { const d = `~${i}@${l}`; layer.set(d, l); layers[l].push(d); chain.push(d); }
    chain.push(b);
    for (let j = 0; j + 1 < chain.length; j++) if (layer.get(chain[j + 1]) === layer.get(chain[j]) + 1) { push(sout, chain[j], chain[j + 1]); push(sin, chain[j + 1], chain[j]); }
    return chain;
  });
  // Barycenter sweeps to reduce crossings.
  const pos = new Map();
  const index = () => layers.forEach(L => L.forEach((k, i) => pos.set(k, i)));
  index();
  const bary = (k, nb) => { const a = (nb.get(k) || []).filter(x => pos.has(x)); return a.length ? a.reduce((s, x) => s + pos.get(x), 0) / a.length : pos.get(k); };
  for (let it = 0; it < 4; it++) {
    for (let i = 1; i < layers.length; i++) { const b = new Map(layers[i].map(k => [k, bary(k, sin)])); layers[i].sort((x, y) => b.get(x) - b.get(y)); index(); }
    for (let i = layers.length - 2; i >= 0; i--) { const b = new Map(layers[i].map(k => [k, bary(k, sout)])); layers[i].sort((x, y) => b.get(x) - b.get(y)); index(); }
  }
  const W = 320, H = 46, GX = 80, GY = 16, P = 20, CH = 8; // CH: pixels between parallel vertical channels
  // Each source gets its own vertical channel in the gap after its layer.
  const gapSources = layers.map((L) => L.filter(k => (sout.get(k) || []).length));
  const gapW = gapSources.map(S => Math.max(GX, CH * (S.length + 1)));
  const colX = []; let cx0 = P;
  layers.forEach((_, i) => { colX[i] = cx0; cx0 += W + gapW[i]; });
  const xy = new Map();
  layers.forEach((L, i) => L.forEach((k, j) => xy.set(k, [colX[i], P + j * (H + GY)])));
  const channel = new Map();
  gapSources.forEach((S, i) => S.forEach((k, s) => channel.set(k, colX[i] + W + Math.round(gapW[i] * (s + 1) / (S.length + 1)))));
  const width = cx0 - gapW[layers.length - 1] + P + 4, height = P * 2 + Math.max(...layers.map(L => L.length)) * (H + GY);
  const out = new Map();
  for (const [a, b] of edges) push(out, a, b);
  let rel = null;
  if (state.sel && xy.has(state.sel)) {
    rel = new Set([state.sel]);
    for (const m of [out, inn]) { const stack = [state.sel]; while (stack.length) for (const n of m.get(stack.pop()) || []) if (!rel.has(n)) { rel.add(n); stack.push(n); } }
  }
  const route = (chain) => {
    const a = chain[0], b = chain[chain.length - 1];
    if (layer.get(b) <= layer.get(a)) { // a cycle: draw it directly
      const [x1, y1] = xy.get(a), [x2, y2] = xy.get(b), mx = Math.round(x2 - GX / 2);
      return `M${x1 + W},${y1 + H / 2} H${mx} V${y2 + H / 2} H${x2 - 2}`;
    }
    let d = `M${xy.get(a)[0] + W},${xy.get(a)[1] + H / 2}`;
    for (let j = 1; j < chain.length; j++) {
      const [x, y] = xy.get(chain[j]), last = j === chain.length - 1;
      d += ` H${channel.get(chain[j - 1])} V${y + H / 2} H${last ? x - 2 : x + W}`;
    }
    return d;
  };
  const many = data.projects.length > 1;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="group" aria-label="Quest dependency map">
    <defs><clipPath id="lbl"><rect x="14" y="0" width="${W - 20}" height="${H}"/></clipPath>
      <marker id="arr" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6z"/></marker>
      <marker id="arr-hi" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6z"/></marker></defs>
    ${chains.map(c => { const hi = rel && rel.has(c[0]) && rel.has(c[c.length - 1]); return `<path class="ge ${rel ? (hi ? 'hi' : 'dim') : ''}" d="${route(c)}" marker-end="url(#${hi ? 'arr-hi' : 'arr'})"/>`; }).join('')}
    ${nodes.map(q => {
      const k = key(q), [x, y] = xy.get(k), t = q.title.length > 40 ? q.title.slice(0, 39) + '…' : q.title;
      const sub = [q.milestone, label(q).toUpperCase(), many ? q.project : null].filter(Boolean).join(' · ');
      const aria = `${q.title}, ${label(q).toLowerCase()}${q.size ? ', size ' + q.size : ''}${many ? ', ' + q.project : ''}`;
      return `<g class="gn ${q.display} ${state.sel === k ? 'sel' : ''} ${rel && !rel.has(k) ? 'dim' : ''}" data-k="${esc(k)}" tabindex="0" role="button" aria-label="${esc(aria)}" transform="translate(${x},${y})"><title>${esc(q.title)}</title>
        <rect class="sh" x="4" y="4" width="${W}" height="${H}"/><rect class="box" width="${W}" height="${H}"/><rect class="bar" width="8" height="${H}"/>
        <text x="16" y="20" clip-path="url(#lbl)">${esc(t)}</text>
        ${q.size ? `<rect class="szb ${q.size}" x="16" y="29" width="10" height="10"/>` : ''}<text class="sub" x="${q.size ? 32 : 16}" y="39" clip-path="url(#lbl)">${esc(sub)}</text></g>`;
    }).join('')}
  </svg>`;
  board.innerHTML = `<div class="graphwrap">${legend(nodes.length, edges.length)}${svg}</div>`;
  const w = board.querySelector('.graphwrap'); w.scrollLeft = sl; w.scrollTop = st;
  if (state.sel && state.sel !== scrolledTo) board.querySelector(`.gn[data-k="${CSS.escape(state.sel)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  scrolledTo = state.sel;
}

// ---- detail panel ----------------------------------------------------------------
function renderPanel() {
  const panel = $('#panel');
  const q = data && state.sel ? find(state.sel) : null;
  document.body.classList.toggle('has-panel', !!q);
  if (!q) { state.sel = null; panel.classList.remove('open'); panel.setAttribute('inert', ''); return; }
  const deps = (ids) => `<ul class="deps">${ids.map(({ id, why, text }) => {
    const tq = find(keyOf(q.project, id));
    return `<li>${tq ? `<span class="st ${tq.display}">${label(tq)}</span>` : '<span class="err">Missing</span>'}<a class="link" data-k="${esc(keyOf(q.project, id))}" tabindex="0" role="button">${esc(tq?.title || text || id)}</a>${why ? `<span class="why">${md(why, q.project)}</span>` : ''}</li>`;
  }).join('')}</ul>`;
  const section = (title, body) => body ? `<h4>${title}</h4>${body}` : '';
  const req = q.required.map(r => ({ id: r.target, why: r.why, text: r.label }));
  const rel = q.related.map(r => ({ id: r.target, why: r.why, text: r.label }));
  const canClaim = CLAIMABLE.includes(q.status) && !q.pr;
  const unknown = claimsPending.has(q.project) || !claims[q.project]; // no claim until open PRs are known
  const dis = busy ? ' disabled' : '';
  const out = outputs[key(q)];
  const scheduled = q.scheduled ? q.scheduled.split('\n')[0].replace(/^[-*]\s*/, '') : '';
  panel.innerHTML = `
    <div class="top"><span class="tag">${esc(q.project)} · ${esc(q.id)}</span><button id="close" aria-label="Close" title="Close (Esc)">✕</button></div>
    <h3 tabindex="-1">${szChip(q)} ${esc(q.title)}</h3>
    <div class="meta"><span class="st ${q.display}">${label(q)}</span>${q.milestone ? `<span>Stage ${esc(q.milestone)}</span>` : ''}${q.dependents ? `<span>unlocks ${q.dependents} in total</span>` : ''}${scheduled ? `<span>scheduled ${esc(scheduled)}</span>` : ''}${q.pr ? `<a class="link" target="_blank" rel="noopener" href="${esc(q.pr.url)}">PR #${q.pr.number}${q.pr.isDraft ? ' (draft)' : ''}</a>` : ''}</div>
    <div class="actions">
      ${canClaim ? `<button class="primary" data-a="claim"${busy || unknown ? ' disabled' : ''}${unknown ? ' title="Checking open PRs…"' : ''}>CLAIM QUEST</button>` : ''}
      ${q.pr && q.pr.isDraft ? `<button class="danger" data-a="release"${dis}>Release claim</button>` : ''}
      ${q.status === 'blocked' ? `<button data-a="blockers"${dis}>Why blocked?</button>` : ''}
      <button data-a="open-file"${dis}>Open file</button>
      <button data-copy="${esc(q.id)}">Copy path</button>
    </div>
    <div id="out" aria-live="polite">${out ? `<pre class="${out.err ? 'err' : ''}">${esc(out.text)}</pre>` : ''}</div>
    ${section('WAITING ON', q.waiting.map(w => `<p class="md"><b>${esc(w.party)}:</b> ${md(w.text, q.project)}</p>`).join(''))}
    ${section('GOAL', q.goal && `<div class="md">${md(q.goal, q.project)}</div>`)}
    ${section(`REQUIRED (${req.length})`, req.length && deps(req))}
    ${section(`UNLOCKS (${q.requiredBy.length})`, q.requiredBy.length && deps(q.requiredBy.map(id => ({ id }))))}
    ${section('RELATED', rel.length && deps(rel))}
    ${section('PLAN', q.plan && `<div class="md">${md(q.plan, q.project)}</div>`)}
    ${section('HOSTS', q.hosts && `<div class="md">${md(q.hosts, q.project)}</div>`)}`;
  panel.classList.add('open');
  panel.removeAttribute('inert');
}
/** Rebuild just the panel, keeping keyboard focus on the same control. */
function refreshPanel() {
  const focus = focusTarget(document.activeElement);
  renderPanel();
  if (focus) document.querySelector(focus)?.focus({ preventScroll: true });
}
function openPanel(k) {
  if (!$('#panel').classList.contains('open')) returnFocus = document.activeElement;
  state.sel = k;
  render();
  $('#panel h3')?.focus({ preventScroll: true });
}
function closePanel() {
  const prev = state.sel, inside = $('#panel').contains(document.activeElement) || document.activeElement === document.body;
  state.sel = null;
  render();
  if (!inside) return;
  const card = prev && document.querySelector(`#board [data-k="${CSS.escape(prev)}"]`);
  (card || (returnFocus?.isConnected ? returnFocus : null))?.focus({ preventScroll: true });
}

function setOut(k, text, err) {
  outputs[k] = { text, err };
  if (state.sel === k) refreshPanel();
}

async function act(a) {
  if (busy) return;
  const q = find(state.sel); if (!q) return;
  const c = CONFIRM[a];
  if (c && !(await confirmDialog(c.title, `${q.title}\n\n${c.body(q)}`, c.label))) return;
  const k = key(q);
  busy = true;
  setOut(k, 'Running…', false);
  try {
    const r = await api('/api/action', { project: q.project, quest: q.id, action: a });
    setOut(k, r.output || r.error || 'Done.', r.ok === false || !!r.error);
    if (c) {
      toast(r.ok ? c.ok : c.fail);
      await load(true); // the claim changes the tree's PRs and possibly the checked-out branch
    }
  } finally {
    busy = false;
    if (state.sel === k) { refreshPanel(); if (!$('#panel').contains(document.activeElement)) ($(`#panel [data-a="${a}"]`) || $('#panel h3'))?.focus({ preventScroll: true }); }
  }
}

function confirmDialog(title, msg, okLabel) {
  return new Promise((res) => {
    const d = $('#dlg');
    d.innerHTML = `<h3>${esc(title)}</h3><p class="md">${esc(msg)}</p><div class="actions end"><button data-r="0">Cancel</button><button data-r="1" class="primary">${esc(okLabel.toUpperCase())}</button></div>`;
    d.onclose = () => res(d.returnValue === '1');
    d.returnValue = '';
    d.querySelectorAll('[data-r]').forEach(b => b.onclick = () => d.close(b.dataset.r));
    d.showModal();
  });
}

function projectsDialog() {
  const d = $('#dlg');
  const list = data?.projects || [];
  d.innerHTML = `<h3>PROJECTS</h3>
    <ul class="plist">${list.map(p => `<li><span>${esc(p.name)}<small>${esc(p.path)}</small></span><button class="danger" data-rm="${esc(p.name)}">Remove</button></li>`).join('') || '<li class="muted">No projects.</li>'}</ul>
    <form method="dialog" id="addForm">
      <p class="muted">Add a local checkout with a <code>quest/</code> directory.</p>
      <input id="pp" placeholder="~/path/to/repo" required autocomplete="off" aria-label="Repository path">
      <input id="pn" placeholder="Name (optional)" autocomplete="off" aria-label="Project name">
      <p id="pe" class="err" role="alert"></p>
      ${health?.config ? `<p class="muted"><small>Saved in <code>${esc(health.config)}</code></small></p>` : ''}
      <div class="actions end"><button type="button" data-close>Close</button><button class="primary" type="submit">ADD</button></div>
    </form>`;
  d.onclose = null;
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    const r = await api('/api/projects/remove', { name: b.dataset.rm });
    if (r.error) return toast(r.error);
    if (data) data.projects = data.projects.filter(p => p.name !== b.dataset.rm); // never redraw the removed project
    await load(true); projectsDialog();
  });
  d.querySelector('#addForm').onsubmit = async (e) => {
    e.preventDefault();
    const r = await api('/api/projects', { path: d.querySelector('#pp').value.trim(), name: d.querySelector('#pn').value.trim() });
    if (r.error) { d.querySelector('#pe').textContent = r.error; return; }
    d.close(); toast('PROJECT ADDED'); load();
  };
  if (!d.open) d.showModal();
  d.querySelector('#pp').focus();
}

function save() {
  try { localStorage.setItem('quest-board', JSON.stringify({ project: state.project, status: state.status, q: state.q, view: state.view, iso: state.iso, theme: state.theme })); } catch {}
}

/** Arrow keys move between cards in a column, rows in the Inbox, or nodes on the Map; left/right switch columns. */
function moveFocus(el, dir) {
  const items = (box) => [...box.querySelectorAll('.card,.row,.gn')];
  const box = el.closest('.col,.inbox,svg'); if (!box) return false;
  const sibs = items(box), i = sibs.indexOf(el);
  let t;
  if (dir === 'ArrowDown') t = sibs[i + 1];
  else if (dir === 'ArrowUp') t = sibs[i - 1];
  else if (box.matches('.col')) {
    const cols = [...document.querySelectorAll('#board .col')], next = cols[cols.indexOf(box) + (dir === 'ArrowRight' ? 1 : -1)];
    if (next) { const n = items(next); t = n[Math.min(i, n.length - 1)]; }
  }
  if (!t) return false;
  t.focus({ preventScroll: true });
  t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

document.addEventListener('click', (e) => {
  if (e.target.closest('a[href]')) return; // let external links open
  const t = e.target.closest('[data-k],[data-v],[data-s],[data-a],[data-copy],[data-clear],#close,#refresh,#addProj,#projects,#theme');
  if (!t || t.closest('dialog')) return;
  if (t.dataset.v) { state.view = t.dataset.v; render(); }
  else if (t.dataset.s) { state.status = t.dataset.s; render(); }
  else if (t.dataset.a) act(t.dataset.a);
  else if (t.dataset.copy !== undefined) navigator.clipboard.writeText(t.dataset.copy).then(() => toast('COPIED'), () => toast('COPY FAILED'));
  else if (t.dataset.clear !== undefined) { state.status = 'all'; state.q = ''; $('#q').value = ''; render(); }
  else if (t.dataset.k) openPanel(t.dataset.k);
  else if (t.id === 'close') closePanel();
  else if (t.id === 'refresh') load();
  else if (t.id === 'addProj' || t.id === 'projects') projectsDialog();
  else if (t.id === 'theme') {
    state.theme = isDark() ? 'day' : 'night';
    document.documentElement.dataset.theme = state.theme;
    renderThemeButton();
    save();
  }
});
document.addEventListener('change', (e) => { if (e.target.id === 'iso') { state.iso = e.target.checked; render(); } });
$('#project').onchange = (e) => { state.project = e.target.value; render(); };
$('#q').value = state.q;
$('#q').oninput = (e) => { state.q = e.target.value; render(); };
window.addEventListener('focus', () => { if (Date.now() - loadedAt > 60000) load(true); });
matchMedia('(prefers-color-scheme: light)').addEventListener('change', renderThemeButton);
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || $('#dlg').open;
  if (e.key === 'Escape' && state.sel && !$('#dlg').open) { closePanel(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); $('#q').focus(); return; }
  if (e.key === 'r') { load(); return; }
  const view = VIEWS[Number(e.key) - 1];
  if (view && data?.projects.length) { state.view = view[0]; render(); return; }
  const el = document.activeElement, k = el?.dataset?.k;
  if (k && e.key.startsWith('Arrow') && moveFocus(el, e.key)) { e.preventDefault(); return; }
  if ((e.key === 'Enter' || e.key === ' ') && k && !e.target.closest('button,a[href]')) { e.preventDefault(); openPanel(k); }
});
render();
load();
