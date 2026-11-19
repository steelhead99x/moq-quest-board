const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUSES = [['all', 'All'], ['ready', 'Ready'], ['needs-you', 'Needs you'], ['waiting', 'Waiting'], ['claimed', 'Claimed'], ['blocked', 'Blocked'], ['epic', 'Epics']];
const VIEWS = [['board', 'Board'], ['graph', 'Map'], ['inbox', 'Inbox']];
const LABEL = { ready: 'Ready', 'needs-you': 'Needs you', waiting: 'Waiting', claimed: 'Claimed', blocked: 'Blocked', epic: 'Epic' };
const CLAIMABLE = ['ready', 'needs-you', 'waiting'];
const claimBranch = (id) => id.replace(/\.md$/, '');
let data = null, health = null, claims = {}, loadError = null, busy = false, returnFocus = null;
const claimsPending = new Set(); // projects whose open PRs are being (re)fetched
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
async function runLoad(quiet, waiters) {
  running = true;
  try { await fetchBoard(quiet); } catch (e) { loadError = e.message; render(); }
  finally {
    running = false; loadedAt = Date.now();
    waiters.forEach((r) => r());
    if (queued) { const n = queued; queued = null; runLoad(n.quiet, n.waiters); }
  }
}
async function fetchBoard(quiet) {
  if (!quiet && !data) $('#stats').textContent = 'LOADING…';
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
  if (cache) return cache;
  const out = [];
  for (const p of data.projects) {
    const byBranch = new Map((claims[p.name]?.prs || []).map(x => [x.headRefName, x]));
    for (const q of p.quests) {
      const pr = byBranch.get(claimBranch(q.id));
      out.push({ ...q, project: p.name, pr, display: pr ? 'claimed' : q.status });
    }
  }
  return (cache = out);
}
const key = (q) => q.project + '::' + q.id;
const inProject = (q) => state.project === 'all' || q.project === state.project;

