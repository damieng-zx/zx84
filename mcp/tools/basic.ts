/**
 * BASIC listing and BASIC variables, read from the active machine's
 * `services.inspect` — the same on-demand inspection service the debug panes
 * bind to, so the headless server and the UI show identical output.
 *
 * A machine with no BASIC parser omits the member; these tools then say so
 * rather than returning an empty program (which would look like a cleared
 * program in RAM).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { state } from '../state.ts';
import { text } from '../format.ts';
import type { BasicListingLine, BasicVariable } from '../../src/basic/types.ts';

/** The machine's inspection service, or a refusal when it has no BASIC parser. */
function basicInspector(kind: 'basicListing' | 'basicVars'): string | null {
  const inspect = state.spec.services.inspect;
  if (!inspect?.[kind]) {
    return `The active machine (${state.model.toUpperCase()}) has no BASIC ${kind === 'basicListing' ? 'listing' : 'variables'} parser.`;
  }
  return null;
}

/** `10 PRINT "HELLO"` — the line number, then the detokenised body.
 *
 *  The parsers emit token text with the surrounding spaces it needs mid-line
 *  (`' PRINT '` so `PRINT a` reads correctly), which leaves a spurious leading
 *  space at the start of a line. LIST starts flush, so trim it there and leave
 *  every interior space alone. */
function formatListing(lines: BasicListingLine[]): string {
  return lines.map(l => `${l.lineNumber} ${l.text.trimStart()}`).join('\n');
}

/** One variable per line: `a = 42`, `s$ = "hi"`, `FOR i = 1 TO 10 STEP 2`. */
function formatVariable(v: BasicVariable): string {
  const detail = v.detail ? ` ${v.detail}` : '';
  return v.kind === 'array'
    ? `${v.name}${detail}`
    : `${v.name} = ${v.value ?? ''}${detail}`;
}

export function register(server: McpServer): void {
  server.registerTool(
    'basic_listing',
    { description: 'List the BASIC program currently in memory, detokenised in the dialect of the active machine\'s own BASIC (every machine with a BASIC listing pane). line is an optional line number, or a range such as "100-200". Empty means no program is in memory — an unlistable program or a machine with no BASIC parser says so instead.', inputSchema: {
      line: z.string().optional().describe('A line number, or a range "from-to" (inclusive). Omit for the whole program.'),
    } },
    async ({ line }) => {
      const refusal = basicInspector('basicListing');
      if (refusal) return text(refusal);
      const lines = state.spec.services.inspect!.basicListing!();
      if (lines.length === 0) return text('No BASIC program in memory.');

      let selected = lines;
      if (line !== undefined && line.trim() !== '') {
        const range = parseLineRange(line);
        if (!range) return text(`Invalid line "${line}" — expected a line number or a range such as "100-200".`);
        selected = lines.filter(l => l.lineNumber >= range.from && l.lineNumber <= range.to);
        if (selected.length === 0) {
          return text(`No program lines in ${range.from === range.to ? `line ${range.from}` : `the range ${range.from}-${range.to}`}. The program has ${lines.length} line(s), ${lines[0].lineNumber}-${lines[lines.length - 1].lineNumber}.`);
        }
      }
      return text(formatListing(selected));
    },
  );

  server.registerTool(
    'basic_vars',
    { description: 'List the active machine BASIC\'s variables: simple variables as the interpreter prints them (numbers, strings, integers), arrays with their dimensions, and FOR loops in progress with their TO and STEP. name filters by exact variable name (case-insensitive, as the machine prints it). Reports that there are none when the variables area is empty.', inputSchema: {
      name: z.string().optional().describe('Only this variable (e.g. "a", "a$", "count"). Omit for all.'),
    } },
    async ({ name }) => {
      const refusal = basicInspector('basicVars');
      if (refusal) return text(refusal);
      const vars = state.spec.services.inspect!.basicVars!();
      if (vars.length === 0) return text('No BASIC variables defined.');

      if (name !== undefined && name.trim() !== '') {
        const want = name.trim().toLowerCase();
        const match = vars.filter(v => v.name.toLowerCase() === want);
        if (match.length === 0) {
          return text(`No variable named "${name}". Defined: ${vars.map(v => v.name).join(', ')}`);
        }
        return text(match.map(formatVariable).join('\n'));
      }
      const body = vars.map(formatVariable).join('\n');
      return text(`${vars.length} variable(s):\n${body}`);
    },
  );
}

/** "150" → 150-150, "100-200" → 100-200. Anything else is rejected. */
function parseLineRange(spec: string): { from: number; to: number } | null {
  const raw = spec.trim();
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(raw);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    return from <= to ? { from, to } : null;
  }
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return { from: n, to: n };
  }
  return null;
}
