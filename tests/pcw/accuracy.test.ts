/**
 * PCW hardware limits and options: the 50/60Hz link, drive mechanisms and the
 * printer controller log.
 *
 * Expectations come from the documentation, not the implementation:
 *  - Amstrad's "Joyce" software interface specification (issue 9): the 60Hz
 *    frame shows 200 of the 256 lines, status b4 is the 50/60Hz option, the
 *    timer ticks every 52 lines, flyback lasts 26 lines and ends 16 before the
 *    first displayed line.
 *  - John Elliott's PCW hardware guide §6.1.2: the dot-matrix controller's
 *    command formats (pass commands A8-AB, print words, C0 00 terminator).
 */

import { describe, expect, it } from 'vitest';
import { PcwMachine } from '@/machines/pcw/pcw-machine.ts';
import type { PcwModel } from '@/machines/pcw/models.ts';
import type { SettingsView } from '@/machines/machine.ts';
import type { DskImage, DskSector, DskTrack } from '@/media/floppy/disk-image.ts';

const view = (values: Record<string, unknown>): SettingsView => ({
  get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; },
});

function machine(model: PcwModel, values: Record<string, unknown> = {}): PcwMachine {
  const m = new PcwMachine(model, null);
  m.start = async () => {};
  m.prepare(view(values));
  m.reset();
  return m;
}

const LINE_T = 218;

// ── 50/60Hz link ─────────────────────────────────────────────────────────────

describe('PCW 50/60Hz link', () => {
  /** Run one frame of NOPs and note which lines show flyback through port &F8
   *  and on which the timer pulse rises. */
  function observe(m: PcwMachine): { flyback: number[]; ticks: number[] } {
    m.cpu.iff1 = m.cpu.iff2 = false;
    const flyback: number[] = [];
    const ticks: number[] = [];
    let pulse = false;
    m.onTrap = () => {
      const line = m.asic.line;
      if (m.cpu.portIn(0xF8) & 0x40 && flyback[flyback.length - 1] !== line) flyback.push(line);
      if (m.asic.timerPending && !pulse) ticks.push(line);
      pulse = m.asic.timerPending;
      return false;
    };
    m.tick();
    m.onTrap = null;
    return { flyback, ticks };
  }

  it('is a 312-line 50Hz field by default, with status b4 set', () => {
    const m = machine('pcw8256');
    try {
      expect(m.tStatesPerFrame).toBe(312 * LINE_T);
      expect(m.cpu.portIn(0xF8) & 0x10).toBe(0x10);
      const { flyback, ticks } = observe(m);
      expect(flyback[0]).toBe(270);
      expect(flyback.length).toBe(26);
      expect(flyback[25]).toBe(295);
      expect(ticks).toEqual([12, 64, 116, 168, 220, 272]);
    } finally { m.destroy(); }
  });

  it('is a 260-line 60Hz field with status b4 clear when the link is fitted', () => {
    const m = machine('pcw8256', { 'pcw-60hz': true });
    try {
      expect(m.tStatesPerFrame).toBe(260 * LINE_T);
      expect(m.beamInfo().linesPerFrame).toBe(260);
      expect(m.cpu.portIn(0xF8) & 0x10).toBe(0);
      expect(m.cpu.portIn(0xF4) & 0x10).toBe(0);
      const { flyback, ticks } = observe(m);
      expect(flyback[0]).toBe(218);
      expect(flyback.length).toBe(26);
      // The timer period is 52 lines at both rates, five ticks to the field.
      expect(ticks).toEqual([12, 64, 116, 168, 220]);
    } finally { m.destroy(); }
  });

  it('runs frames of the right length', () => {
    const m = machine('pcw8256', { 'pcw-60hz': true });
    try {
      m.cpu.iff1 = m.cpu.iff2 = false;
      const t0 = m.cpu.tStates;
      m.tick();
      m.tick();
      // Two 260-line fields, give or take the last instruction's overshoot.
      expect(m.cpu.tStates - t0).toBeGreaterThanOrEqual(2 * 260 * LINE_T);
      expect(m.cpu.tStates - t0).toBeLessThan(2 * 260 * LINE_T + 24);
    } finally { m.destroy(); }
  });
});