function visible() {
  const s = state.q.toLowerCase();
  return all().filter(q => q.kind !== 'root' && inProject(q)
    && (state.status === 'all' || q.display === state.status)
    && (!s || (q.title + ' ' + q.id + ' ' + q.goal).toLowerCase().includes(s)));
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
  if (!data) { $('#stats').innerHTML = ''; $('#board').innerHTML = ''; renderPanel(); return; }
  if (state.project !== 'all' && !data.projects.some(p => p.name === state.project)) state.project = 'all';
  $('#project').innerHTML = '<option value="all">All projects</option>' + data.projects.map(p => `<option value="${esc(p.name)}" ${p.name === state.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#viewChips').innerHTML = VIEWS.map(([k, l]) => `<button class="chip ${state.view === k ? 'on' : ''}" data-v="${k}" aria-pressed="${state.view === k}">${l}</button>`).join('');
  $('#statusChips').innerHTML = STATUSES.map(([k, l]) => `<button class="chip ${state.status === k ? 'on' : ''}" data-s="${k}" aria-pressed="${state.status === k}">${l}</button>`).join('');
  $('#statusChips').hidden = state.view === 'inbox'; // the Inbox lists waiting items whatever their status
  const every = all().filter(q => q.kind !== 'root' && inProject(q));
  const n = (st) => every.filter(q => q.display === st).length;
  $('#stats').innerHTML = data.projects.length
    ? `<span class="ready">READY <b>${n('ready')}</b></span><span class="needs">NEED YOU <b>${n('needs-you')}</b></span><span class="waiting">WAITING <b>${n('waiting')}</b></span><span class="claimed">CLAIMED <b>${n('claimed')}</b></span><span class="blocked">BLOCKED <b>${n('blocked')}</b></span><span>WORLDS <b>${data.projects.length}</b></span>`
    : '';
  if (!data.projects.length) { $('#board').innerHTML = startScreen(); renderPanel(); save(); return; }
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
    if (health && !health.quest) b.push('The <code>quest</code> command was not found, so nothing can be ranked as ready. Install it from <a class="link" style="display:inline" href="https://github.com/moq-dev/quest" target="_blank" rel="noopener">moq-dev/quest</a> or set <code>QUEST_BIN</code>.');
    if (health && !health.gh) b.push('The <code>gh</code> command was not found, so claims (open PRs) are not shown.');
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

function startScreen() {
  return `<div class="start"><h2>QUEST BOARD</h2>
    <p>Track the quests in every repository that keeps a <code>quest/</code> log, see what is ready, what waits on you, and claim work.</p>
    <div class="press">PRESS START</div>
    <button class="primary" id="addProj">+ Add a repository</button>
    <p style="color:var(--muted)">Or run <code>quest-board ~/path/to/repo</code>. Projects are saved in <code>${esc(health?.config || 'projects.json')}</code>.</p></div>`;
}

// ---- board and inbox -----------------------------------------------------------
function renderBoard(list) {
  const cols = {};
  for (const q of list) (cols[q.milestone || '—'] ||= []).push(q);
  const names = Object.keys(cols).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  $('#board').innerHTML = names.length ? names.map(m => {
    const items = cols[m].sort((a, b) => (b.dependents ?? -1) - (a.dependents ?? -1) || a.id.localeCompare(b.id));
    return `<section class="col px"><h2>STAGE ${esc(m)} <span>${items.length}</span></h2>${items.map(card).join('')}</section>`;
  }).join('') : '<div class="empty">No quests match.</div>';
}

function card(q) {
  const sz = q.size ? `<span class="sz ${q.size}">${q.size}</span>` : '';
  const proj = data.projects.length > 1 ? `<span class="tag">${esc(q.project)}</span>` : '';
  const dep = q.dependents ? `<span title="quests this unblocks">+${q.dependents} XP</span>` : '';
  const pr = q.pr ? `<span>PR #${q.pr.number}${q.pr.isDraft ? ' draft' : ''}</span>` : '';
  const epic = q.epic ? `<span class="tag">${esc(q.epic.split('/').slice(-2, -1)[0])}</span>` : '';
  return `<div class="card ${q.display} ${state.sel === key(q) ? 'sel' : ''}" data-k="${esc(key(q))}" tabindex="0" role="button">
    <div class="t">${esc(q.title)}</div>
    <div class="meta">${sz}<span class="st ${q.display}">${LABEL[q.display] || q.display}</span>${dep}${pr}${proj}${epic}</div></div>`;
}

function renderInbox() {
  const s = state.q.toLowerCase();
  const items = all().filter(q => q.waiting.length && inProject(q)
    && (!s || (q.title + ' ' + q.id + ' ' + q.waiting.map(w => w.party + ' ' + w.text).join(' ')).toLowerCase().includes(s)));
  const mine = (q) => q.waitsOnYou; // "you" is the Maintainer party, as the server decides it
  const rank = (a, b) => (a.milestone || '').localeCompare(b.milestone || '', undefined, { numeric: true }) || ((b.dependents ?? 0) - (a.dependents ?? 0)) || a.id.localeCompare(b.id);
  const row = (q) => `<div class="row ${mine(q) ? '' : 'other'} ${state.sel === key(q) ? 'sel' : ''}" data-k="${esc(key(q))}" tabindex="0" role="button">
    <div class="t">${esc(q.title)}</div>
    ${q.waiting.map(w => `<div class="w"><b>${esc(w.party)}:</b> ${esc(w.text)}</div>`).join('')}
    <div class="meta">${q.size ? `<span class="sz ${q.size}">${q.size}</span>` : ''}<span class="tag">${esc(q.project)}</span>${q.milestone ? `<span class="tag">${esc(q.milestone)}</span>` : ''}${q.dependents ? `<span>+${q.dependents} XP</span>` : ''}${q.pr ? `<span>PR #${q.pr.number}</span>` : ''}</div></div>`;
  const a = items.filter(mine).sort(rank), b = items.filter(q => !mine(q)).sort(rank);
  $('#board').innerHTML = `<div class="inbox">${a.length ? `<h2>WAITING ON YOU (${a.length})</h2>${a.map(row).join('')}` : ''}${b.length ? `<h2>WAITING ON OTHERS (${b.length})</h2>${b.map(row).join('')}` : ''}${items.length ? '' : '<div class="empty">Nothing is waiting.</div>'}</div>`;
}

// ---- map -----------------------------------------------------------------------
function renderGraph(list) {
  const board = $('#board'), old = board.querySelector('.graphwrap');
  const sl = old?.scrollLeft || 0, st = old?.scrollTop || 0;
  const byId = new Map(list.map(q => [key(q), q]));
  const edges = [], inn = new Map();
  const push = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v);
  for (const q of list) for (const r of q.required) {
    const a = q.project + '::' + r.target, b = key(q);
    if (!byId.has(a)) continue;
    edges.push([a, b]); push(inn, b, a);
  }
  const connected = new Set(edges.flat());
  const nodes = list.filter(q => state.iso || connected.has(key(q)));
  if (!nodes.length) { board.innerHTML = '<div class="empty">No dependencies among the quests shown. Try clearing the filters.</div>'; return; }
  // Longest-path layering: a quest sits one column right of its deepest blocker.
  const layer = new Map(), onStack = new Set();
  const depth = (k) => {
    if (layer.has(k)) return layer.get(k);
    if (onStack.has(k)) return 0; // cycle: quest check reports these
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
  // An edge spanning more than one layer gets a dummy node in each layer it crosses, so it takes
  // a row slot there (and is routed around real nodes) instead of running behind them.
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
  const W = 240, H = 44, GX = 80, GY = 16, P = 20, CH = 8; // CH: pixels between parallel vertical channels
  // Each source gets its own vertical channel in the gap after its layer; wide gaps make room for many.
  const gapSources = layers.map((L) => L.filter(k => (sout.get(k) || []).length));
  const gapW = gapSources.map(S => Math.max(GX, CH * (S.length + 1)));
  const colX = []; let cx0 = P;
  layers.forEach((_, i) => { colX[i] = cx0; cx0 += W + gapW[i]; });
  const xy = new Map();
  layers.forEach((L, i) => L.forEach((k, j) => xy.set(k, [colX[i], P + j * (H + GY)])));
  const channel = new Map(); // source -> x of its vertical channel
  gapSources.forEach((S, i) => S.forEach((k, s) => channel.set(k, colX[i] + W + Math.round(gapW[i] * (s + 1) / (S.length + 1)))));
  const width = cx0 - gapW[layers.length - 1] + P + 4, height = P * 2 + Math.max(...layers.map(L => L.length)) * (H + GY);
  const out = new Map();
  for (const [a, b] of edges) push(out, a, b);
  let rel = null;
  if (state.sel && xy.has(state.sel)) {
    rel = new Set([state.sel]);
    for (const m of [out, inn]) { const stack = [state.sel]; while (stack.length) for (const n of m.get(stack.pop()) || []) if (!rel.has(n)) { rel.add(n); stack.push(n); } }
  }
  // Orthogonal, pixel-style edges: out of a source's right side, down its own channel, into the next column.
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
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="group" aria-label="Quest dependency map">
    <defs><clipPath id="lbl"><rect x="14" y="0" width="${W - 20}" height="${H}"/></clipPath></defs>
    ${chains.map(c => `<path class="ge ${rel ? (rel.has(c[0]) && rel.has(c[c.length - 1]) ? 'hi' : 'dim') : ''}" d="${route(c)}"/>`).join('')}
    ${nodes.map(q => {
      const k = key(q), [x, y] = xy.get(k), t = q.title.length > 30 ? q.title.slice(0, 29) + '…' : q.title;
      const label = `${q.title}, ${(LABEL[q.display] || q.display).toLowerCase()}${q.size ? ', size ' + q.size : ''}${data.projects.length > 1 ? ', ' + q.project : ''}`;
      return `<g class="gn ${q.display} ${state.sel === k ? 'sel' : ''} ${rel && !rel.has(k) ? 'dim' : ''}" data-k="${esc(k)}" tabindex="0" role="button" aria-label="${esc(label)}" transform="translate(${x},${y})"><title>${esc(q.title)}</title>
        <rect class="sh" x="4" y="4" width="${W}" height="${H}"/><rect class="box" width="${W}" height="${H}"/><rect class="bar" width="8" height="${H}"/>
        <text x="16" y="19" clip-path="url(#lbl)">${esc(t)}</text><text class="sub" x="16" y="36" clip-path="url(#lbl)">${q.size ? q.size + ' ' : ''}${(LABEL[q.display] || q.display).toUpperCase()}${data.projects.length > 1 ? ' ' + esc(q.project) : ''}</text></g>`;
    }).join('')}
  </svg>`;
  board.innerHTML = `<div class="graphwrap"><div class="glegend"><span>${nodes.length} quests · ${edges.length} links · blockers left, dependents right · click a quest to trace its path</span><label><input type="checkbox" id="iso" ${state.iso ? 'checked' : ''}> show lone quests</label></div>${svg}</div>`;
  const w = board.querySelector('.graphwrap'); w.scrollLeft = sl; w.scrollTop = st;
}

// ---- detail panel ----------------------------------------------------------------
function find(k) { return all().find(q => key(q) === k); }

function renderPanel() {
  const panel = $('#panel');
  const q = data && state.sel ? find(state.sel) : null;
  if (!q) { state.sel = null; panel.classList.remove('open'); panel.setAttribute('inert', ''); return; }
  const lookup = (t) => all().find(x => x.project === q.project && x.id === t);
  const linkList = (arr, field) => arr.length ? arr.map(r => {
    const id = field ? r[field] : r, tq = lookup(id);
    return `<a class="link" data-k="${esc(q.project + '::' + id)}" tabindex="0" role="button">${esc(tq?.title || r.label || id)} ${tq ? `<span class="st ${tq.display}">${LABEL[tq.display] || ''}</span>` : '<span class="err">(missing)</span>'}${r.why ? `<span style="color:var(--muted)"> — ${esc(r.why)}</span>` : ''}</a>`;
  }).join('') : '<p style="color:var(--muted)">None</p>';
  const canClaim = CLAIMABLE.includes(q.status) && !q.pr;
  const unknown = claimsPending.has(q.project) || !claims[q.project]; // do not offer a claim until open PRs are known
  const dis = busy ? ' disabled' : '';
  const out = outputs[key(q)];
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:8px"><span class="tag">${esc(q.project)} · ${esc(q.id)}</span><button id="close" aria-label="Close">✕</button></div>
    <h3 tabindex="-1">${q.size ? `<span class="sz ${q.size}">${q.size}</span> ` : ''}${esc(q.title)}</h3>
    <div class="meta"><span class="st ${q.display}">${LABEL[q.display] || q.display}</span>${q.dependents ? `<span>unblocks ${q.dependents}</span>` : ''}${q.scheduled ? `<span>scheduled ${esc(q.scheduled.split('\n')[0].replace(/^[-*]\s*/, ''))}</span>` : ''}${q.pr ? `<a class="link" style="display:inline" target="_blank" rel="noopener" href="${esc(q.pr.url)}">PR #${q.pr.number}${q.pr.isDraft ? ' (draft)' : ''}</a>` : ''}</div>
    <div class="actions">
      ${canClaim ? `<button class="primary" data-a="claim"${busy || unknown ? ' disabled' : ''}${unknown ? ' title="Checking open PRs…"' : ''}>CLAIM QUEST</button>` : ''}
      ${q.pr && q.pr.isDraft ? `<button class="danger" data-a="release"${dis}>Release claim</button>` : ''}
      ${q.status === 'blocked' ? `<button data-a="blockers"${dis}>Why blocked?</button>` : ''}
      <button data-a="open-file"${dis}>Open file</button>
      <button data-copy="${esc(q.id)}">Copy path</button>
    </div>
    <div id="out" aria-live="polite">${out ? `<pre class="${out.err ? 'err' : ''}">${esc(out.text)}</pre>` : ''}</div>
    ${q.waiting.length ? `<h4>WAITING ON</h4>${q.waiting.map(w => `<p><b>${esc(w.party)}:</b> ${esc(w.text)}</p>`).join('')}` : ''}
    <h4>GOAL</h4><p>${esc(q.goal) || '—'}</p>
    <h4>REQUIRED (${q.required.length})</h4>${linkList(q.required, 'target')}
    <h4>UNBLOCKS (${q.requiredBy.length})</h4>${linkList(q.requiredBy)}
    ${q.related.length ? `<h4>RELATED</h4>${linkList(q.related, 'target')}` : ''}
    ${q.plan ? `<h4>PLAN</h4><pre>${esc(q.plan)}</pre>` : ''}
    ${q.hosts ? `<h4>HOSTS</h4><pre>${esc(q.hosts)}</pre>` : ''}`;
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
  if (a === 'claim' || a === 'release') {
    const msg = a === 'claim'
      ? `Claim "${q.title}"?\n\nThis pushes an empty claim commit to the branch ${claimBranch(q.id)} and opens a draft PR on GitHub. It also switches the ${q.project} checkout to that branch.`
      : `Release the claim on "${q.title}"?\n\nThis deletes the claim branch and closes its draft PR, but only while the branch holds nothing but the empty claim commit.`;
    if (!(await confirmDialog(a === 'claim' ? 'ACCEPT QUEST?' : 'ABANDON QUEST?', msg, a === 'claim' ? 'Claim' : 'Release'))) return;
  }
  const k = key(q);
  busy = true;
  setOut(k, 'Running…', false);
  try {
    const r = await api('/api/action', { project: q.project, quest: q.id, action: a });
    setOut(k, r.output || r.error || 'Done.', r.ok === false || !!r.error);
    if (a === 'claim' || a === 'release') {
      toast(r.ok ? (a === 'claim' ? 'QUEST ACCEPTED!' : 'QUEST RELEASED') : 'FAILED');
      await load(true); // the claim changes the tree's PRs and possibly the checked-out branch
    }
  } finally {
    busy = false;
    if (state.sel === k) { refreshPanel(); if (!$('#panel').contains(document.activeElement)) ($(`#panel [data-a="${a}"]`) || $('#panel h3'))?.focus({ preventScroll: true }); }
  }
}

