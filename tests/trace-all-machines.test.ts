/**
 * Execution trace on every machine: each declares the trace control, its frame
 * loop feeds its CPU family's trace engine, and a traced frame accounts for
 * every instruction the machine ran — each one either logged or folded into a
 * "loops back to" count, in the order it ran.
 *
 * The instructions a frame runs are recorded independently through the trap
 * hook, which the frame loop calls with the pc of each instruction before it
 * runs (and, on a 6502, not for a step that enters an interrupt — the trace
 * logs those as <IRQ>/<NMI> lines instead).
 *
 * No ROM is needed: a Z80 machine with empty memory runs NOPs and a 6502 one
 * runs BRKs through a zero vector. With the firmware in ZX84_ROM_DIR (default
 * mcp/.cache), a CPC 6128 and a BBC Micro are also traced after booting.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registry } from '@/machines/registry.ts';
import { createFrameIndicators as createIndicators, type Machine } from '@/machines/machine.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';

const FAMILIES = registry.map(entry => ({ kind: entry.kind, model: entry.models[0], entry }));

interface Parsed { pcs: number[]; folded: number; interrupts: number; other: string[] }

function parseFull(text: string): Parsed {
  const out: Parsed = { pcs: [], folded: 0, interrupts: 0, other: [] };
  for (const line of text.split('\n')) {
    const loop = /^ {6}\.\.\. loops back to [0-9A-F]{4} x(\d+)$/.exec(line);
    if (loop) { out.folded += Number(loop[1]); continue; }
    if (/^[0-9A-F]{4} {2}<(IRQ|NMI)> /.test(line)) { out.interrupts++; continue; }
    const insn = /^([0-9A-F]{4}) {2}\S/.exec(line);
    if (insn) out.pcs.push(parseInt(insn[1], 16));
    else out.other.push(line);
  }
  return out;
}

/** Trace `frames` frames in full mode, recording the pcs the loop ran. */
function traceFrames(m: Machine, frames: number, keep: (pc: number) => boolean = () => true) {
  const ran: number[] = [];
  m.onTrap = (pc, resume) => { if (!resume && keep(pc)) ran.push(pc); return false; };
  const debug = m.services.debug;
  debug.startTrace('full');
  expect(debug.traceSession()).toBe('full');
  m.runUntil(frames);
  const text = debug.stopTrace();
  m.onTrap = null;
  expect(debug.traceSession()).toBeNull();
  return { ran, parsed: parseFull(text) };
}

/** Every instruction that ran is a logged line or folded, and the logged
 *  ones appear in the order they ran. */
function expectAccountedFor(ran: number[], parsed: Parsed): void {
  expect(parsed.other).toEqual([]);
  expect(parsed.pcs.length).toBeGreaterThan(0);
  expect(parsed.pcs.length + parsed.folded).toBe(ran.length);
  let j = 0;
  for (const pc of parsed.pcs) {
    while (j < ran.length && ran[j] !== pc) j++;
    expect(j, `traced pc ${pc.toString(16)} is not in the run order`).toBeLessThan(ran.length);
    j++;
  }
}

