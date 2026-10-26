import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hex16 as h16 } from '../../src/utils/hex.ts';
import type { Machine } from '../../src/machines/machine.ts';
import { BEAM_EFF } from '../../src/debug/beam-log.ts';
import { state } from '../state.ts';
import { parseAddr, text } from '../format.ts';
import { activeAtari } from '../concrete.ts';
import { traps, type Trap } from '../traps.ts';
import { CACHE_DIR } from '../rom-fetch.ts';
import {
  NO_BEAM, armBeamLog, beamHeader, effFilter, formatEntry, hscrolAt, interruptStats, matchingIndexes, pairDeltas,
  parseKinds, type BeamReadOptions,
} from '../beam.ts';

/** Switch every logger off and discard the log. */
function disarm(spec: Machine): void {
  spec.beamLog = null;
  spec.interruptLogging = false;
  const atari = activeAtari();
  if (atari) { atari.dlLogging = false; atari.dmaLogging = false; atari.effLogging = false; }
}

/** An address that may be a loaded symbol, a hex number, or `*addr`: the
 *  16-bit address stored at `addr` (the OS vectors such as VVBLKI at $0222
 *  are RAM pointers the pc never reaches itself). */
function resolveSpanAddress(spec: Machine, s: string): number {
  const t = s.trim();
  if (t.startsWith('*')) {
    const at = parseAddr(t.slice(1)) & 0xFFFF;
    const peek = (a: number): number => spec.memory.peekByte?.(a) ?? spec.memory.readByte(a);
    return peek(at) | (peek((at + 1) & 0xFFFF) << 8);
  }
  return parseAddr(t) & 0xFFFF;
}

function parsePairs(s: string): Array<[number, number]> {
  return s.split(/[\s,]+/).filter(Boolean).map(p => {
    const [a, b] = p.split(/[-:>]+/);
    if (a === undefined || b === undefined) throw new Error(`Invalid pair "${p}" — expected FROM-TO, e.g. 1273-1276`);
    return [parseAddr(a) & 0xFFFF, parseAddr(b) & 0xFFFF] as [number, number];
  });
}

