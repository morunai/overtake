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

export interface SnapshotInput {
  main: FrameTree;
  /** child frame documents keyed by the backendDOMNodeId of their owner <iframe> in the parent */
  children: Map<number, FrameTree>;
  /** backendNodeIds visible in the viewport (main document); undefined = no filtering */
  visible?: Set<number>;
  nextRef: () => number;
  maxLines?: number;
  /** backendNodeIds whose subtrees are hidden from the agent (the Overtake overlay). */
  exclude?: Set<number>;
  /** backendNodeIds of draggable="true" elements: given refs and marked [draggable]. */
  draggable?: Set<number>;
}

export interface SnapshotOutput {
  text: string;
  refs: Map<number, RefTarget>;
  truncated: boolean;
  omittedBelow: boolean;
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

function hasInteractive(n: AXNode, byId: Map<string, AXNode>, depth = 0): boolean {
  if (depth > 20) return false;
  return (n.childIds || []).some((id) => {
    const k = byId.get(id);
    return !!k && ((!k.ignored && INTERACTIVE.has(str(k.role))) || hasInteractive(k, byId, depth + 1));
  });
}

export function buildSnapshot(input: SnapshotInput): SnapshotOutput {
  const refs = new Map<number, RefTarget>();
  const lines: string[] = [];
  const maxLines = input.maxLines ?? 1500;
  let truncated = false;
  let omittedBelow = false;

  const walkTree = (tree: FrameTree, depth: number, filter: Set<number> | undefined) => {
    const byId = new Map(tree.nodes.map((n) => [n.nodeId, n]));
    const root = tree.nodes.find((n) => !n.parentId) || tree.nodes[0];
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
        else if (p.name === 'url' && role === 'link' && typeof val === 'string') props.push(`href=${val.slice(0, 120)}`);
      }
      const value = str(n.value);
      let ref = '';
      if (drag) props.push('draggable');
      if (n.backendDOMNodeId !== undefined && (drag || INTERACTIVE.has(role) || (name && ['heading', 'img', 'image'].includes(role)))) {
        const id = input.nextRef();
        refs.set(id, { backendNodeId: n.backendDOMNodeId, sessionId: tree.sessionId, frameId: tree.frameId, ownerBackendNodeId: tree.ownerBackendNodeId, role, name });
        ref = ` @${id}`;
      }
      const label = role === 'Iframe' ? 'iframe' : !role || n.ignored ? 'generic' : role;
      lines.push(`${'  '.repeat(d)}- ${label}${name ? ` "${name.slice(0, 160)}"` : ''}${ref}${value && value !== name ? ` value="${value.slice(0, 120)}"` : ''}${props.length ? ` [${props.join(', ')}]` : ''}`);
      if (n.backendDOMNodeId !== undefined && input.children.has(n.backendDOMNodeId)) {
        walkTree(input.children.get(n.backendDOMNodeId)!, d + 1, undefined);
      }
      // A draggable named from its own text: its text-only subtree would repeat that name.
      if ((onlyText || (drag && !str(n.name) && !hasInteractive(n, byId))) && name) return;
      for (const k of kids) visit(k, d + 1);
    };
    visit(root, depth);
  };

  walkTree(input.main, 0, input.visible);
  if (truncated) lines.push(`[snapshot truncated at ${maxLines} lines; use scope "full_page" with a root ref, or browser_evaluate]`);
  if (omittedBelow && input.visible) lines.push('[more content outside the viewport: scroll, or use scope "full_page"]');
  return { text: lines.join('\n'), refs, truncated, omittedBelow };
}
