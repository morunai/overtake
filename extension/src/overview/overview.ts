// Spaces overview: stable card order, a selection ring, hover controls, one caption line,
// a "+" tile and a keyboard hint.
import { human, ownerState, activity, controls, identityOf, el, activeTab, host, type Snapshot, type SpaceV } from './ui.ts';
import { AGENT_LOGO } from '../ui/identity.ts';

let snap: Snapshot = { spaces: [], agents: [], brokerConnected: false, strictInputGate: null };
const previews: Record<number, { dataUrl: string; at: number }> = {};
const busy = new Set<number>();
let selected: number | null = null;
let confirming: number | null = null;
let renaming: number | null = null;
let menuFor: number | null = null;
let detailsOpen = false;
let newTileNode: HTMLElement | null = null;
let firstSnapshot = true;

const grid = document.getElementById('grid')!;
const panel = document.getElementById('panel')!;
const toast = document.getElementById('toast')!;
const menu = document.getElementById('menu')!;
const titleBtn = document.getElementById('title')!;
const agentsBtn = document.getElementById('agents')!;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

const svg = (body: string, vb = '0 0 16 16') => `<svg viewBox="${vb}" aria-hidden="true">${body}</svg>`;
const ICONS: Record<string, string> = {
  takeover: svg('<path d="M5.5 8V3.6a1.1 1.1 0 0 1 2.2 0V7m0-.6V2.6a1.1 1.1 0 0 1 2.2 0V7m0-.4V3.8a1.1 1.1 0 0 1 2.2 0v5.4c0 2.7-1.8 4.8-4.4 4.8-1.8 0-2.7-.8-3.7-2.2L2.6 9.1a1.1 1.1 0 0 1 1.8-1.3L5.5 9.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'),
  pause: svg('<rect x="4" y="3" width="2.6" height="10" rx="1" fill="currentColor"/><rect x="9.4" y="3" width="2.6" height="10" rx="1" fill="currentColor"/>'),
  resume: svg('<path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.4-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5Z" fill="currentColor"/>'),
  stop: svg('<rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor"/>'),
  giveback: svg('<path d="M6 4 2.5 7.5 6 11M3 7.5h6.5a4 4 0 0 1 4 4V13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'),
  dismissError: svg('<path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  close: svg('<path d="m4 4 8 8m0-8-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'),
  plus: svg('<path d="M20 6v28M6 20h28" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>', '0 0 40 40'),
  more: svg('<circle cx="3.5" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="12.5" cy="8" r="1.4" fill="currentColor"/>'),
  tabs: svg('<rect x="2.5" y="4.5" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 2.5h6.5a2 2 0 0 1 2 2V11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'),
  user: svg('<circle cx="8" cy="5.6" r="2.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 13.5c.8-2.4 2.7-3.6 5-3.6s4.2 1.2 5 3.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'),
};

function flash(msg: string) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

async function act(action: string, spaceId?: number, extra?: Record<string, unknown>) {
  try {
    await human(action, spaceId, extra);
  } catch (e) {
    flash((e as Error).message);
  }
}

/** Stable order (oldest first): a card never jumps because its state changed. */
function ordered(): SpaceV[] {
  return [...snap.spaces].sort((a, b) => a.createdAt - b.createdAt || a.spaceId - b.spaceId);
}

/** Compact status pill. A strong accent only where the user is needed. */
function pill(s: SpaceV): { cls: string; text: string } | null {
  if (s.error) return { cls: 'failed', text: 'Failed' };
  if (s.control === 'AGENT_CONTROL') return { cls: 'running', text: 'Running' };
  if (s.userReason === 'handoff') return { cls: 'attention', text: 'Needs you' };
  if (s.control === 'AGENT_PAUSED') return { cls: 'quiet', text: 'Paused' };
  if (s.control === 'STOPPED') return { cls: 'quiet', text: 'Stopped' };
  if (s.userReason === 'takeover') return { cls: 'quiet', text: 'You have control' };
  if (s.userReason === 'agent-disconnected') return { cls: 'quiet', text: 'Agent left' };
  return null;
}

function who(s: SpaceV): string {
  const id = identityOf(s);
  if (id) return id.label;
  return s.createdBy === 'user' ? 'You' : '';
}

/** Columns that keep previews near 428 px at a 2000 px wide window. */
function layoutCards() {
  const style = getComputedStyle(grid);
  const avail = grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  if (avail <= 0) return;
  const gap = parseFloat(style.columnGap) || 0;
  const target = 480;
  let cols = Math.max(1, Math.round((avail + gap) / (target + gap)));
  const width = () => (avail - (cols - 1) * gap) / cols;
  while (width() > 640) cols++;
  while (cols > 1 && width() < 300) cols--;
  grid.style.setProperty('--columns', String(cols));
  grid.style.setProperty('--card-width', `${Math.floor(width())}px`);
  placeHint();
}

/** The keyboard hint sits at the bottom, but never on top of a Space. */
function placeHint() {
  const hint = document.getElementById('hint')!;
  const last = grid.lastElementChild?.getBoundingClientRect();
  const top = innerHeight - hint.offsetHeight - 24;
  hint.classList.toggle('covered', !!last && last.bottom + 16 > top);
}
addEventListener('scroll', placeHint, { passive: true });
new ResizeObserver(layoutCards).observe(grid);

function columns(): number {
  return Number(grid.style.getPropertyValue('--columns')) || 1;
}

function card(s: SpaceV): HTMLElement {
  const prev = previews[s.spaceId];
  const shot = el('div', { class: 'shot' });
  if (prev) shot.append(el('img', { src: prev.dataUrl, alt: '' }));
  else shot.append(el('div', { class: 'empty' }, host(activeTab(s)?.url) || 'No preview yet'));
  shot.append(el('div', { class: 'glow' }), el('div', { class: 'status' }));

  const hov = el('div', { class: 'hov' });
  for (const c of controls(s)) {
    const b = el('button', { class: `round${c.action === 'stop' ? ' danger' : ''}`, title: c.label, 'aria-label': c.label });
    b.innerHTML = ICONS[c.action] ?? ICONS.dismissError;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      void act(c.action, s.spaceId);
    });
    hov.append(b);
  }
  const x = el('button', { class: 'round end', title: 'Close Space', 'aria-label': 'Close Space' });
  x.innerHTML = ICONS.close;
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    confirming = s.spaceId;
    render();
  });
  hov.append(x);

  const frame = el('div', { class: 'frame' }, shot, hov);
  if (confirming === s.spaceId) {
    const yes = el('button', { class: 'danger' }, 'Close');
    const no = el('button', {}, 'Cancel');
    yes.addEventListener('click', (e) => {
      e.stopPropagation();
      confirming = null;
      void act('close', s.spaceId);
    });
    no.addEventListener('click', (e) => {
      e.stopPropagation();
      confirming = null;
      render();
    });
    frame.append(el('div', { class: 'confirm' }, el('p', {}, s.control === 'AGENT_CONTROL' ? 'Stop the task and close this Space?' : 'Close this Space and its window?'), el('div', {}, no, yes)));
  }

  const p = pill(s);
  const name = renaming === s.spaceId ? renameInput(s) : (() => {
    const n = el('span', { class: 'name', title: 'Double-click to rename' }, s.name);
    n.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      renaming = s.spaceId;
      render();
    });
    n.addEventListener('click', (e) => e.detail > 1 && e.stopPropagation());
    return n;
  })();
  const id = identityOf(s);
  const badge = el('span', { class: `who${id ? '' : ' user'}`, title: who(s) || 'Agent', 'aria-label': who(s) || 'Agent' });
  badge.innerHTML = id ? AGENT_LOGO[id.kind] : s.createdBy === 'user' ? ICONS.user : AGENT_LOGO.generic;
  const tabs = el('span', { class: 'tabs', title: `${s.tabs.length} tab${s.tabs.length === 1 ? '' : 's'}` });
  tabs.innerHTML = ICONS.tabs;
  tabs.append(el('span', {}, tabCount(s)));
  const more = el('button', { class: 'more', title: 'More', 'aria-label': 'More actions', 'aria-haspopup': 'menu', 'aria-expanded': String(menuFor === s.spaceId) });
  more.innerHTML = ICONS.more;
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    menuFor = menuFor === s.spaceId ? null : s.spaceId;
    render();
  });
  const cap = el('div', { class: 'cap' }, badge, name, p ? el('span', { class: `pill ${p.cls}` }, p.text) : null, tabs, more);
  if (menuFor === s.spaceId) cap.append(cardMenu(s));

  const c = el('article', { class: 'card', tabindex: '0', 'data-space': String(s.spaceId) }, frame, cap, el('div', { class: 'flow' }));
  // One click opens the Space. Never rebuild the grid from pointer or focus handlers:
  // replacing the card between mousedown and mouseup makes the browser drop the click.
  c.addEventListener('click', (e) => {
    if (e.detail > 1) return; // the second click of a double click (rename) is not a second open
    select(s.spaceId);
    openSpace(s.spaceId);
  });
  c.addEventListener('focus', () => select(s.spaceId));
  return c;
}

