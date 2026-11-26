// Accessibility snapshot: compact role/name text with @refs bound to backend DOM nodes.

export interface AXValue { type: string; value?: unknown }
export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  description?: AXValue;
  properties?: { name: string; value: AXValue }[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
}

export interface RefTarget {
  backendNodeId: number;
  sessionId?: string; // OOPIF session, when the node lives in an out-of-process frame
  frameId?: string;
  /** For OOPIF nodes: the owner <iframe> in the main document (coordinate offset). */
  ownerBackendNodeId?: number;
  role: string;
  name: string;
}

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'Iframe', 'iframe', 'textarea', 'ComboBoxGrouping', 'columnheader',
  'cell', 'gridcell', 'row', 'disclosuretriangle', 'MenuListPopup', 'PopUpButton', 'video', 'audio',
]);
const SKIP_ROLES = new Set(['InlineTextBox', 'LineBreak', 'none', 'presentation', 'ListMarker']);
const CONTAINER_ROLES = new Set(['generic', 'GenericContainer', 'div', 'Section', 'group', 'paragraph', 'Pre', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell']);

export interface FrameTree {
  /** AX nodes of one document */
  nodes: AXNode[];
  sessionId?: string;
  frameId?: string;
  ownerBackendNodeId?: number;
}

/** Key of a child frame document in SnapshotInput.children: its owner <iframe>'s backend node
 *  id, with the session of the document that holds the owner (ids repeat across processes). */
export function frameKey(sessionId: string | undefined, backendNodeId: number) {
  return `${sessionId ?? ''}#${backendNodeId}`;
}

export interface SnapshotInput {
  main: FrameTree;
  /** child frame documents (frameKey of their owner <iframe>), nested frames included */
  children: Map<string, FrameTree>;
  /** backendNodeIds visible in the viewport (main document); undefined = no filtering */
  visible?: Set<number>;
  /** The ref number for a node, by a key stable across snapshots (session and backend node id),
   *  so an element keeps its ref while the page stays. */
  nextRef: (key: string) => number;
  /** The page's URL: links to it are printed short (path, or just the #fragment). */
  pageUrl?: string;
  /** Only this node's subtree (with any frames in it). */
  root?: { backendNodeId: number; sessionId?: string };
  maxLines?: number;
  /** backendNodeIds whose subtrees are hidden from the agent (the Overtake overlay). */
  exclude?: Set<number>;
  /** backendNodeIds of draggable="true" elements: given refs and marked [draggable]. */
  draggable?: Set<number>;
}

export interface SnapshotOutput {
  text: string;
  /** False when `root` was given but is not in the tree. */
  rootFound: boolean;
  refs: Map<number, RefTarget>;
  truncated: boolean;
  omittedBelow: boolean;
}

/** A link target as printed: relative to the page when it can be (same origin: path; same page:
 *  the #fragment), nothing for a bare "#" link to the page itself. */
export function shortHref(href: string, pageUrl?: string): string {
  if (!pageUrl) return href.slice(0, 120);
  try {
    const u = new URL(href), p = new URL(pageUrl);
    if (u.origin !== p.origin) return href.slice(0, 120);
    if (u.pathname === p.pathname && u.search === p.search) return u.hash.length > 1 ? u.hash.slice(0, 120) : '';
    return (u.pathname + u.search + u.hash).slice(0, 120);
  } catch {
    return href.slice(0, 120);
  }
}

function str(v?: AXValue): string {
  if (!v || v.value === undefined || v.value === null) return '';
  return String(v.value).replace(/\s+/g, ' ').trim();
}

/** The visible text under a node, from its StaticText descendants. */
function textOf(n: AXNode, byId: Map<string, AXNode>, depth = 0): string {
  if (depth > 20) return '';
  if (str(n.role) === 'StaticText') return str(n.name);
  return (n.childIds || []).map((id) => byId.get(id)).filter(Boolean).map((k) => textOf(k as AXNode, byId, depth + 1)).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/** Whether a node has descendants that get their own line with a ref (interactive or draggable). */
function hasInteractive(n: AXNode, byId: Map<string, AXNode>, draggable: Set<number> | undefined, depth = 0): boolean {
  if (depth > 20) return false;
  return (n.childIds || []).some((id) => {
    const k = byId.get(id);
    if (!k) return false;
    if (k.backendDOMNodeId !== undefined && draggable?.has(k.backendDOMNodeId)) return true;
    return (!k.ignored && INTERACTIVE.has(str(k.role))) || hasInteractive(k, byId, draggable, depth + 1);
  });
}

export function buildSnapshot(input: SnapshotInput): SnapshotOutput {
  const refs = new Map<number, RefTarget>();
  const lines: string[] = [];
  const maxLines = input.maxLines ?? 1500;
  let truncated = false;
  let omittedBelow = false;

  const walkTree = (tree: FrameTree, depth: number, filter: Set<number> | undefined, start?: AXNode) => {
    const byId = new Map(tree.nodes.map((n) => [n.nodeId, n]));
    const root = start || tree.nodes.find((n) => !n.parentId) || tree.nodes[0];
    if (!root) return;

    // Visible if this node or any descendant has a visible backend node.
    const visCache = new Map<string, boolean>();
    const visible = (n: AXNode): boolean => {
      if (!filter) return true;
      const c = visCache.get(n.nodeId);
      if (c !== undefined) return c;
      visCache.set(n.nodeId, false);
      let v = n.backendDOMNodeId !== undefined && filter.has(n.backendDOMNodeId);
      if (!v) for (const id of n.childIds || []) {
        const ch = byId.get(id);
        if (ch && visible(ch)) {
          v = true;
          break;
        }
      }
      visCache.set(n.nodeId, v);
      return v;
    };

    const visit = (n: AXNode, d: number) => {
      if (lines.length >= maxLines) {
        truncated = true;
        return;
      }
      if (n.backendDOMNodeId !== undefined && input.exclude?.has(n.backendDOMNodeId)) return;
      const role = str(n.role);
      const kids = (n.childIds || []).map((id) => byId.get(id)).filter(Boolean) as AXNode[];
      if (filter && !visible(n)) {
        omittedBelow = true;
        return;
      }
      const drag = tree === input.main || !tree.sessionId ? n.backendDOMNodeId !== undefined && !!input.draggable?.has(n.backendDOMNodeId) : false;
      if (!drag && (n.ignored || SKIP_ROLES.has(role))) {
        for (const k of kids) visit(k, d);
        return;
      }
      // A draggable element often has no accessible name of its own: use its text.
      const name = str(n.name) || (drag ? textOf(n, byId).slice(0, 160) : '');
      if (role === 'StaticText') {
        if (name) lines.push(`${'  '.repeat(d)}- text "${name.slice(0, 200)}"`);
        return;
      }
      if (role === 'RootWebArea' || role === 'WebArea') {
        for (const k of kids) visit(k, d);
        return;
      }
      // Collapse anonymous containers.
      if (!drag && CONTAINER_ROLES.has(role) && !name) {
        for (const k of kids) visit(k, d);
        return;
      }
      // Leaf text nodes whose only child is a StaticText with the same name: print once.
      const onlyText = kids.length > 0 && kids.every((k) => str(k.role) === 'StaticText' || k.ignored || str(k.role) === 'InlineTextBox');
      const props: string[] = [];
      for (const p of n.properties || []) {
        const val = p.value?.value;
        if (p.name === 'level') props.push(`level=${val}`);
        else if (['checked', 'pressed', 'expanded', 'selected'].includes(p.name) && val !== undefined && val !== 'false' && val !== false) props.push(`${p.name}${val === true || val === 'true' ? '' : '=' + val}`);
        else if (p.name === 'disabled' && val) props.push('disabled');
        else if (p.name === 'focused' && val) props.push('focused');
        else if (p.name === 'url' && role === 'link' && typeof val === 'string') {
          const h = shortHref(val, input.pageUrl);
          if (h) props.push(`href=${h}`);
        }
      }
      const value = str(n.value);
      let ref = '';
      if (drag) props.push('draggable');
      if (n.backendDOMNodeId !== undefined && (drag || INTERACTIVE.has(role) || (name && ['heading', 'img', 'image'].includes(role)))) {
        const id = input.nextRef(`${tree.sessionId ?? ''}:${n.backendDOMNodeId}`);
        refs.set(id, { backendNodeId: n.backendDOMNodeId, sessionId: tree.sessionId, frameId: tree.frameId, ownerBackendNodeId: tree.ownerBackendNodeId, role, name });
        ref = ` @${id}`;
      }
      const label = role === 'Iframe' ? 'iframe' : !role || n.ignored ? 'generic' : role;
      lines.push(`${'  '.repeat(d)}- ${label}${name ? ` "${name.slice(0, 160)}"` : ''}${ref}${value && value !== name ? ` value="${value.slice(0, 120)}"` : ''}${props.length ? ` [${props.join(', ')}]` : ''}`);
      const sub = n.backendDOMNodeId !== undefined ? input.children.get(frameKey(tree.sessionId, n.backendDOMNodeId)) : undefined;
      if (sub) walkTree(sub, d + 1, undefined);
      // A draggable named from its own text: its text-only subtree would repeat that name.
      if ((onlyText || (drag && !str(n.name))) && name && !hasInteractive(n, byId, input.draggable)) return;
      for (const k of kids) visit(k, d + 1);
    };
    visit(root, depth);
  };

  let rootFound = true;
  if (input.root) {
    // The tree holding the node: same session (or the page's), and that backend node id.
    const r = input.root;
    const trees = [input.main, ...input.children.values()].filter((t) => (t.sessionId ?? undefined) === (r.sessionId ?? undefined));
    let hit: { tree: FrameTree; node: AXNode } | undefined;
    for (const t of trees) {
      const node = t.nodes.find((n) => n.backendDOMNodeId === r.backendNodeId);
      if (node) { hit = { tree: t, node }; break; }
    }
    if (hit) walkTree(hit.tree, 0, undefined, hit.node);
    else rootFound = false;
  } else walkTree(input.main, 0, input.visible);
  if (truncated) lines.push(`[snapshot truncated at ${maxLines} lines; use scope "full_page" with a root ref, or browser_evaluate]`);
  if (omittedBelow && input.visible) lines.push('[more content outside the viewport: scroll, or use scope "full_page"]');
  return { text: lines.join('\n'), refs, truncated, omittedBelow, rootFound };
}
