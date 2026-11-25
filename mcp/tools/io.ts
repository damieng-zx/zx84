import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hex8 as h8, hex16 as h16 } from '../../src/utils/hex.ts';
import { state } from '../state.ts';
import { parseAddr, text, checkWatchHit, spectrumPagingLine, KEY_NAME_MAP, CHAR_KEYS } from '../format.ts';
import type { HostKeyEvent, MachineUiCapabilities } from '../../src/machines/machine.ts';

/** Frames to idle after Enter so the machine ROM can tokenise the line and
 *  resume keyboard scanning before the next keystroke. */
const ENTER_SETTLE_FRAMES = 30;

/** Modifier keys currently held down. Each key event carries the modifiers'
 *  state as well as being the press/release of the modifier itself: the Apple
 *  II keyboard encoder (and the CPC, the Acorns and others) resolves SHIFT and
 *  CTRL from the event that carries the character, so pressing a separate
 *  Shift key event first is not enough. */
const held = { shift: false, ctrl: false, alt: false };

function modifierFlags(code: string): { shift: boolean; ctrl: boolean; alt: boolean } {
  return {
    shift: held.shift || code === 'ShiftLeft' || code === 'ShiftRight',
    ctrl: held.ctrl || code === 'ControlLeft' || code === 'ControlRight',
    alt: held.alt || code === 'AltLeft' || code === 'AltRight',
  };
}

function hostKeyEvent(code: string): HostKeyEvent {
  const key = code.startsWith('Key') ? code.slice(3).toLowerCase()
    : code.startsWith('Digit') ? code.slice(5)
      : code === 'Space' ? ' '
        : code === 'ShiftLeft' || code === 'ShiftRight' ? 'Shift'
          : code === 'ControlLeft' || code === 'ControlRight' ? 'Control'
            : code === 'AltLeft' || code === 'AltRight' ? 'Alt'
              : code;
  return {
    code, key,
    ...modifierFlags(code),
  };
}

function setKey(code: string, pressed: boolean): boolean {
  const input = state.spec.services.input;
  const event = hostKeyEvent(code);
  const consumed = pressed ? input.keyDown(event) : input.keyUp(event);
  if (code === 'ShiftLeft' || code === 'ShiftRight') held.shift = pressed;
  else if (code === 'ControlLeft' || code === 'ControlRight') held.ctrl = pressed;
  else if (code === 'AltLeft' || code === 'AltRight') held.alt = pressed;
  return consumed;
}

/** A joystick direction as the `key` tool names it: `joy-up`, `joy-down`,
 *  `joy-left`, `joy-right` and `joy-fire` (`joy-fire2` on a stick with a
 *  second button), with `-p2` for player 2 — `joy-fire-p2`. */
const JOYSTICK_KEY = /^joy-(up|down|left|right|fire2?)(?:-p([12]))?$/;

/** The interface a player's stick is plugged into. The machine's own list
 *  gives each player the interface at their position (player 1 the first,
 *  player 2 the second), as the Joystick pane does; a machine whose list is
 *  not its own (or whose joystick is one fixed interface, which ignores the
 *  mode) gets the Spectrum's Kempston, the selector's first choice. */
export function joystickMode(caps: MachineUiCapabilities, player: number): string {
  return (caps.joystickTypes?.[player] ?? caps.joystickTypes?.[0])?.id ?? 'kempston';
}

/** One part of a `key` name: a host key code, or a joystick direction. */
type KeyPart = { code: string } | { joy: RegExpExecArray };

/** The parts of a "+"-joined key name, or null with the offending part. */
function parseKeyName(name: string): { parts: KeyPart[] } | { unknown: string } {
  const parts: KeyPart[] = [];
  for (const raw of name.toLowerCase().split('+')) {
    const part = raw.trim();
    const joy = JOYSTICK_KEY.exec(part);
    if (joy) parts.push({ joy });
    else if (KEY_NAME_MAP[part]) parts.push({ code: KEY_NAME_MAP[part] });
    else return { unknown: part };
  }
  return { parts };
}

/** Press (or release) a joystick direction on the active machine. False when
 *  it has no joystick to take it. */
function setJoy(joy: RegExpExecArray, pressed: boolean): boolean {
  const spec = state.spec;
  const input = spec.services.input;
  if (!spec.descriptor.ui.joystick || !input.joystick) return false;
  const player = Number(joy[2] ?? 1) - 1;
  input.joystick.press(joy[1], pressed, joystickMode(spec.descriptor.ui, player), player);
  return true;
}

function press(part: KeyPart, down: boolean): boolean {
  return 'code' in part ? setKey(part.code, down) : setJoy(part.joy, down);
}

/** Hold a key or joystick combination for `frames` frames: the `key` tool. */
export function holdKey(name: string, frames: number): string {
  const spec = state.spec;
  const parsed = parseKeyName(name);
  if ('unknown' in parsed) return `Unknown key: ${parsed.unknown}. Available: ${Object.keys(KEY_NAME_MAP).join(', ')}, joy-up/down/left/right/fire[-p2]`;
  // Every part is validated before any is pressed, so a bad name leaves nothing held.
  let consumed = false;
  for (const part of parsed.parts) consumed = press(part, true) || consumed;
  if (!consumed) {
    for (const part of parsed.parts) press(part, false);
    return `Key '${name}' is not present on ${state.model.toUpperCase()}`;
  }
  for (let i = 0; i < frames; i++) spec.tick();
  for (const part of parsed.parts) press(part, false);
  spec.tick();
  return `Key '${name}' held for ${frames} frames`;
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
    { description: 'Press a key through the active machine input service for N frames (default 5). Common keys: a-z, 0-9, enter, space, shift, ctrl (also sym), alt, backspace, arrows, period, escape. A "+"-joined combo such as "shift+2" carries its modifiers in the key event, so keyboards that resolve SHIFT/CTRL per event (the Apple II, the CPC) see the chord. A joystick is pressed as joy-up, joy-down, joy-left, joy-right, joy-fire (joy-fire2 where the stick has a second button), with -p2 for player 2: "joy-fire+joy-right".', inputSchema: {
      name: z.string().describe('Key name, or "+"-joined combo (e.g. "enter", "a", "shift+sym", "joy-fire", "joy-up-p2")'),
      frames: z.number().int().positive().default(5).describe('How many frames to hold the key'),
    } },
    async ({ name, frames }) => text(holdKey(name, frames)),
  );

  server.registerTool(
    'type',
    {
      description: 'Type text through the active machine keyboard. Letters, '
        + 'digits and spaces work everywhere; backtick-delimited control names press '
        + 'named keys. Printable symbols type each machine\'s own legend (a CPC `+` is '
        + 'Shift+`;`, an Atom `"` is its Shift+2 cell), because a machine offering '
        + '`InputService.charDown` maps the character itself; otherwise they resolve '
        + 'through the Spectrum symbol-shift chords.',
      inputSchema: {
        text: z.string().describe('Text to type, e.g. "LOAD \\"\\"`enter`" or "10 PRINT `shift`2`enter`"'),
      },
    },
    async ({ text: str }) => {
      const spec = state.spec;
      const input = spec.services.input;
      // Machines that map a produced character onto their own layout type it by
      // character (`charDown`); the remainder resolve PC symbols through the
      // Spectrum's symbol-shift chords, which is all a Spectrum needs.
      const charIntent = input.charDown !== undefined;

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
        if ('char' in action) {
          if (down) input.charDown!(action.char); else input.charUp!(action.char);
        } else for (const k of action.keys) setKey(KEY_NAME_MAP[k], down);
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
