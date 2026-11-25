import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCdpMethod } from '../../extension/src/background/cdp-policy.ts';
import { chordSteps, typeSteps } from '../../mcp/keys.ts';
import { buildSnapshot, type AXNode } from '../../mcp/snapshot.ts';

test('cdp policy: valid methods pass, input methods are flagged for the gate', () => {
  assert.deepEqual(checkCdpMethod('Runtime.evaluate', { expression: '1' }), { input: false });
  assert.deepEqual(checkCdpMethod('Input.dispatchMouseEvent', {}), { input: true });
});

test('cdp policy: denies profile-wide and gate-owned methods', () => {
  for (const m of ['Network.getAllCookies', 'Storage.getCookies', 'Network.clearBrowserCookies', 'Input.setIgnoreInputEvents', 'Target.createTarget', 'Browser.close']) {
    assert.throws(() => checkCdpMethod(m, {}), (e: Error & { code: string }) => e.code === 'CDP_METHOD_DENIED', m);
  }
});

test('cdp policy: rejects malformed input', () => {
  for (const [m, p] of [['eval', {}], ['Runtime.evaluate; drop', {}], ['Runtime.evaluate', []], ['Runtime.evaluate', { sessionId: 'x' }]] as const) {
    assert.throws(() => checkCdpMethod(m, p), (e: Error & { code: string }) => e.code === 'BAD_REQUEST', String(m));
  }
});

test('keys: Enter produces keyDown with text and keyUp', () => {
  const s = chordSteps('Enter', 'darwin');
  assert.equal(s.length, 2);
  assert.equal(s[0].params.type, 'keyDown');
  assert.equal(s[0].params.text, '\r');
  assert.equal(s[1].params.type, 'keyUp');
});

test('keys: ControlOrMeta+a maps to Meta with selectAll on macOS', () => {
  const s = chordSteps('ControlOrMeta+a', 'darwin');
  assert.equal(s[0].params.key, 'Meta');
  const main = s[1].params;
  assert.equal(main.modifiers, 4);
  assert.deepEqual(main.commands, ['selectAll']);
  assert.equal(main.text, undefined, 'no text for shortcuts');
  const linux = chordSteps('ControlOrMeta+a', 'linux');
  assert.equal(linux[0].params.key, 'Control');
});

test('keys: Shift+Tab and typing', () => {
  const s = chordSteps('Shift+Tab', 'darwin');
  assert.equal(s[1].params.modifiers, 8);
  assert.equal(typeSteps('ab').length, 4);
  assert.throws(() => chordSteps('Hyper+x'));
});

test('snapshot: refs for interactive nodes, containers collapsed, viewport filter', () => {
  const nodes: AXNode[] = [
    { nodeId: '1', ignored: false, role: { type: 'role', value: 'RootWebArea' }, name: { type: 's', value: 'Page' }, childIds: ['2', '5'], backendDOMNodeId: 1 },
    { nodeId: '2', ignored: false, role: { type: 'role', value: 'generic' }, childIds: ['3', '4'], parentId: '1', backendDOMNodeId: 2 },
    { nodeId: '3', ignored: false, role: { type: 'role', value: 'heading' }, name: { type: 's', value: 'Title' }, properties: [{ name: 'level', value: { type: 'i', value: 1 } }], parentId: '2', backendDOMNodeId: 3 },
    { nodeId: '4', ignored: false, role: { type: 'role', value: 'button' }, name: { type: 's', value: 'Go' }, parentId: '2', backendDOMNodeId: 4 },
    { nodeId: '5', ignored: false, role: { type: 'role', value: 'link' }, name: { type: 's', value: 'Far away' }, parentId: '1', backendDOMNodeId: 5 },
  ];
  let n = 0;
  const all = buildSnapshot({ main: { nodes }, children: new Map(), nextRef: () => ++n });
  assert.match(all.text, /- heading "Title" @1 \[level=1\]/);
  assert.match(all.text, /- button "Go" @2/);
  assert.match(all.text, /- link "Far away" @3/);
  assert.doesNotMatch(all.text, /generic/);
  assert.equal(all.refs.get(2)?.backendNodeId, 4);

  n = 0;
  const vp = buildSnapshot({ main: { nodes }, children: new Map(), visible: new Set([3, 4]), nextRef: () => ++n });
  assert.doesNotMatch(vp.text, /Far away/);
  assert.match(vp.text, /more content outside the viewport/);
});

test('snapshot: iframe subtree is inlined with its session for refs', () => {
  const main: AXNode[] = [
    { nodeId: '1', ignored: false, role: { type: 'role', value: 'RootWebArea' }, childIds: ['2'] },
    { nodeId: '2', ignored: false, role: { type: 'role', value: 'Iframe' }, name: { type: 's', value: 'child' }, parentId: '1', backendDOMNodeId: 10 },
  ];
  const child: AXNode[] = [
    { nodeId: 'a', ignored: false, role: { type: 'role', value: 'RootWebArea' }, childIds: ['b'] },
    { nodeId: 'b', ignored: false, role: { type: 'role', value: 'button' }, name: { type: 's', value: 'Inner' }, parentId: 'a', backendDOMNodeId: 7 },
  ];
  let n = 0;
  const out = buildSnapshot({ main: { nodes: main }, children: new Map([[10, { nodes: child, sessionId: 'S1', ownerBackendNodeId: 10 }]]), nextRef: () => ++n });
  assert.match(out.text, /- iframe "child" @1\n  - button "Inner" @2/);
  assert.equal(out.refs.get(2)?.sessionId, 'S1');
  assert.equal(out.refs.get(2)?.ownerBackendNodeId, 10);
});