export function register(server: McpServer): void {
  server.registerTool(
    'beam_log',
    { description: 'Control the beam log — the chronological, beam-stamped event log (frame, line, cycle) that "trap" log actions, "memory_watchpoint"/"port_watchpoint" log actions and "interrupt_log" write into. Actions: "status" (default), "start" (arm it and set capture filters), "clear" (drop the entries, keep it armed), "stop" (disarm every logger and discard). Loggers never stop execution: run frames, then read with beam_log_read. On the Atari, eff:true also logs what the renderer decided about HSCROL on every scrolling line (for beam_log_read summary).', inputSchema: {
      action: z.enum(['status', 'start', 'clear', 'stop']).default('status'),
      frames: z.string().optional().describe('Capture only these frames, e.g. "1500-1510". Applied as events are recorded.'),
      lines: z.string().optional().describe('Capture only these lines, e.g. "8-40". Applied as events are recorded.'),
      eff: z.boolean().default(false).describe('Atari: log the renderer\'s HSCROL decision for every scrolling line'),
    } },
    async ({ action, frames, lines, eff }) => {
      const spec = state.spec;
      if (action === 'stop') {
        disarm(spec);
        return text('Beam log stopped and discarded; every logger is off.');
      }
      if (action === 'status') {
        const info = spec.beamInfo();
        if (info === null) return text(NO_BEAM);
        const log = spec.beamLog;
        if (log === null) return text('Beam log: not armed. Arm it with "beam_log start", or with a "trap" log action, a watchpoint log action or "interrupt_log".');
        const atari = activeAtari();
        const on = [
          spec.interruptLogging ? 'interrupts' : '',
          atari?.dlLogging ? 'display list' : '',
          atari?.dmaLogging ? 'dma' : '',
          atari?.effLogging ? 'hscrol decisions' : '',
        ].filter(Boolean);
        return text(`Beam log armed: ${log.length} entries held (capacity ${log.capacity}, dropped ${log.dropped}).${on.length ? ` Also logging: ${on.join(', ')}.` : ''}`);
      }
      const log = armBeamLog(spec, frames, lines);
      if (log === null) return text(NO_BEAM);
      if (action === 'clear') {
        log.clear();
        return text('Beam log cleared.');
      }
      let note = '';
      if (eff) {
        const atari = activeAtari();
        if (atari) atari.effLogging = true;
        else note = ' (eff applies to the Atari only and was ignored)';
      }
      return text(`Beam log armed (capacity ${log.capacity}).${frames || lines ? ` Filters: frames=${frames ?? 'all'} lines=${lines ?? 'all'}.` : ''}${note}`);
    },
  );

  server.registerTool(
    'interrupt_log',
    { description: 'Log interrupts in the beam log: every interrupt the CPU takes (6502 NMI/IRQ, Z80 INT/NMI) with the beam position at entry and at its end, its depth (a VBI inside a DLI is depth 1), and on the Atari what raised it (VBI/DLI/RESET from NMIST; the POKEY source from IRQST). The end of an interrupt is the first instruction at which the stack pointer has risen back above its value at entry — so a handler ending in EI;RET (the 48K Spectrum ROM\'s) pairs too. Read with beam_log_read (stats:true for min/avg/max entry line, end line and cost per type). atari:true also logs the display list (every DLISTL/DLISTH write, flagged VISIBLE when it lands while ANTIC is drawing the picture — the frame-restart case — and every display-list instruction fetched); dma:true logs each line\'s DMA steal. spans names parts inside an interrupt by address — on the Atari the deferred VBI is a JMP inside the NMI, not an interrupt of its own: {name, from, to}, where an address may be *ADDR for the pointer stored at ADDR (e.g. *0222 for VVBLKI).', inputSchema: {
      action: z.enum(['start', 'stop']).default('start'),
      frames: z.string().optional().describe('Capture only these frames, e.g. "1500-1510"'),
      lines: z.string().optional().describe('Capture only these lines, e.g. "8-40"'),
      atari: z.boolean().default(false).describe('Atari: also log display-list events'),
      dma: z.boolean().default(false).describe('Atari: also log the DMA steal of every line (verbose)'),
      spans: z.array(z.object({
        name: z.string(), from: z.string(), to: z.string(),
      })).optional().describe('Named address spans to time, e.g. [{"name":"vbi","from":"*0222","to":"E462"}]'),
    } },
    async ({ action, frames, lines, atari, dma, spans }) => {
      const spec = state.spec;
      if (action === 'stop') {
        spec.interruptLogging = false;
        const a = activeAtari();
        if (a) { a.dlLogging = false; a.dmaLogging = false; }
        return text('Interrupt logging stopped (the log is kept; beam_log stop discards it).');
      }
      if (!spec.supportsInterruptLog()) {
        return text(`Interrupt logging is not supported on this machine (${state.model.toUpperCase()}).`);
      }
      const log = armBeamLog(spec, frames, lines);
      if (log === null) return text(NO_BEAM);
      spec.interruptLogging = true;
      const notes: string[] = [];
      const a = activeAtari();
      if (atari || dma) {
        if (a) { a.dlLogging = atari; a.dmaLogging = dma; }
        else notes.push('atari/dma apply to the Atari only and were ignored');
      }
      for (const sp of spans ?? []) {
        const from = resolveSpanAddress(spec, sp.from);
        const to = resolveSpanAddress(spec, sp.to);
        for (const [address, edge] of [[from, 'from'], [to, 'to']] as const) {
          const trap: Trap = { address, action: 'log', label: `${sp.name}:${edge}`, responses: [] };
          if (!traps.has(address)) traps.set(address, []);
          traps.get(address)!.push(trap);
        }
        notes.push(`span ${sp.name}: ${h16(from)} -> ${h16(to)}`);
      }
      return text(`Interrupt logging armed.${a && (atari || dma) ? ` Atari: display list ${atari ? 'on' : 'off'}, dma ${dma ? 'on' : 'off'}.` : ''}${notes.length ? ` ${notes.join('; ')}.` : ''}`);
    },
  );

  server.registerTool(
    'beam_log_read',
    { description: 'Read the beam log. Rows are "frame line cycle ...": a pc entry (from a trap log action) is "pc label [regs]"; an io entry (from a watchpoint log action) is "pc addr value r|w" (ports: in|out), where pc is the instruction that made the access; irq/dl/dma/eff entries come from interrupt_log and beam_log eff. The header says what the numbers mean on this machine, including how exactly its accesses are stamped. Views computed from the stored entries: stats (interrupt and span cost), summary (the renderer\'s effective HSCROL per line, late writes marked), pairs (how far apart two pc addresses were — a caught WSYNC is +1 line, a slipped one +2) and at (HSCROL with an experimental cutoff cycle).', inputSchema: {
      offset: z.number().int().min(0).default(0).describe('First entry to show (0 = oldest still held)'),
      limit: z.number().int().positive().default(200).describe('Maximum entries to show'),
      kinds: z.string().optional().describe('Only these kinds, comma-separated: pc, io, irq, dl, dma, eff'),
      t: z.boolean().default(false).describe('Also show the raw t (cycles since the frame started)'),
      rel: z.enum(['frame', 'display']).default('frame').describe('"display" counts line 0 from the first display line (lines above it are negative)'),
      format: z.enum(['text', 'json']).default('text'),
      file: z.boolean().default(false).describe('Write every matching entry to a file in the MCP cache dir and return its path'),
      stats: z.boolean().default(false).describe('Instead of rows: per interrupt type and named span, count and min/avg/max start line, end line and cost'),
      summary: z.boolean().default(false).describe('Instead of rows: what the renderer and ANTIC decided per line — the effective HSCROL (late writes marked), each change of a colour register with the pixel it starts at, and the playfield width DMACTL gave (needs beam_log start eff:true)'),
      regs: z.string().optional().describe('With summary: only these — hscrol, dmactl, colour, or a register such as colbk (comma-separated)'),
      pairs: z.string().optional().describe('Instead of rows: gaps between pc addresses, e.g. "1273-1276,1280-1290" (needs log traps at both)'),
      at: z.number().int().min(0).optional().describe('Instead of rows: HSCROL per write with the cutoff at this cycle (needs a log watchpoint on D404)'),
    } },
    async ({ offset, limit, kinds, t, rel, format, file, stats, summary, regs, pairs, at }) => {
      const spec = state.spec;
      if (spec.beamInfo() === null) return text(NO_BEAM);
      const log = spec.beamLog;
      if (log === null) return text('Beam log: not armed.');
      const opts: BeamReadOptions = {
        offset, limit, showT: t, relDisplay: rel === 'display', kinds: parseKinds(kinds) ?? undefined,
      };
      const header = beamHeader(spec, log, { relDisplay: opts.relDisplay });

      if (stats || summary || pairs !== undefined || at !== undefined) {
        const parts: string[] = [header];
        if (stats) parts.push(interruptStats(spec, log));
        if (pairs !== undefined) parts.push(pairDeltas(spec, log, parsePairs(pairs)));
        if (at !== undefined) parts.push(hscrolAt(spec, log, at));
        if (summary) {
          const keep = effFilter(regs);
          const idx = matchingIndexes(log, new Set([BEAM_EFF])).filter(i => keep === null || keep(log.get(i).addr));
          if (idx.length === 0) {
            parts.push('No decisions recorded. Arm with "beam_log start eff:true" and run frames (HSCROL needs horizontal scrolling on; colours need a register written during a line).');
          } else {
            const start = Math.min(offset, idx.length);
            const end = Math.min(start + limit, idx.length);
            const rows: string[] = [];
            for (let i = start; i < end; i++) rows.push(formatEntry(spec, log.get(idx[i]), opts));
            parts.push(`What the renderer and ANTIC decided (late writes marked), ${start}..${end - 1} of ${idx.length}:\n${rows.join('\n')}`);
          }
        }
        return text(parts.join('\n\n'));
      }

      const idx = matchingIndexes(log, opts.kinds ?? null);
      const rows = (from: number, to: number): string[] => {
        const out: string[] = [];
        for (let i = from; i < to && i < idx.length; i++) {
          const e = log.get(idx[i]);
          out.push(format === 'json' ? JSON.stringify(e) : formatEntry(spec, e, opts));
        }
        return out;
      };
      if (file) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const outPath = path.join(CACHE_DIR, `beam-log-${Date.now()}.txt`);
        fs.writeFileSync(outPath, `${header}\n${rows(0, idx.length).join('\n')}\n`);
        return text(`Beam log: ${idx.length} matching entries written to ${outPath}`);
      }
      if (idx.length === 0) return text(`${header}\nNo matching entries.`);
      const start = Math.min(offset, idx.length);
      const end = Math.min(start + limit, idx.length);
      return text(`${header}\nShowing ${start}..${end - 1} of ${idx.length} matching:\n\n${rows(start, end).join('\n')}`);
    },
  );
}
