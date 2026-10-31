/**
 * The Apple II's floating bus: a read that nothing drives returns the byte the
 * video scanner fetched on that cycle (Sather, "Understanding the Apple II" ch.
 * 5 and "Understanding the Apple IIe" ch. 5 and 8).
 *
 * The scanner is checked against addresses worked out by hand from the memory
 * layout: 40 columns of a row start 0/40/80 bytes into a 128-byte segment of
 * the text page ($400 + 128 × row-in-group), the 25 blanking cycles read the 24
 * bytes below the row's first one (wrapping inside the segment) with the first
 * cycle repeated, and the 70 vertical blanking lines read from 8 bytes below the
 * segment's start. Then 6502 code reads an empty slot's ROM page ($C100) on
 * planned cycles and the values are compared with those addresses. No ROM is
 * needed.
 */

import { describe, it, expect } from 'vitest';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';
import { scannerAddress } from '@/machines/apple2/apple2-scanner.ts';
import type { Apple2Model } from '@/machines/apple2/models.ts';

const LINE = 65;
const at = (line: number, c: number): number => line * LINE + c;

describe('video scanner addresses (worked out by hand)', () => {
  // text, mixed, hires, page2, iie
  const text = (line: number, c: number, iie = false, page2 = false): number =>
    scannerAddress(at(line, c), true, false, false, page2, iie);
  const hires = (line: number, c: number, mixed = false, iie = false, page2 = false): number =>
    scannerAddress(at(line, c), false, mixed, true, page2, iie);

  it('text: the 40 columns of each row, three rows to a 128-byte segment', () => {
    expect(text(0, 25)).toBe(0x400);          // row 0, column 0
    expect(text(0, 64)).toBe(0x427);          // column 39
    expect(text(7, 30)).toBe(0x405);          // still row 0 (eight lines to a row)
    expect(text(8, 25)).toBe(0x480);          // row 1 starts 128 bytes on
    expect(text(64, 25)).toBe(0x428);         // row 8 is the second row of the first segment: +40
    expect(text(128, 25)).toBe(0x450);        // row 16: +80
    expect(text(184, 25)).toBe(0x7D0);        // row 23
    expect(text(191, 40)).toBe(0x7DF);        // column 15 of it
    expect(text(0, 25, false, true)).toBe(0x800);   // page 2
  });

  it('blanking: the 24 bytes below the row, the first cycle repeated, +$1000 on a ][', () => {
    // Row 0 wraps inside its segment: $400 - 24 = $468. The ][ and ][+ read
    // text blanking from $1000 higher.
    expect(text(0, 0)).toBe(0x1468);
    expect(text(0, 1)).toBe(0x1468);
    expect(text(0, 2)).toBe(0x1469);
    expect(text(0, 24)).toBe(0x147F);
    expect(text(64, 1)).toBe(0x1410);         // row 8 starts 40 in: 40 - 24 = 16
    expect(text(128, 1)).toBe(0x1438);        // row 16: 80 - 24 = 56
    expect(text(8, 1)).toBe(0x14E8);          // row 1: $480 + 104
    expect(text(8, 24)).toBe(0x14FF);
    // The //e has no such offset.
    expect(text(0, 0, true)).toBe(0x468);
    expect(text(0, 24, true)).toBe(0x47F);
    expect(text(64, 1, true)).toBe(0x410);
  });

  it('vertical blanking: segment rows 0-7 again, reading from 8 bytes below the start', () => {
    expect(text(192, 25, true)).toBe(0x478);  // $400 - 8, wrapped in the segment
    expect(text(192, 32, true)).toBe(0x47F);
    expect(text(192, 33, true)).toBe(0x400);  // column 8 is back at the segment start
    expect(text(192, 64, true)).toBe(0x41F);
    expect(text(200, 25, true)).toBe(0x4F8);  // the next row's segment
    expect(text(255, 25, true)).toBe(0x7F8);  // the last of the 64 lines counted on
    expect(text(256, 25, true)).toBe(0x7F8);  // the six that wrap round are in the last segment too
    expect(text(261, 40, true)).toBe(0x787);
    expect(text(192, 1)).toBe(0x1460);        // blanking in blanking: 120 - 24 = 96
  });

  it('hires: the scan line in address bits 10-12', () => {
    expect(hires(1, 25)).toBe(0x2400);
    expect(hires(8, 25)).toBe(0x2080);
    expect(hires(64, 25)).toBe(0x2028);
    expect(hires(191, 64)).toBe(0x3FF7);
    expect(hires(0, 1)).toBe(0x2068);         // hires blanking has no $1000 offset
    expect(hires(192, 25)).toBe(0x2078);
    expect(hires(256, 25)).toBe(0x2BF8);      // the wrap-round lines count scan lines from 2
    expect(hires(257, 25)).toBe(0x2FF8);      // scan line 3 of the last segment row
    expect(hires(1, 25, false, false, true)).toBe(0x4400);   // page 2
  });

  it('mixed mode: text in the last four rows, hires above', () => {
    expect(hires(159, 25, true)).toBe(0x3DD0);   // y = 159: scan 7, row 19
    expect(hires(160, 25, true)).toBe(0x650);    // row 20 is text
    expect(hires(191, 25, true)).toBe(0x7D0);    // row 23, first column
  });

  it('text mode wins over the hires switch', () => {
    expect(scannerAddress(at(1, 25), true, false, true, false, true)).toBe(0x400);
  });
});