const tabCount = (s: SpaceV) => String(s.tabs.length);

/** The "..." menu on a card: rename, details, close. */
function cardMenu(s: SpaceV): HTMLElement {
  const item = (label: string, run: () => void, cls = '') => {
    const b = el('button', { role: 'menuitem', class: cls }, label);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      menuFor = null;
      run();
    });
    return b;
  };
  const pop = el('div', { class: 'pop', role: 'menu' },
    item('Rename', () => { renaming = s.spaceId; render(); }),
    item(detailsOpen && selected === s.spaceId ? 'Hide details' : 'Show details', () => { select(s.spaceId); toggleDetails(!(detailsOpen && selected === s.spaceId)); render(); }),
    item('Close Space', () => { confirming = s.spaceId; render(); }, 'danger'),
  );
  pop.addEventListener('click', (e) => e.stopPropagation());
  return pop;
}

function renameInput(s: SpaceV): HTMLElement {
  const i = el('input', { value: s.name, 'aria-label': 'Space name', maxlength: '80' });
  const commit = async () => {
    if (renaming !== s.spaceId) return;
    renaming = null;
    if (i.value.trim() && i.value.trim() !== s.name) await act('rename', s.spaceId, { name: i.value });
    render();
  };
  i.addEventListener('click', (e) => e.stopPropagation());
  i.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') void commit();
    if (e.key === 'Escape') {
      renaming = null;
      render();
    }
  });
  i.addEventListener('blur', () => void commit());
  setTimeout(() => i.select(), 0);
  return el('span', { class: 'name' }, i);
}

