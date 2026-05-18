import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { h16 } from '../hex.ts';
import { symbols } from '../state.ts';
import { text } from '../format.ts';

export function register(server: McpServer): void {
  server.tool(
    'symbols_load',
    'Load symbols from an sjasmplus .lst file. Recognises both `name:` labels and `name equ <literal>` defines. Replaces matching names; other symbols are kept.',
    { path: z.string().describe('Path to the .lst file (e.g. "../opencpm-plus3/build/bios.lst")') },
    async ({ path: p }) => {
      if (!fs.existsSync(p)) return text(`File not found: ${p}`);
      const txt = fs.readFileSync(p, 'utf8');
      const before = symbols.size;
      const r = symbols.loadLst(txt, p);
      const added = symbols.size - before;
      return text(
        `Loaded ${r.labels} label(s) and ${r.equs} equ(s) from ${path.basename(p)} ` +
        `(${added} new, ${r.skippedEqu} equ skipped as non-literal). Total: ${symbols.size}.`
      );
    },
  );

  server.tool(
    'symbols',
    'List symbols, or look up a single name. Without args: lists all (capped at 200). With prefix: filters by case-sensitive prefix. With name: returns just that symbol.',
    {
      name:   z.string().optional().describe('Exact symbol name to resolve.'),
      prefix: z.string().optional().describe('Filter the listing to symbols starting with this string.'),
    },
    async ({ name, prefix }) => {
      if (symbols.size === 0) return text('No symbols loaded. Use symbols_load first.');
      if (name) {
        const s = symbols.lookup(name);
        if (!s) return text(`Symbol not found: ${name}`);
        return text(`${s.name} = ${h16(s.value)}  (${s.kind})`);
      }
      let list = symbols.entries();
      if (prefix) list = list.filter(s => s.name.startsWith(prefix));
      if (list.length === 0) return text(`No symbols match prefix "${prefix}"`);
      const shown = list.slice(0, 200);
      const lines = shown.map(s => `${h16(s.value)}  ${s.name}${s.kind === 'equ' ? '  (equ)' : ''}`);
      const suffix = list.length > shown.length ? `\n... ${list.length - shown.length} more (use prefix= to filter)` : '';
      return text(`${lines.length} symbol(s)${symbols.source ? ` from ${path.basename(symbols.source)}` : ''}:\n${lines.join('\n')}${suffix}`);
    },
  );
}
