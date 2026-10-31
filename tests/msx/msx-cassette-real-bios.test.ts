/**
 * The pulse-level cassette against the real HX-10 BIOS (mcp/.cache/
 * hx-10_basic-bios1.rom, or MSX_HX10_BIOS; skipped without it).
 *
 * The BIOS is the reference here: CSAVE writes a program (through the
 * TAPOON/TAPOUT traps, as a .cas), and with "Fast ROM loading" off the BIOS's
 * own TAPION/TAPIN must read that .cas back from its synthesised FSK signal on
 * PSG register 14 bit 7 — the same path a loader that samples the port uses.
 * The BIOS also records what it writes: with the save traps bypassed, its
 * TAPOON/TAPOUT drive PPI port C bit 5, whose timing is compared with the
 * signal the deck plays.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MsxMachine } from '@/machines/msx/msx-machine.ts';
import { casToPulseBlocks, CAS_HEADER } from '@/media/tape/cas.ts';
import { TAPE_REF_HZ, type CswBlock } from '@/media/tape/tap.ts';

const BIOS = process.env.MSX_HX10_BIOS ?? join(import.meta.dirname, '../../mcp/.cache/hx-10_basic-bios1.rom');

/** Host key codes for the characters the tests type (UK layout). */
function keyFor(ch: string): { code: string; shift: boolean } {
  if (ch === ' ') return { code: 'Space', shift: false };
  if (ch === '"') return { code: 'Quote', shift: true };
  if (ch === '\n') return { code: 'Enter', shift: false };
  if (/[0-9]/.test(ch)) return { code: `Digit${ch}`, shift: false };
  return { code: `Key${ch.toUpperCase()}`, shift: false };
}

function press(m: MsxMachine, ch: string): void {
  const { code, shift } = keyFor(ch);
  if (shift) m.keyboard.handleKeyEvent('ShiftLeft', true);
  m.keyboard.handleKeyEvent(code, true);
  for (let i = 0; i < 4; i++) m.tick();
  m.keyboard.handleKeyEvent(code, false);
  if (shift) m.keyboard.handleKeyEvent('ShiftLeft', false);
  for (let i = 0; i < 4; i++) m.tick();
}

function type(m: MsxMachine, text: string): void { for (const ch of text) press(m, ch); }

function boot(rom: Uint8Array): MsxMachine {
  const m = new MsxMachine('hx-10', null);
  m.loadROM(rom);
  m.turbo = true;
  m.reset();
  for (let i = 0; i < 300; i++) m.tick();
  return m;
}

/** Run until `done` or `frames` frames, returning whether it happened. */
function runUntil(m: MsxMachine, frames: number, done: () => boolean): boolean {
  for (let i = 0; i < frames; i++) {
    m.tick();
    if (done()) return true;
  }
  return false;
}

