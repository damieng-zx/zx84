/**
 * The MCP side of the beam log (docs/beam-debug-mcp-spec.md): arming a
 * machine's `BeamLog`, packing register snapshots into its entries, and turning
 * entries into text. The log itself, and the producers that fill it, live in
 * the machine (`src/debug/beam-log.ts`); this module only arms, filters and
 * formats.
 */

import {
  BeamLog, parseBeamRange, BEAM_DL, BEAM_DMA, BEAM_EFF, BEAM_IO, BEAM_IRQ, BEAM_PC, BEAM_KIND_NAMES,
  DL_FETCH, DL_VISIBLE, type BeamEntry, type BeamInfo,
} from '../src/debug/beam-log.ts';
import type { Machine } from '../src/machines/machine.ts';
import { hex8 as h8, hex16 as h16 } from '../src/utils/hex.ts';

/** Why a machine could not be armed. */
export const NO_BEAM = 'This machine has no beam position to report (beam logging is not supported on it yet).';

/**
 * Make sure the machine has a beam log, and set its capture filters when the
 * caller gave any. Returns null on a machine that cannot report a beam.
 * Filters stay as they are when neither argument is given.
 */
export function armBeamLog(spec: Machine, frames?: string, lines?: string): BeamLog | null {
  const info = spec.beamInfo();
  if (info === null) return null;
  if (spec.beamLog === null) spec.beamLog = new BeamLog();
  if (frames !== undefined || lines !== undefined) {
    spec.beamLog.setFilter(parseBeamRange(frames), parseBeamRange(lines), info.cyclesPerLine);
  }
  return spec.beamLog;
}

// ── Trap labels ─────────────────────────────────────────────────────────────

/** `pc` entries carry their trap's label as an index into this table. */
const labels: string[] = [];
const labelIds = new Map<string, number>();

export function labelId(label: string): number {
  let id = labelIds.get(label);
  if (id === undefined) {
    id = labels.length;
    labels.push(label);
    labelIds.set(label, id);
  }
  return id;
}

// ── Register snapshots ──────────────────────────────────────────────────────

/** Entry flag: the entry carries a register snapshot. */
export const FLAG_REGS = 1;

/**
 * Pack the CPU's registers into the two words a `pc` entry has room for.
 * 6502: A, X, Y, SP in the first, P in the second. Z80: AF, BC, DE, HL (SP,
 * IX, IY and the shadow set are not captured). Other families: zero.
 */
export function packRegs(spec: Machine): [number, number] {
  const dbg = spec.services.debug;
  const g = (n: string): number => dbg.getReg(n) ?? 0;
  if (dbg.cpuFamily === 'm6502') {
    return [(g('A') | (g('X') << 8) | (g('Y') << 16) | (g('S') << 24)) | 0, g('P')];
  }
  return [(g('AF') | (g('BC') << 16)) | 0, (g('DE') | (g('HL') << 16)) | 0];
}