// ── Drive mechanisms ─────────────────────────────────────────────────────────

/** A double-sided disc with one cylinder: side 0's sector 1 has ID H=0, side
 *  1's has H=1, as a 720K PCW disc does. */
function doubleSidedDisc(): DskImage {
  const side = (h: number): DskTrack => {
    const data = new Uint8Array(512).fill(0x10 + h);
    const sector: DskSector = { c: 0, h, r: 1, n: 2, st1: 0, st2: 0, data };
    return { sectors: [sector], sectorMap: new Map([[1, 0]]), gap3: 82, filler: 0xE5 };
  };
  return {
    format: 'standard', numTracks: 1, numSides: 2,
    tracks: [[side(0), side(1)]], diskFormat: 'PCW', protection: '',
  };
}

/** Send a command to drive `unit`'s FDC and read its result phase. */
function fdcCommand(m: PcwMachine, bytes: number[], resultLen: number): number[] {
  for (const b of bytes) m.fdc.writeData(b);
  const out: number[] = [];
  for (let i = 0; i < resultLen; i++) out.push(m.fdc.readData());
  return out;
}

describe('PCW drive mechanisms', () => {
  /** READ ID on head `head` of drive A: the H the controller found. */
  function readIdHead(m: PcwMachine, head: number): { st0: number; h: number } {
    m.fdc.writeData(0x07); m.fdc.writeData(0x00);             // RECALIBRATE unit 0
    m.fdc.writeData(0x08); m.fdc.readData(); m.fdc.readData(); // SENSE INTERRUPT
    const r = fdcCommand(m, [0x4A, (head << 2) | 0], 7);       // READ ID (MFM)
    return { st0: r[0], h: r[4] };
  }

  it.each([
    ['pcw8256', false], ['pcw8512', false], ['pcw9512', true], ['pcw9256', true],
  ] as const)('%s drive A: double-sided = %s', (model, doubleSided) => {
    const m = machine(model);
    try {
      m.services.disks.insert('a', doubleSidedDisc(), 'ds.dsk');
      // READ ID on head 1: a second head finds side 1's IDs; a one-headed
      // mechanism has nothing on the head-select line and shows side 0 again.
      expect(readIdHead(m, 1).h).toBe(doubleSided ? 1 : 0);
      expect(readIdHead(m, 0).h).toBe(0);
    } finally { m.destroy(); }
  });

  it('fails a side-1 sector read on a single-sided drive, as the FDC would see it', () => {
    const m = machine('pcw8256');
    try {
      m.services.disks.insert('a', doubleSidedDisc(), 'ds.dsk');
      m.fdc.writeData(0x07); m.fdc.writeData(0x00);
      m.fdc.writeData(0x08); m.fdc.readData(); m.fdc.readData();
      // READ DATA, HD=1, C0 H1 R1 N2 EOT1: side 0's only sector has H=0, so
      // no sector with ID H=1 is found: IC=01 (abnormal end) and ST1 b2, No Data.
      m.fdc.writeData(0x46); m.fdc.writeData(0x04);
      for (const v of [0, 1, 1, 2, 1, 0x2A, 0xFF]) m.fdc.writeData(v);
      const result: number[] = [];
      for (let i = 0; i < 7; i++) result.push(m.fdc.readData());
      expect(result[0] & 0xC0).toBe(0x40);
      expect(result[1] & 0x04).toBe(0x04);
    } finally { m.destroy(); }
  });

  it('reads side 1 on a double-sided drive', () => {
    const m = machine('pcw9512');
    try {
      m.services.disks.insert('a', doubleSidedDisc(), 'ds.dsk');
      m.fdc.writeData(0x07); m.fdc.writeData(0x00);
      m.fdc.writeData(0x08); m.fdc.readData(); m.fdc.readData();
      m.fdc.writeData(0x46); m.fdc.writeData(0x04);
      for (const v of [0, 1, 1, 2, 1, 0x2A, 0xFF]) m.fdc.writeData(v);
      const data: number[] = [];
      for (let i = 0; i < 512; i++) data.push(m.fdc.readData());
      expect(data.every(b => b === 0x11)).toBe(true);   // side 1's fill byte
    } finally { m.destroy(); }
  });

  it('makes drive B, the 8512 only, double-sided', () => {
    const m = machine('pcw8512');
    try {
      expect(m.fdc.singleSided).toEqual([true, false]);
      expect(machine('pcw9512').fdc.singleSided[0]).toBe(false);
    } finally { m.destroy(); }
  });

  it('tells the user when a double-sided disc goes in a single-sided drive', () => {
    const m = machine('pcw8256');
    try {
      let status = '';
      m.attachHost({ setStatus: (s: string) => { status = s; }, persistMedia() {} } as never);
      m.services.disks.insert('a', doubleSidedDisc(), 'ds.dsk');
      expect(status).toMatch(/single-sided/);
    } finally { m.destroy(); }
  });
});

