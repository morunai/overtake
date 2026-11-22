// Playwright-style key names -> CDP Input.dispatchKeyEvent parameters.

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
};
for (let i = 1; i <= 12; i++) NAMED['F' + i] = { key: 'F' + i, code: 'F' + i, keyCode: 111 + i };

const MOD_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export function keyDef(name: string): KeyDef {
  if (NAMED[name]) return NAMED[name];
  if (name.length === 1) {
    const ch = name;
    const upper = ch.toUpperCase();
    if (/[a-z]/i.test(ch)) return { key: ch, code: 'Key' + upper, keyCode: upper.charCodeAt(0), text: ch };
    if (/[0-9]/.test(ch)) return { key: ch, code: 'Digit' + ch, keyCode: ch.charCodeAt(0), text: ch };
    return { key: ch, code: '', keyCode: 0, text: ch };
  }
  throw new Error(`Unknown key "${name}"`);
}

/** Editing commands macOS needs for shortcuts (CDP does not run them from modifiers alone). */
const MAC_COMMANDS: Record<string, string> = { 'Meta+a': 'selectAll', 'Meta+c': 'copy', 'Meta+x': 'cut', 'Meta+v': 'paste', 'Meta+z': 'undo', 'Meta+Shift+z': 'redo' };

export interface KeyStep {
  method: 'Input.dispatchKeyEvent';
  params: Record<string, unknown>;
}

/** "Control+Shift+a", "ControlOrMeta+a", "Enter" -> keyDown/keyUp steps. */
export function chordSteps(chord: string, platform = process.platform): KeyStep[] {
  const parts = chord.split('+').map((p) => (p === '' ? '+' : p));
  const keyName = parts.pop()!;
  const mods = parts.map((m) => (m === 'ControlOrMeta' ? (platform === 'darwin' ? 'Meta' : 'Control') : m));
  let modifiers = 0;
  const steps: KeyStep[] = [];
  for (const m of mods) {
    if (!(m in MOD_BITS)) throw new Error(`Unknown modifier "${m}"`);
    modifiers |= MOD_BITS[m];
    const d = NAMED[m];
    steps.push({ method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, modifiers } });
  }
  const k = keyDef(keyName);
  const withText = k.text !== undefined && (modifiers & ~MOD_BITS.Shift) === 0;
  const text = withText ? (modifiers & MOD_BITS.Shift && k.text!.length === 1 ? k.text!.toUpperCase() : k.text) : undefined;
  const commandKey = [...mods, keyName.length === 1 ? keyName.toLowerCase() : keyName].join('+');
  const commands = platform === 'darwin' && MAC_COMMANDS[commandKey] ? [MAC_COMMANDS[commandKey]] : undefined;
  steps.push({
    method: 'Input.dispatchKeyEvent',
    params: { type: text ? 'keyDown' : 'rawKeyDown', key: modifiers & MOD_BITS.Shift && k.key.length === 1 ? k.key.toUpperCase() : k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers, ...(text ? { text, unmodifiedText: text } : {}), ...(commands ? { commands } : {}) },
  });
  steps.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers } });
  for (const m of mods.reverse()) {
    modifiers &= ~MOD_BITS[m];
    const d = NAMED[m];
    steps.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, modifiers } });
  }
  return steps;
}

/** Type text one character at a time as real key events. */
export function typeSteps(text: string): KeyStep[] {
  const steps: KeyStep[] = [];
  for (const ch of text) {
    if (ch === '\n') {
      steps.push(...chordSteps('Enter'));
      continue;
    }
    let def: KeyDef;
    try {
      def = keyDef(ch);
    } catch {
      def = { key: ch, code: '', keyCode: 0, text: ch };
    }
    steps.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: ch, code: def.code, windowsVirtualKeyCode: def.keyCode, text: ch, unmodifiedText: ch } });
    steps.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: ch, code: def.code, windowsVirtualKeyCode: def.keyCode } });
  }
  return steps;
}