function formatRegs(spec: Machine, e: BeamEntry): string {
  if (spec.services.debug.cpuFamily === 'm6502') {
    const a = e.regLo & 0xFF, x = (e.regLo >>> 8) & 0xFF, y = (e.regLo >>> 16) & 0xFF, s = (e.regLo >>> 24) & 0xFF;
    return `[A=${h8(a)} X=${h8(x)} Y=${h8(y)} SP=${h8(s)} P=${h8(e.regHi & 0xFF)}]`;
  }
  const af = e.regLo & 0xFFFF, bc = (e.regLo >>> 16) & 0xFFFF, de = e.regHi & 0xFFFF, hl = (e.regHi >>> 16) & 0xFFFF;
  return `[AF=${h16(af)} BC=${h16(bc)} DE=${h16(de)} HL=${h16(hl)}]`;
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface BeamReadOptions {
  offset: number;
  limit: number;
  /** Show the raw `t` as well as line and cycle. */
  showT: boolean;
  /** Count lines from the first display line instead of the frame start. */
  relDisplay: boolean;
  /** Only these kinds (names from BEAM_KIND_NAMES), or all. */
  kinds?: Set<number>;
}

/** Split `t` into line and cycle, optionally measured from the display start. */
export function lineCycle(t: number, info: BeamInfo, relDisplay: boolean): { line: number; cycle: number } {
  const base = relDisplay ? t - info.displayStart : t;
  const line = Math.floor(base / info.cyclesPerLine);
  return { line, cycle: base - line * info.cyclesPerLine };
}

/** A header saying what the numbers mean on this machine. */
export function beamHeader(spec: Machine, log: BeamLog, opts: { relDisplay: boolean }): string {
  const info = spec.beamInfo();
  const lines = [`Beam log: ${log.length} entries held (capacity ${log.capacity}, dropped ${log.dropped}).`];
  if (info) {
    const dl = Math.floor(info.displayStart / info.cyclesPerLine);
    const dc = info.displayStart - dl * info.cyclesPerLine;
    lines.push(
      `frame = frames completed since reset; line/cycle derived from t (cycles since frame start): ` +
      `${info.cyclesPerLine} cycles/line, ${info.linesPerFrame} lines/frame; display starts at t=${info.displayStart} ` +
      `(line ${dl}, cycle ${dc})` +
      (opts.relDisplay ? '; line 0 = first display line.' : '.'));
  }
  if (spec.kind === 'atari') {
    lines.push('Atari: cycle 0 = the missile DMA slot at the start of the line. This core releases WSYNC at the line ' +
      'boundary, so cycles after a WSYNC run about 9 later than the Altirra manual / hardware; DMA cycles are ' +
      'interpolated; read stamps other than the common loads are approximate (the last cycle of the instruction).');
  }
  return lines.join('\n');
}

export function formatEntry(spec: Machine, e: BeamEntry, opts: BeamReadOptions): string {
  const info = spec.beamInfo();
  const { line, cycle } = info ? lineCycle(e.t, info, opts.relDisplay) : { line: 0, cycle: e.t };
  const stamp = `${e.frame} ${line} ${cycle}${opts.showT ? ` t=${e.t}` : ''}`;
  switch (e.kind) {
    case BEAM_PC: {
      const label = labels[e.addr] ?? '';
      const regs = (e.flags & FLAG_REGS) ? ` ${formatRegs(spec, e)}` : '';
      return `${stamp} ${h16(e.pc)} ${label}${regs}`;
    }
    case BEAM_IO: {
      const port = (e.flags & 2) !== 0;
      const write = (e.flags & 1) !== 0;
      return `${stamp} ${h16(e.pc)} ${h16(e.addr)} ${h8(e.value & 0xFF)} ${port ? (write ? 'out' : 'in') : (write ? 'w' : 'r')}`;
    }
    case BEAM_IRQ: {
      const nmi = (e.flags & 1) !== 0;
      const depth = e.flags >> 8;
      const kind = nmi ? 'NMI' : 'IRQ';
      if ((e.flags & 2) === 0) {
        const detail = spec.kind === 'atari' ? ` ${atariIrqType(nmi, e.value)}` : '';
        return `${stamp} ${kind} enter${detail} handler=${h16(e.addr)} from=${h16(e.pc)} depth=${depth}`;
      }
      const entered = info ? lineCycle(e.regHi, info, opts.relDisplay) : { line: 0, cycle: e.regHi };
      return `${stamp} ${kind} end handler=${h16(e.addr)} to=${h16(e.pc)} cost=${e.value} cycles depth=${depth} ` +
        `(entered ${e.regLo} ${entered.line} ${entered.cycle})`;
    }
    case BEAM_DL: {
      if ((e.flags & DL_FETCH) !== 0) return `${stamp} dl fetch at=${h16(e.pc)} ${describeDlInstruction(e.value, e.addr)}`;
      return `${stamp} dl write ${h16(e.addr)}=${h8(e.value & 0xFF)} pc=${h16(e.pc)}` +
        ((e.flags & DL_VISIBLE) !== 0 ? ' VISIBLE: the display list restarts mid-frame' : '');
    }
    case BEAM_DMA:
      return `${stamp} dma total=${e.value} refresh=${e.regHi} dl=${e.regLo & 0xFF} screen=${(e.regLo >>> 8) & 0xFF} ` +
        `glyph=${(e.regLo >>> 16) & 0xFF} pm=${(e.regLo >>> 24) & 0xFF}`;
    case BEAM_EFF: {
      const source = (e.flags & 1) !== 0 ? `write at cycle ${e.regLo & 0xFFFF}` : 'carried from before the line';
      const late = e.flags >> 8;
      const lateText = late > 0
        ? ` late: ${late} write(s) after cycle ${e.regLo >>> 16}, the last ${h8(e.regHi & 0xFF)} at cycle ${e.regHi >>> 8}; takes effect next line`
        : '';
      return `${stamp} HSCROL=${(e.value & 0x0F).toString(16).toUpperCase()} (${source})${lateText}`;
    }
    default:
      return `${stamp} ${BEAM_KIND_NAMES[e.kind] ?? `kind${e.kind}`} pc=${h16(e.pc)} addr=${h16(e.addr)} value=${e.value} flags=${e.flags}`;
  }
}

/** Atari: what raised an interrupt, from the status register at entry (NMIST
 *  for an NMI; POKEY's IRQST, active low, for an IRQ). */
export function atariIrqType(nmi: boolean, status: number): string {
  if (nmi) {
    if ((status & 0x20) !== 0) return 'RESET';
    if ((status & 0x40) !== 0) return 'VBI';
    if ((status & 0x80) !== 0) return 'DLI';
    return 'NMI?';
  }
  const pending = ~status & 0xFF;
  const names: [number, string][] = [
    [0x80, 'BREAK'], [0x40, 'KEY'], [0x20, 'SERIN'], [0x10, 'SEROUT'], [0x08, 'SERDONE'],
    [0x04, 'TIMER4'], [0x02, 'TIMER2'], [0x01, 'TIMER1'],
  ];
  const hit = names.filter(([bit]) => (pending & bit) !== 0).map(([, n]) => n);
  return hit.length > 0 ? hit.join('+') : 'IRQ?';
}

/** A display-list instruction in words. */
export function describeDlInstruction(instr: number, operand: number): string {
  const mode = instr & 0x0F;
  const dli = (instr & 0x80) !== 0 ? ' DLI' : '';
  if (mode === 0) return `blank ${((instr >> 4) & 7) + 1}${dli}`;
  if (mode === 1) return `${(instr & 0x40) !== 0 ? 'JVB' : 'JMP'} ${h16(operand)}${dli}`;
  return `mode ${mode.toString(16).toUpperCase()}${(instr & 0x40) !== 0 ? ` LMS ${h16(operand)}` : ''}${dli}` +
    `${(instr & 0x20) !== 0 ? ' VSCROL' : ''}${(instr & 0x10) !== 0 ? ' HSCROL' : ''}`;
}

// ── Read-time views ─────────────────────────────────────────────────────────

/** Frame-relative cycles from one position to a later one. */
function cyclesBetween(info: BeamInfo, f0: number, t0: number, f1: number, t1: number): number {
  return (f1 - f0) * info.cyclesPerLine * info.linesPerFrame + (t1 - t0);
}

interface Acc { n: number; min: number; max: number; sum: number }
const acc = (): Acc => ({ n: 0, min: Infinity, max: -Infinity, sum: 0 });
const add = (a: Acc, v: number): void => { a.n++; a.sum += v; if (v < a.min) a.min = v; if (v > a.max) a.max = v; };
const range = (a: Acc, digits = 0): string =>
  a.n === 0 ? '-' : `${a.min.toFixed(digits)}/${(a.sum / a.n).toFixed(digits)}/${a.max.toFixed(digits)}`;

/**
 * Per interrupt type: how many, the line they start and end on and their cost
 * in cycles (min/avg/max), paired by stack depth (the log's end entries). On
 * the Atari the type is the NMI or IRQ source; elsewhere it is the vector.
 * Named spans (from `interrupt_log`) are reported the same way.
 */
export function interruptStats(spec: Machine, log: BeamLog): string {
  const info = spec.beamInfo();
  if (info === null) return NO_BEAM;
  type Group = { starts: Acc; ends: Acc; cost: Acc };
  const groups = new Map<string, Group>();
  const get = (k: string): Group => {
    let g = groups.get(k);
    if (!g) { g = { starts: acc(), ends: acc(), cost: acc() }; groups.set(k, g); }
    return g;
  };
  const open: string[] = [];
  const spanStart = new Map<string, { frame: number; t: number }>();
  for (let i = 0; i < log.length; i++) {
    const e = log.get(i);
    if (e.kind === BEAM_IRQ) {
      const nmi = (e.flags & 1) !== 0;
      if ((e.flags & 2) === 0) {
        const key = spec.kind === 'atari' ? `${nmi ? 'NMI' : 'IRQ'} ${atariIrqType(nmi, e.value)}` : `${nmi ? 'NMI' : 'IRQ'} ${h16(e.addr)}`;
        open.push(key);
        add(get(key).starts, Math.floor(e.t / info.cyclesPerLine));
      } else {
        const key = open.pop() ?? `${nmi ? 'NMI' : 'IRQ'} ${h16(e.addr)}`;
        const g = get(key);
        add(g.ends, Math.floor(e.t / info.cyclesPerLine));
        add(g.cost, e.value);
      }
    } else if (e.kind === BEAM_PC) {
      const label = labels[e.addr] ?? '';
      const m = /^(.*):(from|to)$/.exec(label);
      if (!m) continue;
      if (m[2] === 'from') spanStart.set(m[1], { frame: e.frame, t: e.t });
      else {
        const s = spanStart.get(m[1]);
        if (!s) continue;
        const g = get(`span ${m[1]}`);
        add(g.starts, Math.floor(s.t / info.cyclesPerLine));
        add(g.ends, Math.floor(e.t / info.cyclesPerLine));
        add(g.cost, cyclesBetween(info, s.frame, s.t, e.frame, e.t));
        spanStart.delete(m[1]);
      }
    }
  }
  if (groups.size === 0) return 'No interrupts or spans recorded.';
  const rows = [...groups.entries()].map(([k, g]) =>
    `${k.padEnd(18)} n=${String(g.ends.n || g.starts.n).padStart(5)}  start line min/avg/max ${range(g.starts, 1)}  ` +
    `end line ${range(g.ends, 1)}  cost cycles ${range(g.cost, 0)}`);
  return ['Interrupts and spans (paired by stack depth / named addresses):', ...rows].join('\n');
}

/**
 * `pairs`: for each time the `pc` log shows address A and then address B next
 * after it, how far apart the two were. A STA WSYNC and the instruction after
 * it show a caught WSYNC as +1 line and a slipped one as +2.
 */
export function pairDeltas(spec: Machine, log: BeamLog, pairs: Array<[number, number]>): string {
  const info = spec.beamInfo();
  if (info === null) return NO_BEAM;
  const out: string[] = [];
  for (const [a, b] of pairs) {
    const hist = new Map<number, number>();
    let open: BeamEntry | null = null;
    let n = 0;
    const examples: string[] = [];
    for (let i = 0; i < log.length; i++) {
      const e = log.get(i);
      if (e.kind !== BEAM_PC) continue;
      if (e.pc === a) { open = e; continue; }
      if (e.pc === b && open !== null) {
        const f = Math.floor(open.t / info.cyclesPerLine);
        const cyc = cyclesBetween(info, open.frame, open.t, e.frame, e.t);
        const lines = Math.floor((open.t % info.cyclesPerLine + cyc) / info.cyclesPerLine);
        hist.set(lines, (hist.get(lines) ?? 0) + 1);
        n++;
        if (examples.length < 3) examples.push(`frame ${open.frame} line ${f}: ${cyc} cycles, +${lines} line(s)`);
        open = null;
      }
    }
    const h = [...hist.entries()].sort((x, y) => x[0] - y[0]).map(([l, c]) => `+${l} line(s) x${c}`).join(', ');
    out.push(`${h16(a)} -> ${h16(b)}: ${n} pair(s)${h ? `: ${h}` : ''}${examples.length ? `\n  e.g. ${examples.join('; ')}` : ''}`);
  }
  return out.join('\n');
}

/** `at: N`: the HSCROL each line would have if the cutoff were cycle N,
 *  from the logged writes to $D404 (an experiment: not the renderer's rule). */
export function hscrolAt(spec: Machine, log: BeamLog, at: number): string {
  const info = spec.beamInfo();
  if (info === null) return NO_BEAM;
  const lines: string[] = [];
  for (let i = 0; i < log.length; i++) {
    const e = log.get(i);
    if (e.kind !== BEAM_IO || e.addr !== 0xD404 || (e.flags & 1) === 0) continue;
    const line = Math.floor(e.t / info.cyclesPerLine);
    const cycle = e.t - line * info.cyclesPerLine;
    // A write at or before the cutoff applies to its own line, a later one to the next.
    const effective = cycle <= at ? line : line + 1;
    lines.push(`${e.frame} ${effective} HSCROL=${(e.value & 0x0F).toString(16).toUpperCase()} (written at line ${line} cycle ${cycle})`);
  }
  return [`HSCROL by write, with the cutoff at cycle ${at} (an experiment: this is not the renderer's own rule):`, ...lines].join('\n');
}

/** Parse a comma list of kind names into kind numbers; null = all. */
export function parseKinds(spec: string | undefined): Set<number> | null {
  if (!spec) return null;
  const want = new Set(spec.split(/[\s,]+/).filter(Boolean).map(s => s.toLowerCase()));
  const out = new Set<number>();
  for (const k of [BEAM_PC, BEAM_IO, BEAM_IRQ, BEAM_DL, BEAM_DMA, BEAM_EFF]) {
    if (want.has(BEAM_KIND_NAMES[k])) out.add(k);
  }
  return out;
}

/** Entries matching the kind filter, oldest first, as indexes into the log. */
export function matchingIndexes(log: BeamLog, kinds: Set<number> | null | undefined): number[] {
  const out: number[] = [];
  for (let i = 0; i < log.length; i++) {
    if (!kinds || kinds.has(log.get(i).kind)) out.push(i);
  }
  return out;
}