// ── Code that reads the bus on planned cycles ──────────────────────────────

interface Read { addr?: number; line: number; c: number; indexed?: boolean }

/** A program that, starting at cycle 0, reads `addr` (default an empty slot's
 *  ROM page) so that each read falls on the given cycle of the given line, and
 *  stores the results in zero page from `$10`. An LDA absolute reads on the 4th
 *  of its 4 cycles, an LDA absolute,X that crosses a page on the 5th of 5. */
function program(reads: Read[], base: number): number[] {
  const code: number[] = [];
  let t = 0;
  const wait = (g: number): void => {
    if (g < 0) throw new Error('reads are too close together');
    while (g >= 16) {
      let n = Math.min(255, Math.floor((g - 1) / 5));
      if (g - (5 * n + 1) === 1) n--;
      // A loop that straddles a page boundary pays an extra cycle per branch.
      if (((base + code.length + 2) & 0xFF) >= 0xFD) { code.push(0xEA); t += 2; g -= 2; continue; }
      code.push(0xA2, n, 0xCA, 0xD0, 0xFD);          // LDX #n; DEX; BNE -3
      t += 5 * n + 1;
      g -= 5 * n + 1;
    }
    if (g === 1) throw new Error('cannot wait one cycle');
    if (g % 2 === 1) { code.push(0xA5, 0x00); t += 3; g -= 3; }   // LDA $00
    for (; g > 0; g -= 2) { code.push(0xEA); t += 2; }
    t += 0;
  };
  const sorted = [...reads].sort((a, b) => (at(a.line, a.c)) - at(b.line, b.c));
  sorted.forEach((r, i) => {
    const addr = r.addr ?? 0xC100;
    if (r.indexed) {
      const start = at(r.line, r.c) - 4;
      wait(start - 2 - t);
      code.push(0xA2, 0x01);                         // LDX #1
      t += 2;
      const a = (addr - 1) & 0xFFFF;
      code.push(0xBD, a & 0xFF, a >> 8);             // LDA abs,X (crosses into addr's page)
      t += 5;
    } else {
      const start = at(r.line, r.c) - 3;
      wait(start - t);
      code.push(0xAD, addr & 0xFF, addr >> 8);      // LDA abs
      t += 4;
    }
    code.push(0x85, 0x10 + i);                       // STA zp
    t += 3;
  });
  const end = base + code.length;
  code.push(0x4C, end & 0xFF, end >> 8);             // JMP *
  return code;
}

/** The byte the test fills RAM with, a different one at nearly every address. */
const pattern = (a: number): number => ((a * 37) ^ (a >> 3) ^ 0x5C) & 0xFF;

type Setup = (m: Apple2Machine) => void;

