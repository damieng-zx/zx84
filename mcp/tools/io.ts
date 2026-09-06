import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hex8 as h8, hex16 as h16 } from '../../src/utils/hex.ts';
import { state } from '../state.ts';
import { parseAddr, text, checkWatchHit, spectrumPagingLine, KEY_NAME_MAP, CHAR_KEYS } from '../format.ts';
import type { HostKeyEvent } from '../../src/machines/machine.ts';

/** Frames to idle after Enter so the machine ROM can tokenise the line and
 *  resume keyboard scanning before the next keystroke. */
const ENTER_SETTLE_FRAMES = 30;

function hostKeyEvent(code: string): HostKeyEvent {
  const key = code.startsWith('Key') ? code.slice(3).toLowerCase()
    : code.startsWith('Digit') ? code.slice(5)
      : code === 'Space' ? ' ' : code;
  return {
    code, key,
    shift: code === 'ShiftLeft' || code === 'ShiftRight',
    ctrl: code === 'ControlLeft' || code === 'ControlRight',
    alt: code === 'AltLeft' || code === 'AltRight',
  };
}

function setKey(code: string, pressed: boolean): boolean {
  const input = state.spec.services.input;
  const event = hostKeyEvent(code);
  return pressed ? input.keyDown(event) : input.keyUp(event);
}

/** Deliver a literal character for character-intent keyboards (e.g. MTX): the
 *  machine maps the character onto its own key layout, so no code/chord. */
function setCharKey(ch: string, pressed: boolean): boolean {
  const input = state.spec.services.input;
  const event: HostKeyEvent = { code: '', key: ch, shift: false, ctrl: false, alt: false };
  return pressed ? input.keyDown(event) : input.keyUp(event);
}

/** The active CPU's port space. Machines whose CPU memory-maps its hardware
 *  instead of using an I/O port space (any 6502 machine) have none, and the
 *  port tools say so rather than throwing. */
function cpuPorts() {
  return state.spec.services.debug.ports;
}

const NO_PORTS = 'This machine has no CPU I/O port space (its hardware is memory-mapped) — use read_memory / write_memory instead.';

