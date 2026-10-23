/**
 * Interrupt and display-list events in the beam log (docs/beam-debug-mcp-spec.md
 * section 2): interrupt entries and ends paired by stack depth, what raised
 * them on the Atari, the display-list fetches and pointer writes, per-line DMA
 * and the renderer's HSCROL decisions.
 */

import { describe, it, expect } from 'vitest';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { ATARI_OS_SIZE } from '@/machines/atari/models.ts';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import {
  BeamLog, BEAM_DL, BEAM_DMA, BEAM_EFF, BEAM_IRQ, DL_FETCH, DL_VISIBLE, type BeamEntry,
} from '@/debug/beam-log.ts';
import { atariIrqType, describeDlInstruction, interruptStats } from '../mcp/beam.ts';

/** An OS running `program` at $E000, with the NMI vector at $E100 holding `nmi`. */
function bootAtari(program: number[], nmi: number[] = [0x40]): AtariMachine {
  const rom = new Uint8Array(ATARI_OS_SIZE);
  rom.set(program, 0x800);
  rom.set(nmi, 0x900);
  rom[0x27fa] = 0x00; rom[0x27fb] = 0xe1;
  rom[0x27fc] = 0x00; rom[0x27fd] = 0xe0;
  const m = new AtariMachine('atari800', null, 'pal');
  m.services.roms.installSystemRom(rom);
  m.reset();
  return m;
}

function entries(log: BeamLog, kind: number): BeamEntry[] {
  const out: BeamEntry[] = [];
  for (let i = 0; i < log.length; i++) if (log.get(i).kind === kind) out.push(log.get(i));
  return out;
}

/** $E000: LDA #$40 ; STA NMIEN ; loop: JMP loop */
const ENABLE_VBI = [0xa9, 0x40, 0x8d, 0x0e, 0xd4, 0x4c, 0x05, 0xe0];
/** The NMI handler: INC $80 ; RTI. */
const VBI_HANDLER = [0xe6, 0x80, 0x40];

describe('Atari interrupt log', () => {
  it('logs a VBI with its type, where it starts and ends, and what it cost', () => {
    const m = bootAtari(ENABLE_VBI, VBI_HANDLER);
    try {
      m.beamLog = new BeamLog();
      m.interruptLogging = true;
      for (let i = 0; i < 3; i++) m.tick();
      const irq = entries(m.beamLog, BEAM_IRQ);
      expect(irq.length).toBe(6);
      const [enter, end] = irq;
      expect(enter.flags & 1).toBe(1);                 // an NMI
      expect(enter.flags & 2).toBe(0);                 // an entry
      expect(enter.flags >> 8).toBe(0);                // depth 0
      expect(atariIrqType(true, enter.value)).toBe('VBI');
      expect(enter.addr).toBe(0xE100);                 // the handler
      expect(Math.floor(enter.t / 114)).toBe(248);     // the vertical-blank line
      expect(end.flags & 2).toBe(2);                   // an end
      expect(end.pc).toBe(0xE005);                     // back in the main loop
      // INC zp (5) + RTI (6), plus a few DMA cycles the core spreads over the line.
      expect(end.value).toBeGreaterThanOrEqual(11);
      expect(end.value).toBeLessThanOrEqual(15);
      expect(end.regLo).toBe(enter.frame);             // the end remembers its entry
      expect(end.regHi).toBe(enter.t);
    } finally { m.destroy(); }
  });

  it('logs nothing while interrupt logging is off', () => {
    const m = bootAtari(ENABLE_VBI, VBI_HANDLER);
    try {
      m.beamLog = new BeamLog();
      m.tick(); m.tick();
      expect(m.beamLog.length).toBe(0);
    } finally { m.destroy(); }
  });

  it('shows a nested interrupt at depth 1 and ends it before the outer one', () => {
    // The handler is 40 NOPs then RTI; a second NMI is raised inside it.
    const handler = [...new Array(40).fill(0xea), 0x40];
    const m = bootAtari(ENABLE_VBI, handler);
    try {
      m.beamLog = new BeamLog();
      m.interruptLogging = true;
      let fired = false;
      m.onTrap = (pc) => {
        if (!fired && pc === 0xE110) { fired = true; m.cpu.nmi(); }
        return false;
      };
      m.tick();
      const irq = entries(m.beamLog, BEAM_IRQ).map(e => `${(e.flags & 2) ? 'end' : 'enter'}${e.flags >> 8}`);
      expect(irq).toEqual(['enter0', 'enter1', 'end1', 'end0']);
    } finally { m.destroy(); }
  });

  it('interruptStats reports the count, the line and the cost per type', () => {
    const m = bootAtari(ENABLE_VBI, VBI_HANDLER);
    try {
      m.beamLog = new BeamLog();
      m.interruptLogging = true;
      for (let i = 0; i < 5; i++) m.tick();
      const text = interruptStats(m, m.beamLog);
      expect(text).toMatch(/NMI VBI\s+n=\s*5\s+start line min\/avg\/max 248\.0\/248\.0\/248\.0/);
    } finally { m.destroy(); }
  });
});