/** Run `reads` on a fresh machine and return what each read found. */
function run(model: Apple2Model, reads: Read[], setup: Setup = () => {}): number[] {
  const m = new Apple2Machine(model, null);
  try {
    const iie = model !== 'apple2' && model !== 'apple2-plus';
    const rom = new Uint8Array(iie ? 0x4000 : 0x3000);
    const code = program(reads, 0xD000);
    rom.set(code, iie ? 0x1000 : 0);
    rom[iie ? 0x3FFC : 0x2FFC] = 0x00;
    rom[iie ? 0x3FFD : 0x2FFD] = 0xD0;
    m.loadROM(rom);
    m.reset();
    for (let a = 0x200; a < 0xC000; a++) m.memory.ram[a] = pattern(a);
    setup(m);
    m.runUntil(1);
    const sorted = [...reads].sort((a, b) => at(a.line, a.c) - at(b.line, b.c));
    // Results are in time order; hand them back in the order asked.
    return reads.map(r => m.memory.ram[0x10 + sorted.indexOf(r)]);
  } finally { m.destroy(); }
}

/** `run`, with the reads split across as many runs as it takes to keep them
 *  far enough apart for the planner (seven cycles for the LDA and STA). */
function runSpread(model: Apple2Model, reads: Read[], setup: Setup = () => {}): number[] {
  const order = reads.map((r, i) => ({ r, i })).sort((a, b) => at(a.r.line, a.r.c) - at(b.r.line, b.r.c));
  const out: number[] = new Array<number>(reads.length);
  let pending = order;
  while (pending.length > 0) {
    const batch: typeof pending = [];
    const rest: typeof pending = [];
    let last = -100;
    for (const p of pending) {
      const t = at(p.r.line, p.r.c);
      if (t - last >= 12) { batch.push(p); last = t; } else rest.push(p);
    }
    const got = run(model, batch.map(b => b.r), setup);
    batch.forEach((b, k) => { out[b.i] = got[k]; });
    pending = rest;
  }
  return out;
}

describe('reads of an empty slot see the video scanner', () => {
  it('][+ text page: columns, rows, blanking and vertical blanking', () => {
    const cases: [number, number, number][] = [
      [0, 25, 0x400], [0, 64, 0x427], [8, 25, 0x480], [64, 25, 0x428], [128, 25, 0x450],
      [184, 25, 0x7D0], [191, 40, 0x7DF], [5, 30, 0x405],
      [0, 3, 0x146A], [0, 24, 0x147F], [64, 1, 0x1410], [8, 24, 0x14FF],
      [192, 25, 0x478], [192, 33, 0x400], [200, 25, 0x4F8], [255, 25, 0x7F8], [256, 25, 0x7F8],
    ];
    const got = runSpread('apple2-plus', cases.map(([line, c]) => ({ line, c })));
    expect(got.map(v => v.toString(16))).toEqual(cases.map(([, , a]) => pattern(a).toString(16)));
  });

  it('][+ hires and mixed mode', () => {
    const cases: [number, number, number][] = [
      [1, 25, 0x2400], [8, 25, 0x2080], [64, 25, 0x2028], [191, 64, 0x3FF7],
      [2, 5, 0x286C],                    // blanking cycle 5: column -20, 108 into scan line 2's segment
      [159, 25, 0x3DD0], [160, 25, 0x650],
    ];
    const got = runSpread('apple2-plus', cases.map(([line, c]) => ({ line, c })), (m) => {
      m.textMode = false; m.hires = true; m.mixed = true;
    });
    expect(got.map(v => v.toString(16))).toEqual(cases.map(([, , a]) => pattern(a).toString(16)));
  });

  it('][+ page 2 and the //e without the $1000 blanking offset', () => {
    const p2 = run('apple2-plus', [{ line: 0, c: 25 }], (m) => { m.page2 = true; });
    expect(p2[0]).toBe(pattern(0x800));
    const iie = run('apple2e', [{ line: 0, c: 3 }, { line: 0, c: 24 }, { line: 192, c: 25 }]);
    expect(iie).toEqual([pattern(0x46A), pattern(0x47F), pattern(0x478)]);
  });

  it('//e: 80STORE keeps the picture on page 1 whatever PAGE2 says', () => {
    const [page1] = run('apple2e', [{ line: 0, c: 25 }], (m) => { m.mmu.store80 = true; m.page2 = true; });
    expect(page1).toBe(pattern(0x400));
    const [page2] = run('apple2e', [{ line: 0, c: 25 }], (m) => { m.page2 = true; });
    expect(page2).toBe(pattern(0x800));
  });

  it('an indexed read that crosses a page lands one cycle later', () => {
    const [v] = run('apple2-plus', [{ line: 0, c: 30, indexed: true }]);
    expect(v).toBe(pattern(0x400 + 5));
  });

  it('the 6502 finds the beam with the classic floating-bus loop', () => {
    // Fill the text page with spaces, put one marker in the first column of the
    // last text row, and poll the bus until the marker appears: that can only
    // be on the first of that row's eight lines, 184-191, at cycle 25.
    for (const model of ['apple2-plus', 'apple2e', 'apple2e-enhanced'] as Apple2Model[]) {
      const m = new Apple2Machine(model, null);
      try {
        const iie = model !== 'apple2-plus';
        const rom = new Uint8Array(iie ? 0x4000 : 0x3000);
        const loop = [0xAD, 0x00, 0xC1, 0xC9, 0x55, 0xD0, 0xF9, 0x4C, 0x07, 0xD0];   // LDA $C100; CMP #$55; BNE; JMP *
        rom.set(loop, iie ? 0x1000 : 0);
        rom[iie ? 0x3FFC : 0x2FFC] = 0x00;
        rom[iie ? 0x3FFD : 0x2FFD] = 0xD0;
        m.loadROM(rom);
        m.reset();
        m.memory.ram.fill(0xA0, 0x400, 0x800);
        m.memory.ram[0x7D0] = 0x55;
        m.breakpoints.add(0xD007);
        m.runUntil(500);
        expect(m.cpu.pc).toBe(0xD007);
        // The loop's last pass is 8 cycles (the BNE falls through) and reads on the 4th.
        const t = (m.cpu.tStates - 5) % 17030;
        const line = Math.floor(t / LINE);
        expect(t % LINE, model).toBe(25);
        expect(line, model).toBeGreaterThanOrEqual(184);
        expect(line, model).toBeLessThanOrEqual(191);
      } finally { m.destroy(); }
    }
  });
});