export function register(server: McpServer): void {
  server.registerTool(
    'port_out',
    { description: 'Write a byte to an I/O port (triggers port handler for banking etc.).', inputSchema: {
      port: z.string().describe('Port address (hex/decimal)'),
      value: z.string().describe('Byte value'),
    } },
    async ({ port, value }) => {
      const ports = cpuPorts();
      if (!ports) return text(NO_PORTS);
      const p = parseAddr(port) & 0xFFFF;
      const v = parseAddr(value) & 0xFF;
      ports.out(p, v);
      let result = `OUT ${h16(p)}, ${h8(v)}`;
      const paging = spectrumPagingLine();
      if (paging) result += `\n${paging}`;
      return text(result);
    },
  );

  server.registerTool(
    'port_in',
    { description: 'Read a byte from an I/O port.', inputSchema: { port: z.string().describe('Port address (hex/decimal)') } },
    async ({ port }) => {
      const ports = cpuPorts();
      if (!ports) return text(NO_PORTS);
      const p = parseAddr(port) & 0xFFFF;
      const val = ports.in(p);
      return text(`IN ${h16(p)} = ${h8(val)} (${val})`);
    },
  );

  server.registerTool(
    'key',
    { description: 'Press a key through the active machine input service for N frames (default 5). Common keys: a-z, 0-9, enter, space, shift, backspace, arrows, period, escape. Spectrum also supports sym, capslock, and "+"-joined combos.', inputSchema: {
      name: z.string().describe('Key name, or "+"-joined combo (e.g. "enter", "a", "shift+sym")'),
      frames: z.number().int().positive().default(5).describe('How many frames to hold the key'),
    } },
    async ({ name, frames }) => {
      const spec = state.spec;
      // Support combos like "sym+p", "shift+2"
      const parts = name.toLowerCase().split('+');
      const codes: string[] = [];
      for (const p of parts) {
        const code = KEY_NAME_MAP[p.trim()];
        if (!code) return text(`Unknown key: ${p.trim()}. Available: ${Object.keys(KEY_NAME_MAP).join(', ')}`);
        codes.push(code);
      }
      let consumed = false;
      for (const c of codes) consumed = setKey(c, true) || consumed;
      if (!consumed) return text(`Key '${name}' is not present on ${state.model.toUpperCase()}`);
      for (let i = 0; i < frames; i++) spec.tick();
      for (const c of codes) setKey(c, false);
      spec.tick();
      return text(`Key '${name}' held for ${frames} frames`);
    },
  );

  server.registerTool(
    'type',
    { description: 'Type text through the active machine keyboard. Letters, digits, spaces, and backtick-delimited control names work on ZX80/ZX81; printable-symbol chords use Spectrum mappings.', inputSchema: { text: z.string().describe('Text to type, e.g. "LOAD \\"\\"`enter`" or "10 PRINT `shift`2`enter`"') } },
    async ({ text: str }) => {
      const spec = state.spec;
      // Character-intent keyboards map a typed character onto their own key
      // layout, so we send the literal character rather than resolving a
      // Spectrum symbol-shift chord that would land on the wrong key. The MTX
      // has always worked this way; the SAM joined it once its keyboard began
      // routing punctuation by character (its `"` is a key of its own, and its
      // brackets are SYMBOL chords the Spectrum table knows nothing about).
      const charIntent = spec.kind === 'mtx' || spec.kind === 'sam';

      // Parse the string into actions: either code-based key names, or (for
      // character-intent machines) a literal character.
      type Action = { keys: string[] } | { char: string };
      const actions: Action[] = [];
      let i = 0;
      while (i < str.length) {
        if (str[i] === '`') {
          const end = str.indexOf('`', i + 1);
          if (end === -1) { i++; continue; } // unmatched backtick — skip
          const name = str.slice(i + 1, end).toLowerCase();
          if (KEY_NAME_MAP[name]) {
            actions.push({ keys: [name] });
          } // else skip unknown name silently
          i = end + 1;
        } else {
          const ch = str[i];
          const lower = ch.toLowerCase();
          if (charIntent) {
            if (ch === '\n') actions.push({ keys: ['enter'] });
            else actions.push({ char: ch });
          } else if (spec.kind === 'zx8x' && ch === '.') {
            actions.push({ keys: ['period'] });
          } else if (CHAR_KEYS[ch]) {
            actions.push({ keys: CHAR_KEYS[ch] });
          } else if (KEY_NAME_MAP[lower]) {
            actions.push({ keys: ch >= 'A' && ch <= 'Z' && spec.kind !== 'zx8x' ? ['shift', lower] : [lower] });
          } else if (ch === ' ') {
            actions.push({ keys: ['space'] });
          }
          // else skip unknown chars
          i++;
        }
      }
      const press = (action: Action, down: boolean): void => {
        if ('char' in action) setCharKey(action.char, down);
        else for (const k of action.keys) setKey(KEY_NAME_MAP[k], down);
      };
      let hit: string | null = null;
      typeLoop: for (const action of actions) {
        press(action, true);
        for (let f = 0; f < 5; f++) {
          spec.tick();
          hit = checkWatchHit(spec);
          if (hit) { press(action, false); break typeLoop; }
        }
        press(action, false);
        spec.tick();
        hit = checkWatchHit(spec);
        if (hit) break;
        // small gap between keypresses
        for (let f = 0; f < 3; f++) {
          spec.tick();
          hit = checkWatchHit(spec);
          if (hit) break typeLoop;
        }
        // After Enter the ROM tokenises/stores the line and stops scanning the
        // keyboard; without a settle the next line's first key is dropped
        // (observed on the MTX, where ~20 frames suffice — 30 for margin).
        if ('keys' in action && action.keys.includes('enter')) {
          for (let f = 0; f < ENTER_SETTLE_FRAMES; f++) {
            spec.tick();
            hit = checkWatchHit(spec);
            if (hit) break typeLoop;
          }
        }
      }
      if (hit) return text(`Typed ${actions.length} keystrokes, then hit:\n${hit}`);
      return text(`Typed ${actions.length} keystrokes`);
    },
  );
}