/** Card structure: anything that changes which elements a card has. Text and state
 *  classes are patched in place (patchCard), so frequent agent updates never rebuild it. */
function cardKey(s: SpaceV): string {
  return [pill(s)?.text ?? '', controls(s).map((c) => c.action).join(','), confirming === s.spaceId, renaming === s.spaceId, menuFor === s.spaceId, who(s), s.createdBy, !!previews[s.spaceId]].join('|');
}

function patchCard(c: HTMLElement, s: SpaceV) {
  const st = ownerState(s);
  const cls = `card ${st.key}${busy.has(s.spaceId) ? ' busy' : ''}${selected === s.spaceId ? ' sel' : ''}`;
  if (c.className !== cls) c.className = cls;
  c.setAttribute('aria-label', `${s.name}${pill(s) ? `, ${pill(s)!.text}` : ''}`);
  const name = c.querySelector('.cap .name');
  if (name && renaming !== s.spaceId && name.textContent !== s.name) name.textContent = s.name;
  const tabs = c.querySelector('.cap .tabs span');
  if (tabs && tabs.textContent !== tabCount(s)) tabs.textContent = tabCount(s);
  const status = c.querySelector('.status');
  const a = activity(s);
  if (status && status.textContent !== a) status.textContent = a;
  const empty = c.querySelector('.shot .empty');
  const e = host(activeTab(s)?.url) || 'No preview yet';
  if (empty && empty.textContent !== e) empty.textContent = e;
}

function select(id: number) {
  if (selected === id) return;
  selected = id;
  for (const c of grid.querySelectorAll<HTMLElement>('.card[data-space]')) c.classList.toggle('sel', Number(c.dataset.space) === id);
  renderPanel();
}