describe('Atari display-list log', () => {
  /** A display list at $0600: three blank-8s, a mode-2 line from $4000, JVB. */
  function withDisplayList(m: AtariMachine): void {
    const dl = [0x70, 0x70, 0x70, 0x42, 0x00, 0x40, 0x41, 0x00, 0x06];
    dl.forEach((b, i) => { m.memory.ram[0x0600 + i] = b; });
    m.antic.writeReg(0xD402, 0x00);
    m.antic.writeReg(0xD403, 0x06);
    m.antic.writeReg(0xD400, 0x22);
  }

  it('logs every display-list instruction ANTIC fetches', () => {
    const m = bootAtari([0x4c, 0x00, 0xe0]);
    try {
      withDisplayList(m);
      m.beamLog = new BeamLog();
      m.dlLogging = true;
      m.tick();
      const dl = entries(m.beamLog, BEAM_DL).filter(e => (e.flags & DL_FETCH) !== 0);
      const words = dl.slice(0, 5).map(e => `${Math.floor(e.t / 114)} ${e.pc.toString(16)} ${describeDlInstruction(e.value, e.addr)}`);
      expect(words).toEqual([
        '8 600 blank 8', '16 601 blank 8', '24 602 blank 8',
        '32 603 mode 2 LMS 4000', '40 606 JVB 0600',
      ]);
    } finally { m.destroy(); }
  });

  it('flags a pointer write that lands while ANTIC draws the picture', () => {
    // STA WSYNC ; STA DLISTL ; JMP: one write per line, every line of the frame.
    const m = bootAtari([0x8d, 0x0a, 0xd4, 0x8d, 0x02, 0xd4, 0x4c, 0x00, 0xe0]);
    try {
      m.beamLog = new BeamLog();
      m.dlLogging = true;
      m.tick();
      const writes = entries(m.beamLog, BEAM_DL).filter(e => (e.flags & DL_FETCH) === 0);
      expect(writes.length).toBeGreaterThan(250);
      for (const w of writes) {
        const line = Math.floor(w.t / 114);
        const visible = line >= 8 && line < 248;
        expect((w.flags & DL_VISIBLE) !== 0).toBe(visible);
        expect(w.addr).toBe(0xD402);
        expect(w.pc).toBe(0xE003);
      }
    } finally { m.destroy(); }
  });

  it('logs the DMA steal of every line, with what it is made of', () => {
    const m = bootAtari([0x4c, 0x00, 0xe0]);
    try {
      withDisplayList(m);
      m.beamLog = new BeamLog();
      m.dmaLogging = true;
      m.tick();
      const dma = entries(m.beamLog, BEAM_DMA);
      expect(dma.length).toBe(312);
      expect(dma.every(e => e.regHi === 9)).toBe(true);        // refresh, every line
      expect(dma.every(e => e.value >= 9)).toBe(true);
      // Line 32 is the mode-2 line's first scanline: 40 screen bytes and 40 glyph bytes.
      const l32 = dma[32];
      expect((l32.regLo >>> 8) & 0xFF).toBe(40);
      expect((l32.regLo >>> 16) & 0xFF).toBe(40);
    } finally { m.destroy(); }
  });
});