// ── Printer controller ───────────────────────────────────────────────────────

function out(m: PcwMachine, port: number, ...bytes: number[]): void {
  for (const b of bytes) m.cpu.portOut(port, b);
}

describe('PCW printer controller log', () => {
  it('has nothing to export until something is sent', () => {
    const m = machine('pcw8256');
    try {
      expect(m.printerExportBytes()).toBeNull();
      expect(m.services.debug.printerExport?.()).toBeNull();
    } finally { m.destroy(); }
  });

  it('decodes the documented initialisation and reset commands', () => {
    const m = machine('pcw8256');
    try {
      out(m, 0xFC, 0x00, 0x00);                  // first initialisation command
      out(m, 0xFD, 0xA4, 0x01);                  // line feed 1/360"
      out(m, 0xFD, 0xB8, 0x00);                  // reset: head to left margin
      out(m, 0xFC, 0xC0, 0x00, 0xB8, 0x00);      // reset sequence
      const exported = m.printerExportBytes()!;
      expect(exported.filename).toBe('printer.txt');
      const text = new TextDecoder().decode(exported.data);
      expect(text).toContain('&FC 00 00  initialise');
      expect(text).toContain('&FD A4 01  line feed 1/360"');
      expect(text).toContain('&FD B8 00  reset: head to the left margin');
      expect(text).toContain('&FC C0 00  end of command');
    } finally { m.destroy(); }
  });

  it('draws a print pass as the pins it fired', () => {
    // A9 3D: print pass, head moving right at full speed, 61 ticks in. Each
    // column word is big-endian: b11-9 spacing code (7 = 12 ticks), b8-0 pins,
    // b0 the top pin. 0E FF fires pins 0-7 and moves 12 ticks, 0E 01 fires the
    // top pin alone; C0 00 ends the pass. Cells are 6 ticks wide, so the second
    // column sits two cells right of the first.
    const m = machine('pcw8256');
    try {
      out(m, 0xFD, 0xA9, 0x3D, 0x0E, 0xFF, 0x0E, 0x01, 0xC0, 0x00);
      const text = new TextDecoder().decode(m.printerExportBytes()!.data);
      expect(text).toContain('&FD A9 3D  print pass: head moving right at full speed, 61 ticks in; 2 columns fired');
      const rows = text.split('\n').filter(l => l.startsWith('  |'));
      expect(rows).toEqual([
        '  |# #',     // top pin: both columns
        '  |#', '  |#', '  |#', '  |#', '  |#', '  |#', '  |#',
        '  |',        // bottom pin (b8) fired by neither
      ]);
    } finally { m.destroy(); }
  });

  it('reads a left-moving pass left to right on the page', () => {
    const m = machine('pcw8256');
    try {
      // Head running left (A8): the first word printed is the rightmost.
      out(m, 0xFD, 0xA8, 0x10, 0x0E, 0x01, 0x0E, 0x02, 0xC0, 0x00);
      const rows = new TextDecoder().decode(m.printerExportBytes()!.data)
        .split('\n').filter(l => l.startsWith('  |'));
      expect(rows[0]).toBe('  |  #');   // pin 0 fired first, so it is on the right
      expect(rows[1]).toBe('  |#');     // pin 1 fired second, 12 ticks to the left
    } finally { m.destroy(); }
  });

  it('ends a pass the next command interrupts, as the initialisation sequence does', () => {
    // The guide's init sequence: 00,00 A4,01 A9,C0 B8,00 — the A9 pass is never
    // given its C0 00, and B8 00 must still decode as the reset.
    const m = machine('pcw8256');
    try {
      out(m, 0xFD, 0x00, 0x00, 0xA4, 0x01, 0xA9, 0xC0, 0xB8, 0x00);
      const text = new TextDecoder().decode(m.printerExportBytes()!.data);
      expect(text).toContain('&FD A9 C0  print pass: head moving right at full speed, 192 ticks in; 0 columns fired');
      expect(text).toContain('(ended by the next command');
      expect(text).toContain('&FD B8 00  reset: head to the left margin');
      expect(text).not.toContain('unknown');
    } finally { m.destroy(); }
  });

  it('adds up head moves inside a pass (80-9F words)', () => {
    const m = machine('pcw8256');
    try {
      // 0E 01 (12 ticks), then a move of 0x8001 = 1 tick... use 0x80 0x0C = 12
      // ticks, then another column: 24 ticks from the first = 4 cells.
      out(m, 0xFD, 0xA9, 0x00, 0x0E, 0x01, 0x80, 0x0C, 0x0E, 0x01, 0xC0, 0x00);
      const rows = new TextDecoder().decode(m.printerExportBytes()!.data)
        .split('\n').filter(l => l.startsWith('  |'));
      expect(rows[0]).toBe('  |#   #');
    } finally { m.destroy(); }
  });

  it('decodes a long line feed with its continuation word', () => {
    const m = machine('pcw8256');
    try {
      // "AC,30 92,00 C0,00": feed 0x30 = 48 plus a continuation of 0x1200 =
      // bits 12-0 with the low byte zero adding 256 -> 0x1200 + 256.
      out(m, 0xFD, 0xAC, 0x30, 0x92, 0x00, 0xC0, 0x00);
      const text = new TextDecoder().decode(m.printerExportBytes()!.data);
      expect(text).toMatch(/AC 30  line feed 4912\/360"/);
    } finally { m.destroy(); }
  });

  it('decodes the 9512 daisywheel controller from its three addresses', () => {
    const m = machine('pcw9512');
    try {
      m.cpu.portOut(0x01FC, 0x01); m.cpu.portOut(0x00FC, 0x03);   // prepare, single-strike
      m.cpu.portOut(0x01FC, 0x45); m.cpu.portOut(0x00FC, 0x2A);   // print petal 0x2A, impression 2
      m.cpu.portOut(0x01FC, 0xB0); m.cpu.portOut(0x00FC, 0x0C);   // move right 12/120"
      const text = new TextDecoder().decode(m.printerExportBytes()!.data);
      expect(text).toContain('01 03  prepare to output a character (ribbon single-strike)');
      expect(text).toContain('45 2A  print petal 42 (impression 2)');
      expect(text).toContain('B0 0C  move right 12/120"');
    } finally { m.destroy(); }
  });

  it('still reports the printer ready and idle (the BIOS handshake must not hang)', () => {
    const m = machine('pcw8256');
    try {
      expect(m.cpu.portIn(0xFD) & 0x41).toBe(0x40);   // b6 finished, b0 no fault
      expect(m.cpu.portIn(0xFC)).toBe(0xF8);          // normal operation
    } finally { m.destroy(); }
  });
});