/** Opening a Space: its preview grows to fill the view, then its window comes forward. */
function openSpace(id: number) {
  const frame = grid.querySelector<HTMLElement>(`.card[data-space="${id}"] .frame`);
  if (!frame || reduced.matches || document.body.classList.contains('entering')) {
    void act('switch', id);
    return;
  }
  const r = frame.getBoundingClientRect();
  const z = el('div', { class: 'zoom' });
  const img = frame.querySelector('img');
  if (img) z.append(el('img', { src: img.src, alt: '' }));
  Object.assign(z.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  document.body.append(z);
  document.body.classList.add('entering');
  void z.offsetWidth;
  Object.assign(z.style, { left: '0px', top: '0px', width: `${innerWidth}px`, height: `${innerHeight}px`, borderRadius: '0px' });
  setTimeout(() => void act('switch', id), 240);
  setTimeout(() => {
    z.remove();
    document.body.classList.remove('entering');
  }, 900);
}

function newTile(): HTMLElement {
  const t = el('button', { class: 'new', title: 'New Space (N)' }, el('b', {}, 'New Space'), el('span', {}, 'Open a browser window for an agent'));
  t.insertAdjacentHTML('afterbegin', ICONS.plus);
  t.addEventListener('click', () => void newSpace());
  return t;
}

async function newSpace() {
  await act('create', undefined, { name: `Space ${snap.spaces.length + 1}` });
}

function renderPanel() {
  panel.classList.toggle('open', detailsOpen);
  panel.setAttribute('aria-hidden', String(!detailsOpen));
  panel.inert = !detailsOpen;
  if (!detailsOpen) return;
  const s = snap.spaces.find((x) => x.spaceId === selected) || ordered()[0];
  panel.replaceChildren();
  const close = el('button', { class: 'close', title: 'Close (Esc)', 'aria-label': 'Close details' });
  close.innerHTML = ICONS.close;
  close.addEventListener('click', () => toggleDetails(false));
  panel.append(el('div', { class: 'head' }, el('b', {}, 'Details'), close));
  if (s) {
    panel.append(el('h2', {}, s.name));
    const dl = el('dl');
    const row = (k: string, v: string) => dl.append(el('dt', {}, k), el('dd', {}, v));
    row('space id', String(s.spaceId));
    row('window id', String(s.windowId ?? '—'));
    row('created by', s.createdBy);
    row('control', s.control);
    row('reason', s.userReason ?? '—');
    row('owner name', s.ownerName ?? '—');
    row('owner key', s.owner ?? '—');
    row('connected', String(s.ownerConnected));
    row('status', s.statusText || '—');
    panel.append(el('h3', {}, 'Space'), dl);
    panel.append(el('h3', {}, `Tabs (${s.tabs.length})`));
    for (const t of s.tabs) panel.append(el('div', { class: 'tab' }, `#${t.tabId} · ${t.openedBy}${t.managed ? ' · managed' : ''}${t.active ? ' · active' : ''}\n${t.url || ''}`));
    const free = snap.agents.filter((a) => a.connected);
    if (free.length && (!s.owner || !s.ownerConnected)) {
      const sel = el('select', { 'aria-label': 'Assign agent' }, el('option', { value: '' }, 'Assign to agent…'));
      for (const a of free) sel.append(el('option', { value: a.agentKey }, a.name));
      sel.addEventListener('change', () => sel.value && act('assign', s.spaceId, { agentKey: sel.value }));
      panel.append(el('h3', {}, 'Assign'), sel);
    }
    panel.append(el('p', { class: 'note' }, 'Spaces on this profile share cookies and storage. For a separate identity use the isolated Chrome mode.'));
  }
  panel.append(el('h3', {}, 'Bridge'));
  const dl = el('dl');
  dl.append(el('dt', {}, 'broker'), el('dd', {}, snap.brokerConnected ? 'connected' : 'offline'));
  dl.append(el('dt', {}, 'input gate'), el('dd', {}, snap.strictInputGate === false ? 'page-level only' : 'browser-level'));
  panel.append(dl, el('h3', {}, `Agents (${snap.agents.length})`));
  for (const a of snap.agents) panel.append(el('div', { class: 'tab' }, `${a.name}${a.connected ? '' : ' (disconnected)'}\n${a.agentKey}`));
}

function toggleDetails(open = !detailsOpen) {
  detailsOpen = open;
  const b = menu.querySelector('[data-menu="details"]');
  if (b) b.textContent = detailsOpen ? 'Hide details' : 'Show details';
  renderPanel();
}

function setMenu(open: boolean) {
  menu.hidden = !open;
  titleBtn.setAttribute('aria-expanded', String(open));
}
titleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setMenu(menu.hidden !== false);
});
menu.addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('[data-menu]');
  if (!item) return;
  setMenu(false);
  if (item.dataset.menu === 'new') void newSpace();
  if (item.dataset.menu === 'details') toggleDetails();
});
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node)) setMenu(false);
  if (menuFor !== null && !(e.target as HTMLElement).closest?.('.pop')) {
    menuFor = null;
    render();
  }
});
agentsBtn.addEventListener('click', () => toggleDetails());

// A card can still be rebuilt when its structure changes (e.g. control state). Never do
// that while a mouse button is down, or the click in progress is lost.
let held = false;
let renderPending = false;
addEventListener('pointerdown', () => (held = true), true);
addEventListener('pointerup', () => {
  held = false;
  setTimeout(() => {
    if (!held && renderPending) {
      renderPending = false;
      render();
    }
  }, 0);
}, true);