describe('Atari HSCROL decisions', () => {
  /** A scrolling display: LMS mode-2 line then mode-2 lines, all with HSCROL on. */
  function withScrollingList(m: AtariMachine): void {
    const dl = [0x52, 0x00, 0x40];
    for (let i = 0; i < 29; i++) dl.push(0x12);
    dl.push(0x41, 0x00, 0x06);
    dl.forEach((b, i) => { m.memory.ram[0x0600 + i] = b; });
    m.antic.writeReg(0xD402, 0x00);
    m.antic.writeReg(0xD403, 0x06);
    m.antic.writeReg(0xD400, 0x22);
  }

  it('reports the value used, the write that supplied it, and a write that came too late', () => {
    // LDX #0 ; loop: STA WSYNC ; NOP x6 ; STX HSCROL ; INX ; JMP loop
    // The write lands about 15 cycles into the line: after the cutoff of 10.
    const late = bootAtari([0xa2, 0x00, 0x8d, 0x0a, 0xd4, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea,
      0x8e, 0x04, 0xd4, 0xe8, 0x4c, 0x02, 0xe0]);
    // The same with the write straight after the WSYNC: cycle 3.
    const early = bootAtari([0xa2, 0x00, 0x8d, 0x0a, 0xd4, 0x8e, 0x04, 0xd4, 0xe8, 0x4c, 0x02, 0xe0]);
    try {
      for (const m of [late, early]) {
        withScrollingList(m);
        m.beamLog = new BeamLog();
        m.effLogging = true;
        m.tick(); m.tick();
        m.beamLog.clear();
        m.tick();
      }
      const e1 = entries(early.beamLog!, BEAM_EFF);
      expect(e1.length).toBeGreaterThan(200);
      // X counts up one a line; the write at cycle 3 of line N is X = N-ish and counts for line N.
      const row = e1[40];
      expect(row.flags & 1).toBe(1);                    // a write supplied it
      expect(row.regLo & 0xFFFF).toBeLessThanOrEqual(10);
      expect(row.regLo >>> 16).toBe(10);                // the cutoff
      expect(row.flags >> 8).toBe(0);                   // nothing late
      // Every line's value is the one written on it: lines are consecutive, values step by one (mod 16).
      for (let i = 1; i < 200; i++) {
        expect((e1[i].value - e1[i - 1].value) & 0x0F).toBe(1);
      }

      const e2 = entries(late.beamLog!, BEAM_EFF);
      expect(e2.length).toBeGreaterThan(200);
      const lateRow = e2[40];
      expect(lateRow.flags & 1).toBe(0);                // nothing in time: carried over
      expect(lateRow.flags >> 8).toBe(1);               // one write too late
      expect(lateRow.regHi >>> 8).toBeGreaterThan(10);  // and its cycle is past the cutoff
      // With every write late, each line carries the value written on the line before.
      for (let i = 1; i < 200; i++) {
        expect((e2[i].value - e2[i - 1].value) & 0x0F).toBe(1);
      }
    } finally { late.destroy(); early.destroy(); }
  });
});

describe('Spectrum interrupt log', () => {
  it('pairs an interrupt with its end by stack depth even though the handler ends in EI; RET', () => {
    const s = new Spectrum('zx48k', null);
    const rom = new Uint8Array(16384);
    rom[0x38] = 0xFB;   // EI
    rom[0x39] = 0xC9;   // RET
    s.loadROM(rom);
    try {
      s.cpu.im = 1;
      s.cpu.iff1 = true;
      s.cpu.iff2 = true;
      s.cpu.pc = 0x8000;      // RAM full of NOPs
      s.beamLog = new BeamLog();
      s.interruptLogging = true;
      for (let i = 0; i < 3; i++) s.tick();
      const irq = entries(s.beamLog, BEAM_IRQ);
      expect(irq.length).toBeGreaterThanOrEqual(4);
      const enter = irq[0];
      const end = irq[1];
      expect(enter.flags & 3).toBe(0);                  // a maskable entry
      expect(enter.addr).toBe(0x0038);                  // IM 1 handler
      expect(enter.t).toBeLessThan(40);                 // just after the frame interrupt
      expect(end.flags & 2).toBe(2);
      expect(end.value).toBe(14);                       // EI (4) + RET (10)
      expect(end.regHi).toBe(enter.t);
    } finally { s.destroy(); }
  });
});