describe('what drives the bus and what floats', () => {
  it('][+: switches that return nothing read the video byte, in every address of their block', () => {
    // $C010-$C01F clear the strobe, $C020-$C02F the tape, ... none drive the bus.
    // (Only switches that leave the picture and the ROM alone: it is read in text
    // mode from the ROM at $D000.)
    const addrs = [0xC010, 0xC019, 0xC02F, 0xC030, 0xC040, 0xC051, 0xC054, 0xC056, 0xC058, 0xC05F,
      0xC070, 0xC07F, 0xC082, 0xC100, 0xC7FF, 0xC800];
    const reads = addrs.map((addr, i) => ({ addr, line: 20 + 3 * i, c: 25 + 2 * i }));
    const got = run('apple2-plus', reads);
    // Rows are 8 lines; three to a 128-byte segment: row r starts at 128·(r mod 8) + 40·(r div 8).
    const rowAddr = (r: number): number => 0x400 + (r & 7) * 0x80 + (r >> 3) * 40;
    const want = reads.map(r => pattern(rowAddr(r.line >> 3) + (r.c - 25)));
    expect(got).toEqual(want);
  });

  it('][+: the keyboard answers all of $C000-$C00F', () => {
    const m = new Apple2Machine('apple2-plus', null);
    try {
      m.keyboard.handleEvent({ code: 'KeyA', key: 'a', shift: false, ctrl: false, alt: false }, true);
      for (let a = 0xC000; a <= 0xC00F; a++) expect(m.memory.readByte(a), a.toString(16)).toBe(0xC1);
      m.memory.readByte(0xC01B);                         // any $C01x clears the strobe
      expect(m.memory.readByte(0xC003)).toBe(0x41);
    } finally { m.destroy(); }
  });

  it('][+: the 74LS251 drives bit 7 of $C060-$C067 only', () => {
    const m = new Apple2Machine('apple2-plus', null);
    try {
      m.paddles.setButton(0, true);
      m.memory.ram.fill(0x2A);                           // scanner byte everywhere
      expect(m.memory.readByte(0xC061)).toBe(0xAA);       // button down: 1 | $2A
      m.paddles.setButton(0, false);
      expect(m.memory.readByte(0xC061)).toBe(0x2A);       // up: 0 | $2A
    } finally { m.destroy(); }
  });

  it('Disk II: the data register answers even addresses, odd ones float', () => {
    const [odd, even] = run('apple2-plus', [{ addr: 0xC0E1, line: 20, c: 30 }, { addr: 0xC0EC, line: 21, c: 30 }]);
    expect(odd).toBe(pattern(0x400 + 0x100 + 5));          // row 2, column 5
    expect(even).toBe(0x00);                                // the idle data register
    // Odd addresses still act: C0E1 is "phase 0 on".
    const m = new Apple2Machine('apple2-plus', null);
    try {
      m.memory.readByte(0xC0EB);                           // select drive 2
      expect(m.disk2.currentDriveIndex).toBe(1);
    } finally { m.destroy(); }
  });

  it('//e: $C011-$C01F carry the last key code with the status in bit 7', () => {
    const m = new Apple2Machine('apple2e', null);
    try {
      // CAPS LOCK is down at power-on, so the key is the capital 'A', $41.
      m.keyboard.handleEvent({ code: 'KeyA', key: 'a', shift: false, ctrl: false, alt: false }, true);
      expect(m.memory.readByte(0xC01A)).toBe(0x80 | 0x41);     // TEXT is on at power-up
      expect(m.memory.readByte(0xC01B)).toBe(0x41);            // MIXED off
      expect(m.memory.readByte(0xC010)).toBe(0x80 | 0x41);     // the key is still down
      m.keyboard.handleEvent({ code: 'KeyA', key: 'a', shift: false, ctrl: false, alt: false }, false);
      expect(m.memory.readByte(0xC010)).toBe(0x41);            // released: bit 7 clear, code remains
    } finally { m.destroy(); }
  });

  it('//e: RDVBLBAR changes on the exact cycle the beam reaches line 192', () => {
    // LDA $C019 reads on its 4th cycle. A read on the last cycle of line 191
    // sees the beam drawing and one on the next cycle, the first of line 192,
    // sees vertical blanking; going by the cycle the instruction started on would
    // put the second one (and the three cycles before it) in line 191.
    const [lastDrawn] = run('apple2e', [{ addr: 0xC019, line: 191, c: 64 }]);
    const [firstBlank] = run('apple2e', [{ addr: 0xC019, line: 192, c: 0 }]);
    const [lastBlank] = run('apple2e', [{ addr: 0xC019, line: 261, c: 64 }]);
    const [top] = run('apple2e', [{ addr: 0xC019, line: 0, c: 5 }]);
    expect(lastDrawn & 0x80).toBe(0x80);
    expect(firstBlank & 0x80).toBe(0);
    expect(lastBlank & 0x80).toBe(0);
    expect(top & 0x80).toBe(0x80);
  });

  it('][+ has no vertical-blanking flag: $C019 is just the floating bus', () => {
    const [v] = run('apple2-plus', [{ addr: 0xC019, line: 200, c: 30 }]);
    // Line 200 is the second segment row of the blanking lines (row 57), 120 bytes in; column 5.
    expect(v).toBe(pattern(0x400 + 0x80 + 125));
  });

  it('//e: $C07F reads DHIRES on the Enhanced //e and //c only', () => {
    for (const [model, reads] of [['apple2e', false], ['apple2e-enhanced', true], ['apple2c', true]] as [Apple2Model, boolean][]) {
      const m = new Apple2Machine(model, null);
      try {
        m.memory.readByte(0xC05E);                           // AN3 off: DHIRES on
        expect(m.memory.readByte(0xC07F) & 0x80, model).toBe(reads ? 0x80 : 0);
      } finally { m.destroy(); }
    }
  });

  it('the //e game inputs drive bit 7 and leave the rest to the bus', () => {
    const m = new Apple2Machine('apple2e', null);
    try {
      m.memory.ram.fill(0x15);
      m.paddles.setButton(0, true);
      expect(m.memory.readByte(0xC061)).toBe(0x95);
      m.paddles.setButton(0, false);
      expect(m.memory.readByte(0xC061)).toBe(0x15);
    } finally { m.destroy(); }
  });
});