function confirmDialog(title, msg, label) {
  return new Promise((res) => {
    const d = $('#dlg');
    d.innerHTML = `<h3>${esc(title)}</h3><p style="white-space:pre-wrap">${esc(msg)}</p><div class="actions" style="justify-content:flex-end"><button data-r="0">Cancel</button><button data-r="1" class="primary">${esc(label)}</button></div>`;
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
    <ul class="plist">${list.map(p => `<li><span>${esc(p.name)}<small>${esc(p.path)}</small></span><button class="danger" data-rm="${esc(p.name)}">Remove</button></li>`).join('') || '<li style="color:var(--muted)">None yet.</li>'}</ul>
    <form method="dialog" id="addForm">
      <p style="color:var(--muted)">Add a local checkout with a <code>quest/</code> directory.</p>
      <input id="pp" placeholder="~/path/to/repo" required autocomplete="off">
      <input id="pn" placeholder="Name (optional)" autocomplete="off">
      <p id="pe" class="err" role="alert"></p>
      <div class="actions" style="justify-content:flex-end"><button type="button" data-close>Close</button><button class="primary" type="submit">Add</button></div>
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

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-k],[data-v],[data-s],[data-a],[data-copy],#close,#refresh,#addProj,#projects,#theme');
  if (!t || t.closest('dialog')) return;
  if (t.dataset.v) { state.view = t.dataset.v; render(); }
  else if (t.dataset.s) { state.status = t.dataset.s; render(); }
  else if (t.dataset.a) act(t.dataset.a);
  else if (t.dataset.copy) navigator.clipboard.writeText(t.dataset.copy).then(() => toast('COPIED'), () => toast('Copy failed'));
  else if (t.dataset.k) openPanel(t.dataset.k);
  else if (t.id === 'close') closePanel();
  else if (t.id === 'refresh') load();
  else if (t.id === 'addProj' || t.id === 'projects') projectsDialog();
  else if (t.id === 'theme') {
    const dark = state.theme ? state.theme === 'night' : !matchMedia('(prefers-color-scheme: light)').matches;
    state.theme = dark ? 'day' : 'night';
    document.documentElement.dataset.theme = state.theme;
    save();
  }
});
document.addEventListener('change', (e) => { if (e.target.id === 'iso') { state.iso = e.target.checked; render(); } });
$('#project').onchange = (e) => { state.project = e.target.value; render(); };
$('#q').value = state.q;
$('#q').oninput = (e) => { state.q = e.target.value; render(); };
window.addEventListener('focus', () => { if (Date.now() - loadedAt > 60000) load(true); });
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
  if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); return; }
  const k = document.activeElement?.dataset?.k;
  if ((e.key === 'Enter' || e.key === ' ') && !typing && k && !e.target.closest('button,a[href]')) { e.preventDefault(); openPanel(k); return; }
  if (e.key === 'Escape' && state.sel && !$('#dlg').open) closePanel();
});
load();
