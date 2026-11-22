// Toolbar popup: an always-clickable escape route (it lives outside the page, so it
// works even while page input is gated) and a compact list of Spaces.
import { human, ownerState, activity, controls, identityOf, logo, el, iconButton, ICON, type Snapshot } from '../overview/ui.ts';

const list = document.getElementById('list')!;
const head = document.getElementById('head')!;

function render(snap: Snapshot, activeTabId: number | undefined) {
  const n = snap.agents.filter((a) => a.connected).length;
  head.className = snap.brokerConnected ? 'ok' : 'off';
  head.textContent = snap.brokerConnected ? `${n} agent${n === 1 ? '' : 's'} connected` : 'Bridge offline';
  const mine = (s: Snapshot['spaces'][number]) => s.tabs.some((t) => t.tabId === activeTabId);
  const sorted = [...snap.spaces].sort((a, b) => Number(mine(b)) - Number(mine(a)) || Number(b.control === 'AGENT_CONTROL') - Number(a.control === 'AGENT_CONTROL'));
  list.replaceChildren(
    ...sorted.map((s) => {
      const st = ownerState(s);
      const who = identityOf(s);
      const acts = el('div', { class: 'acts' });
      for (const c of controls(s)) {
        const b = c.kind === 'icon' ? iconButton(c.label, c.icon!, c.action === 'stop' ? 'stop' : '') : el('button', { class: c.kind || '' }, c.label);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          human(c.action, s.spaceId).catch((err) => (head.textContent = err.message));
        });
        acts.append(b);
      }
      const row = el('div', { class: `row ${st.key}${mine(s) ? ' here' : ''}`, role: 'button', tabindex: '0' },
        el('div', { class: 'id' }, who ? logo(who) : el('span', { class: 'dot' })),
        el('div', { class: 'txt' },
          el('div', { class: 'l1' }, el('span', { class: 'name' }, s.name), el('span', { class: `state ${st.key}` }, st.label)),
          el('div', { class: 'l2' }, activity(s))),
        acts);
      row.addEventListener('click', () => human('switch', s.spaceId));
      return row;
    }),
  );
  if (!snap.spaces.length) list.append(el('p', { class: 'empty' }, 'No Spaces yet. Agents create them as they start working.'));
}

const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
const port = chrome.runtime.connect({ name: 'overtake-ui' });
// Never rebuild the list while a mouse button is down: replacing the row between
// mousedown and mouseup makes the browser drop the click (users had to click 2-3 times).
let held = false;
let pending: Snapshot | null = null;
addEventListener('pointerdown', () => (held = true), true);
addEventListener('pointerup', () => {
  held = false;
  // Let the click dispatch first, then apply the latest update.
  setTimeout(() => {
    if (!held && pending) {
      const p = pending;
      pending = null;
      render(p, active?.id);
    }
  }, 0);
}, true);
port.onMessage.addListener((msg) => {
  if (msg.type !== 'overtake:spaces') return;
  if (held) pending = msg;
  else render(msg, active?.id);
});
const ov = document.getElementById('overview')!;
ov.innerHTML = ICON.plus.replace('M8 3v10M3 8h10', 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z');
ov.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('overview.html') }));