describe.skipIf(!existsSync(BIOS))('MSX cassette against the real HX-10 BIOS', () => {
  const rom = existsSync(BIOS) ? new Uint8Array(readFileSync(BIOS)) : new Uint8Array(0);

  /** CSAVE a one-line program through the save traps; returns the .cas. */
  function savedProgram(): Uint8Array {
    const m = boot(rom);
    try {
      type(m, '10 print 4242\n');
      type(m, 'csave "pulse"\n');
      runUntil(m, 200, () => m.services.tape.recordedBytes() !== null && m.ocrScreenForMcp().trimEnd().endsWith('Ok'));
      const rec = m.services.tape.recordedBytes();
      expect(rec).not.toBeNull();
      return rec!.data;
    } finally { m.destroy(); }
  }

  it('CLOAD reads a .cas through the FSK signal on PSG register 14 bit 7 with the traps off', () => {
    const cas = savedProgram();
    const m = boot(rom);
    try {
      m.tapeFastRom = false;
      m.services.tape.mount(cas, 'pulse.cas');
      const trap = vi.spyOn(m.cassette, 'findHeader');
      type(m, 'cload\n');
      // The long header alone is 6.4 s; allow 30 s of emulated time.
      const loaded = runUntil(m, 1500, () => /Found:pulse[\s\S]*Ok/i.test(m.ocrScreenForMcp()));
      expect(loaded).toBe(true);
      expect(trap).not.toHaveBeenCalled();
      type(m, 'run\n');
      runUntil(m, 20, () => false);
      expect(m.ocrScreenForMcp().split('\n').some(l => l.trim() === '4242')).toBe(true);
    } finally { m.destroy(); }
  });

  it('the same CLOAD with fast loading on is served by the traps', () => {
    const cas = savedProgram();
    const m = boot(rom);
    try {
      m.services.tape.mount(cas, 'pulse.cas');
      type(m, 'cload\n');
      // Instant: well under the header's 6.4 s (320 frames).
      expect(runUntil(m, 60, () => /Found:pulse[\s\S]*Ok/i.test(m.ocrScreenForMcp()))).toBe(true);
      expect(m.cassette.currentBlock()).toBe(1);
    } finally { m.destroy(); }
  });

  it('the deck plays what the BIOS itself writes: 2400/1200 Hz halves, 15360-cycle long header', () => {
    // Drive TAPOON(A=1)/TAPOUT 0x00,0xFF,0x55 by stepping the CPU directly
    // (no frame loop, so no save traps) and time PPI port C bit 5.
    const m = boot(rom);
    try {
      m.stop();
      const prog = [0x3E, 0x01, 0xCD, 0xEA, 0x00, 0x3E, 0x00, 0xCD, 0xED, 0x00, 0x3E, 0xFF, 0xCD, 0xED, 0x00,
        0x3E, 0x55, 0xCD, 0xED, 0x00, 0xCD, 0xF0, 0x00, 0x18, 0xFE];
      prog.forEach((b, i) => m.memory.writeByte(0xC000 + i, b));
      m.cpu.pc = 0xC000;
      m.cpu.sp = 0xF000;
      const runs: number[] = [];
      let level = (m.ppi.readC() >> 5) & 1;
      let last = m.cpu.tStates;
      const out = m.cpu.portOut;
      m.cpu.portOut = (p, v) => {
        out(p, v);
        const b = (m.ppi.readC() >> 5) & 1;
        if (b !== level) { runs.push(m.cpu.tStates - last); last = m.cpu.tStates; level = b; }
      };
      for (let i = 0; i < 20_000_000 && m.cpu.pc !== 0xC000 + prog.length - 2; i++) m.cpu.step();
      // runs[0] is the motor-start silence; then the header's half-cycles.
      let header = 0;
      while (runs[1 + header] < 1000) header++;
      const bios = runs.slice(1 + header);

      const cas = Uint8Array.from([...CAS_HEADER, 0xD0, 0xD0, 0xD0, 0xD0, 0xD0, 0xD0, 0xD0, 0xD0, 0xD0, 0xD0,
        0x41, 0x42, 0x43, 0x20, 0x20, 0x20, ...CAS_HEADER, 0x00, 0xFF, 0x55]);
      const blocks = casToPulseBlocks(cas) as CswBlock[];
      const scale = 3_579_545 / TAPE_REF_HZ;
      const synth = Array.from(blocks[1].pulses, t => t * scale);
      const synthHeader = synth.slice(1).findIndex(t => t > 1000);
      // The BIOS's long header (the short one is a quarter of it) …
      expect(Math.round(header / 2)).toBe(15360);
      // … and its data bits: the same sequence of 2400 Hz and 1200 Hz half
      // cycles, run for run, at the same lengths (medians within 2%: the
      // BIOS's own loop stretches a few half-cycles around byte boundaries).
      const data = synth.slice(1 + synthHeader);
      expect(data.length).toBe(bios.length);
      const long = (t: number) => t > 1100;
      expect(data.map(long)).toEqual(bios.map(long));
      const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
      for (const want of [false, true]) {
        const b = median(bios.filter(t => long(t) === want));
        const d = median(data.filter(t => long(t) === want));
        expect(Math.abs(d - b) / b).toBeLessThan(0.02);
      }
    } finally { m.destroy(); }
  });
});