test('snapshot: the Overtake overlay subtree is excluded', () => {
  const nodes: AXNode[] = [
    { nodeId: '1', ignored: false, role: { type: 'role', value: 'RootWebArea' }, childIds: ['2', '3'] },
    { nodeId: '2', ignored: false, role: { type: 'role', value: 'button' }, name: { type: 's', value: 'Page button' }, parentId: '1', backendDOMNodeId: 2 },
    { nodeId: '3', ignored: false, role: { type: 'role', value: 'toolbar' }, name: { type: 's', value: 'Agent control' }, parentId: '1', backendDOMNodeId: 99, childIds: ['4'] },
    { nodeId: '4', ignored: false, role: { type: 'role', value: 'button' }, name: { type: 's', value: 'Take over' }, parentId: '3', backendDOMNodeId: 100 },
  ];
  let n = 0;
  const out = buildSnapshot({ main: { nodes }, children: new Map(), exclude: new Set([99]), nextRef: () => ++n });
  assert.match(out.text, /Page button/);
  assert.doesNotMatch(out.text, /Take over|Agent control/);
});

test('snapshot: draggable elements get refs and a name from their text', () => {
  const nodes: AXNode[] = [
    { nodeId: '1', ignored: false, role: { type: 'role', value: 'RootWebArea' }, childIds: ['2', '4'], backendDOMNodeId: 1 },
    { nodeId: '2', ignored: false, role: { type: 'role', value: 'generic' }, childIds: ['3'], parentId: '1', backendDOMNodeId: 2 },
    { nodeId: '3', ignored: false, role: { type: 'role', value: 'StaticText' }, name: { type: 's', value: 'Write docs' }, parentId: '2' },
    { nodeId: '4', ignored: false, role: { type: 'role', value: 'generic' }, childIds: ['5'], parentId: '1', backendDOMNodeId: 4 },
    { nodeId: '5', ignored: false, role: { type: 'role', value: 'StaticText' }, name: { type: 's', value: 'Not draggable' }, parentId: '4' },
  ];
  let n = 0;
  const s = buildSnapshot({ main: { nodes }, children: new Map(), draggable: new Set([2]), nextRef: () => ++n });
  assert.match(s.text, /- generic "Write docs" @1 \[draggable\]/);
  assert.doesNotMatch(s.text, /text "Write docs"/, 'its text is not repeated');
  assert.match(s.text, /- text "Not draggable"/);
  assert.equal(s.refs.get(1)?.backendNodeId, 2);
  assert.equal(s.refs.size, 1);
});

test('snapshot: a draggable inside a draggable keeps its own ref', () => {
  const nodes: AXNode[] = [
    { nodeId: '1', ignored: false, role: { type: 'role', value: 'RootWebArea' }, childIds: ['2'], backendDOMNodeId: 1 },
    { nodeId: '2', ignored: false, role: { type: 'role', value: 'generic' }, childIds: ['3'], parentId: '1', backendDOMNodeId: 2 },
    { nodeId: '3', ignored: false, role: { type: 'role', value: 'generic' }, childIds: ['4'], parentId: '2', backendDOMNodeId: 3 },
    { nodeId: '4', ignored: false, role: { type: 'role', value: 'StaticText' }, name: { type: 's', value: 'Card' }, parentId: '3' },
  ];
  let n = 0;
  const s = buildSnapshot({ main: { nodes }, children: new Map(), draggable: new Set([2, 3]), nextRef: () => ++n });
  assert.equal(s.refs.size, 2);
  assert.match(s.text, /- generic "Card" @2 \[draggable\]/);
});

test('snapshot: a draggable under an ignored child of a draggable keeps its ref', () => {
  const nodes: AXNode[] = [
    { nodeId: '1', ignored: false, role: { type: 'role', value: 'RootWebArea' }, childIds: ['2'], backendDOMNodeId: 1 },
    { nodeId: '2', ignored: false, role: { type: 'role', value: 'generic' }, childIds: ['3'], parentId: '1', backendDOMNodeId: 2 },
    { nodeId: '3', ignored: true, role: { type: 'role', value: 'none' }, childIds: ['4'], parentId: '2', backendDOMNodeId: 3 },
    { nodeId: '4', ignored: false, role: { type: 'role', value: 'StaticText' }, name: { type: 's', value: 'Card' }, parentId: '3' },
  ];
  let n = 0;
  const s = buildSnapshot({ main: { nodes }, children: new Map(), draggable: new Set([2, 3]), nextRef: () => ++n });
  assert.equal(s.refs.size, 2, s.text);
});