describe.each(FAMILIES)('execution trace on $kind ($model)', ({ kind, model, entry }) => {
  function boot(): Machine {
    const m = entry.create(model, null);
    m.reset();
    return m;
  }

  it('offers the trace control, with zxtl only on a Z80', () => {
    const m = boot();
    try {
      const ui = m.descriptor.ui;
      expect(ui.trace).toBe(true);
      const modes = ui.traceModes ?? ['full', 'portio', 'zxtl'];
      expect(modes).toEqual(m.descriptor.cpuFamily === 'z80' ? ['full', 'portio', 'zxtl'] : ['full', 'portio']);
    } finally { m.destroy(); }
  });

  it('a full trace of a frame accounts for every instruction run', () => {
    const m = boot();
    try {
      // The Spectrum's trace leaves out the ROM (below 0x4000). The MSX serves
      // the BIOS cassette-write entries (TAPOON 00EA, TAPOUT 00ED) natively
      // instead of running them, which empty memory walks straight into.
      const keep = kind === 'spectrum' ? (pc: number) => pc >= 0x4000
        : kind === 'msx' ? (pc: number) => pc !== 0x00EA && pc !== 0x00ED
        : () => true;
      m.runUntil(1);
      const { ran, parsed } = traceFrames(m, 2, keep);
      expectAccountedFor(ran, parsed);
    } finally { m.destroy(); }
  });

  it('the frame probe reports a running trace, and stops reporting it when stopped', () => {
    const m = boot();
    try {
      const ind = createIndicators();
      m.services.debug.startTrace('full');
      m.services.probe.sample(ind);
      expect(ind.tracingActive).toBe(true);
      m.services.debug.stopTrace();
      m.services.probe.sample(ind);
      expect(ind.tracingActive).toBe(false);
    } finally { m.destroy(); }
  });

  it('a portio trace returns a summary and leaves the machine\'s bus as it was', () => {
    const m = boot();
    const fresh = boot();
    try {
      const debug = m.services.debug;
      debug.startTrace('portio');
      m.runUntil(2);
      const text = debug.stopTrace();
      expect(text).toMatch(m.descriptor.cpuFamily === 'z80' ? /^=== Port IO Summary ===/ : /^=== I\/O Access Summary ===/);
      // Running on after the trace: identical to a machine never traced.
      fresh.runUntil(2);
      m.runUntil(4);
      fresh.runUntil(4);
      expect(m.services.debug.pc).toBe(fresh.services.debug.pc);
      expect(m.services.debug.tStates).toBe(fresh.services.debug.tStates);
    } finally { m.destroy(); fresh.destroy(); }
  });

  it('a mode it does not offer starts nothing', () => {
    const m = boot();
    try {
      m.services.debug.startTrace('bogus');
      expect(m.services.debug.traceSession()).toBeNull();
      if (m.descriptor.cpuFamily !== 'z80') {
        m.services.debug.startTrace('zxtl');
        expect(m.services.debug.traceSession()).toBeNull();
      }
    } finally { m.destroy(); }
  });
});

const ROM_DIR = process.env.ZX84_ROM_DIR ?? resolve(__dirname, '../mcp/.cache');
const rom = (n: string): Uint8Array => new Uint8Array(readFileSync(resolve(ROM_DIR, n)));
const have = (...names: string[]): boolean => names.every(n => existsSync(resolve(ROM_DIR, n)));

describe.skipIf(!have('os6128.rom', 'basic1-1.rom', 'amsdos.rom'))('trace on a booted CPC 6128', () => {
  it('traces firmware code at its ROM addresses', () => {
    const m = new CpcMachine('cpc6128', null);
    try {
      m.memory.loadRoms(rom('os6128.rom'), rom('basic1-1.rom'), rom('amsdos.rom'));
      m.reset();
      for (let f = 0; f < 150; f++) m.tick();
      const { ran, parsed } = traceFrames(m, 1);
      expectAccountedFor(ran, parsed);
      // At the Ready prompt the firmware waits for a key: its code is in the
      // lower ROM (0000-3FFF) and the firmware jumpblock RAM above B900.
      expect(parsed.pcs.some(pc => pc < 0x4000)).toBe(true);
    } finally { m.destroy(); }
  });
});

describe.skipIf(!have('bbc-os12.rom', 'bbc-basic2.rom'))('trace on a booted BBC Micro', () => {
  it('traces MOS code and its hardware accesses', () => {
    const image = new Uint8Array(0x8000);
    image.set(rom('bbc-os12.rom'), 0);
    image.set(rom('bbc-basic2.rom'), 0x4000);
    const m = new BbcMachine('bbc-b', null);
    try {
      m.loadROM(image);
      m.reset();
      for (let f = 0; f < 150; f++) m.tick();
      const { ran, parsed } = traceFrames(m, 1);
      expectAccountedFor(ran, parsed);
      // The MOS lives at C000-FFFF, and its 100Hz timer interrupt comes in.
      expect(parsed.pcs.some(pc => pc >= 0xC000)).toBe(true);
      expect(parsed.interrupts).toBeGreaterThan(0);
      // The interrupt handler reads the system VIA's flags.
      m.services.debug.startTrace('portio');
      m.tick();
      const io = m.services.debug.stopTrace();
      expect(io).toMatch(/\n {2}FE4D +\d+x {2}SYSVIA /);
    } finally { m.destroy(); }
  });
});
