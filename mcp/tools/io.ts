import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { is128kClass } from '../../src/models.ts';
import { hex8 as h8, hex16 as h16 } from '../../src/utils/hex.ts';
import { state } from '../state.ts';
import { activeSpectrum, activeCpc } from '../concrete.ts';
import { z80Cpu } from '../../src/debug/z80/service.ts';
import { parseAddr, text, checkWatchHit, KEY_NAME_MAP, CHAR_KEYS } from '../format.ts';

/** The active machine's keyboard (both expose handleKeyEvent(code, pressed)). */
function activeKeyboard(): { handleKeyEvent(code: string, pressed: boolean): boolean } {
  const s = activeSpectrum();
  return s ? s.keyboard : activeCpc()!.keyboard;
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
    { description: 'Press a key for N frames (default 5). Keys: a-z, 0-9, enter, space, shift (CAPS SHIFT), sym (SYMBOL SHIFT), backspace, arrows, capslock, escape. Combine keys with "+" to hold them together, e.g. "shift+2" or "sym+p". Pure-modifier combos work too: "shift+sym" enters extended mode (E cursor) — follow it with a letter for the extended keyword (e.g. "shift+sym" then "m" gives PI).', inputSchema: {
      name: z.string().describe('Key name, or "+"-joined combo (e.g. "enter", "a", "shift+sym")'),
      frames: z.number().int().positive().default(5).describe('How many frames to hold the key'),
    } },
    async ({ name, frames }) => {
      const spec = state.spec;
      const kb = activeKeyboard();
      // Support combos like "sym+p", "shift+2"
      const parts = name.toLowerCase().split('+');
      const codes: string[] = [];
      for (const p of parts) {
        const code = KEY_NAME_MAP[p.trim()];
        if (!code) return text(`Unknown key: ${p.trim()}. Available: ${Object.keys(KEY_NAME_MAP).join(', ')}`);
        codes.push(code);
      }
      for (const c of codes) kb.handleKeyEvent(c, true);
      for (let i = 0; i < frames; i++) spec.tick();
      for (const c of codes) kb.handleKeyEvent(c, false);
      spec.tick();
      return text(`Key '${name}' held for ${frames} frames`);
    },
  );

  server.registerTool(
    'type',
    { description: 'Type a string of characters, pressing each key for a few frames. Handles letters, digits, symbols. Use backtick-delimited names for control keys: `enter`, `backspace`, `left`, `right`, `up`, `down`, `escape`, `space`, `shift`, `sym`, `capslock`. Each backtick token is pressed and released on its own, so combos cannot be held here — to enter extended mode (CAPS SHIFT + SYMBOL SHIFT held together) use the `key` tool with "shift+sym".', inputSchema: { text: z.string().describe('Text to type, e.g. "LOAD \\"\\"`enter`" or "10 PRINT `shift`2`enter`"') } },
    async ({ text: str }) => {
      const spec = state.spec;
      const kb = activeKeyboard();
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
          if (CHAR_KEYS[ch]) {
            tokens.push(CHAR_KEYS[ch]);
          } else if (KEY_NAME_MAP[lower]) {
            tokens.push(ch >= 'A' && ch <= 'Z' ? ['shift', lower] : [lower]);
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
        for (const c of codes) kb.handleKeyEvent(c, true);
        for (let f = 0; f < 5; f++) {
          spec.tick();
          hit = checkWatchHit(spec);
          if (hit) { for (const c of codes) kb.handleKeyEvent(c, false); break typeLoop; }
        }
        for (const c of codes) kb.handleKeyEvent(c, false);
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
