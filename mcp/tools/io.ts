import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { is128kClass } from '../../src/models.ts';
import { hex8 as h8, hex16 as h16 } from '../../src/utils/hex.ts';
import { state } from '../state.ts';
import { activeSpectrum } from '../concrete.ts';
import { z80Cpu } from '../../src/debug/z80/service.ts';
import { parseAddr, text, checkWatchHit, KEY_NAME_MAP, CHAR_KEYS } from '../format.ts';
import type { HostKeyEvent } from '../../src/machines/machine.ts';

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

export function register(server: McpServer): void {
  server.registerTool(
    'port_out',
    { description: 'Write a byte to an I/O port (triggers port handler for banking etc.).', inputSchema: {
      port: z.string().describe('Port address (hex/decimal)'),
      value: z.string().describe('Byte value'),
    } },
    async ({ port, value }) => {
      const p = parseAddr(port) & 0xFFFF;
      const v = parseAddr(value) & 0xFF;
      z80Cpu(state.spec)!.portOut(p, v);
      let result = `OUT ${h16(p)}, ${h8(v)}`;
      const s = activeSpectrum();
      if (s && is128kClass(s.model)) {
        const mem = s.memory;
        result += `\nBank: ${mem.currentBank}  ROM: ${mem.currentROM}  7FFD: ${h8(mem.port7FFD)}  Locked: ${mem.pagingLocked ? 'Y' : 'N'}`;
      }
      return text(result);
    },
  );

  server.registerTool(
    'port_in',
    { description: 'Read a byte from an I/O port.', inputSchema: { port: z.string().describe('Port address (hex/decimal)') } },
    async ({ port }) => {
      const p = parseAddr(port) & 0xFFFF;
      const val = z80Cpu(state.spec)!.portIn(p);
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
      // Parse the string, extracting `name` escape sequences for control keys
      const tokens: string[][] = [];
      let i = 0;
      while (i < str.length) {
        if (str[i] === '`') {
          const end = str.indexOf('`', i + 1);
          if (end === -1) { i++; continue; } // unmatched backtick — skip
          const name = str.slice(i + 1, end).toLowerCase();
          if (KEY_NAME_MAP[name]) {
            tokens.push([name]);
          } // else skip unknown name silently
          i = end + 1;
        } else {
          const ch = str[i];
          const lower = ch.toLowerCase();
          if (spec.kind === 'zx8x' && ch === '.') {
            tokens.push(['period']);
          } else if (CHAR_KEYS[ch]) {
            tokens.push(CHAR_KEYS[ch]);
          } else if (KEY_NAME_MAP[lower]) {
            tokens.push(ch >= 'A' && ch <= 'Z' && spec.kind !== 'zx8x' ? ['shift', lower] : [lower]);
          } else if (ch === ' ') {
            tokens.push(['space']);
          }
          // else skip unknown chars
          i++;
        }
      }
      let hit: string | null = null;
      typeLoop: for (const keys of tokens) {
        const codes = keys.map(k => KEY_NAME_MAP[k]);
        for (const c of codes) setKey(c, true);
        for (let f = 0; f < 5; f++) {
          spec.tick();
          hit = checkWatchHit(spec);
          if (hit) { for (const c of codes) setKey(c, false); break typeLoop; }
        }
        for (const c of codes) setKey(c, false);
        spec.tick();
        hit = checkWatchHit(spec);
        if (hit) break;
        // small gap between keypresses
        for (let f = 0; f < 3; f++) {
          spec.tick();
          hit = checkWatchHit(spec);
          if (hit) break typeLoop;
        }
      }
      if (hit) return text(`Typed ${tokens.length} keystrokes, then hit:\n${hit}`);
      return text(`Typed ${tokens.length} keystrokes`);
    },
  );
}