function render() {
  if (held) {
    renderPending = true;
    return;
  }
  const list = ordered();
  if (selected !== null && !list.some((s) => s.spaceId === selected)) selected = null;
  if (selected === null && list.length) {
    // Start on the Space that most needs the user, else the one an agent is driving.
    const pick = list.find((s) => s.userReason === 'handoff' || s.error) || list.find((s) => s.control === 'AGENT_CONTROL') || list[list.length - 1];
    selected = pick.spaceId;
  }
  document.getElementById('count')!.textContent = `${list.length} Space${list.length === 1 ? '' : 's'}`;
  const n = snap.agents.filter((a) => a.connected).length;
  document.getElementById('agentCount')!.textContent = String(n);
  agentsBtn.classList.toggle('off', !snap.brokerConnected);
  agentsBtn.title = snap.brokerConnected ? `${n} agent${n === 1 ? '' : 's'} connected` : 'Bridge offline: agents cannot reach Chrome';
  document.getElementById('bridge')!.textContent = agentsBtn.title;

  const focused = document.activeElement?.closest?.('.card') ? selected : null;
  // Keyed update: keep each card element while its structure is unchanged, patch text and
  // classes in place, and only touch the DOM where something actually moved.
  const existing = new Map<number, HTMLElement>();
  for (const c of grid.querySelectorAll<HTMLElement>('.card[data-space]')) existing.set(Number(c.dataset.space), c);
  const nodes: HTMLElement[] = [];
  for (const s of list) {
    const key = cardKey(s);
    let c = existing.get(s.spaceId);
    if (!c || c.dataset.key !== key) {
      c = card(s);
      c.dataset.key = key;
    }
    patchCard(c, s);
    nodes.push(c);
  }
  nodes.push(newTileNode ??= newTile());
  nodes.forEach((node, i) => {
    if (grid.children[i] !== node) grid.insertBefore(node, grid.children[i] ?? null);
  });
  while (grid.children.length > nodes.length) grid.lastElementChild!.remove();
  if (focused !== null && !document.activeElement?.closest?.('.card')) (grid.querySelector('.card.sel') as HTMLElement | null)?.focus({ preventScroll: true });
  renderPanel();
  layoutCards();
  document.title = `${list.length} Space${list.length === 1 ? '' : 's'} · Overtake`;
  const hintText = document.getElementById('hintText')!;
  const mode = list.length ? 'spaces' : 'empty';
  if (hintText.dataset.mode !== mode) {
    hintText.dataset.mode = mode;
    hintText.innerHTML = list.length
      ? 'Press <kbd>N</kbd> for a new Space, <kbd>⌥</kbd> <kbd>⇧</kbd> <kbd>S</kbd> to come back here'
      : '<b>Agents open a Space</b> when they start working. Press <kbd>N</kbd> to open one yourself';
  }
}

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  const list = ordered();
  const i = list.findIndex((s) => s.spaceId === selected);
  const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns(), ArrowUp: -columns() }[e.key];
  if (move !== undefined && list.length) {
    e.preventDefault();
    const next = list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i + move)))];
    select(next.spaceId);
    grid.querySelector<HTMLElement>(`.card[data-space="${next.spaceId}"]`)?.focus({ preventScroll: false });
  } else if (e.key === 'Enter' && selected !== null) {
    openSpace(selected);
  } else if (e.key === 'i') {
    toggleDetails();
  } else if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    void newSpace();
  } else if (e.key === 'Escape') {
    setMenu(false);
    if (detailsOpen) toggleDetails(false);
    if (menuFor !== null) {
      menuFor = null;
      render();
    }
    if (confirming !== null) {
      confirming = null;
      render();
    }
  }
});

let lastStatus = new Map<number, string>();
const port = chrome.runtime.connect({ name: 'overtake-overview' });
port.onMessage.addListener((msg) => {
  if (msg.type === 'overtake:spaces') {
    snap = msg;
    // "busy" = the agent's status changed recently (real activity reported by the bridge).
    for (const s of snap.spaces) {
      const key = `${s.statusText}|${s.tabs.map((t) => t.url).join()}`;
      if (!firstSnapshot && s.control === 'AGENT_CONTROL' && lastStatus.get(s.spaceId) !== key) {
        busy.add(s.spaceId);
        setTimeout(() => {
          busy.delete(s.spaceId);
          if (renaming === null) render();
        }, 4000);
      }
    }
    firstSnapshot = false;
    lastStatus = new Map(snap.spaces.map((s) => [s.spaceId, `${s.statusText}|${s.tabs.map((t) => t.url).join()}`]));
    if (renaming === null) render();
  } else if (msg.type === 'overtake:previews') {
    Object.assign(previews, msg.previews);
    // Swap preview images in place: no full re-render, no flicker.
    for (const [id, p] of Object.entries(msg.previews as Record<string, { dataUrl: string }>)) {
      const c = grid.querySelector(`.card[data-space="${Number(id)}"]`);
      const img = c?.querySelector('.shot img') as HTMLImageElement | null;
      if (img) img.src = p.dataUrl;
      else if (c && renaming === null) render();
    }
  }
});
