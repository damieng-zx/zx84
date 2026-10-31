/**
 * PCW gate-array tests: roller RAM decoding, the interrupt cadence, the status
 * byte and the scan-line fetch.
 *
 * The roller-RAM expectations are derived from the documented CP/M layout
 * (roller RAM at &3600 in block 2, i.e. physical &B600) rather than from the
 * code — that worked example is what pins the bit fields down at all.
 */

import { describe, expect, it } from 'vitest';
import { createPcwConfig } from '@/machines/pcw/config.ts';
import { PcwMemory } from '@/machines/pcw/pcw-memory.ts';
import {
  PcwAsic, PCW_TIMING_50HZ, PCW_TIMING_60HZ, rollerEntryAddress,
} from '@/machines/pcw/asic.ts';
import {
  PCW_BORDER_LEFT, PCW_BORDER_TOP, PCW_DISPLAY_HEIGHT,
  PCW_SCREEN_HEIGHT, PCW_SCREEN_WIDTH, PCW_STATUS_FLYBACK,
  PCW_VIDEO_ENABLE, PCW_VIDEO_REVERSE,
} from '@/machines/pcw/constants.ts';

function build(): { mem: PcwMemory; asic: PcwAsic } {
  const mem = new PcwMemory(createPcwConfig('pcw8256'));
  return { mem, asic: new PcwAsic(mem) };
}

describe('roller RAM decoding', () => {
  it('places the CP/M roller RAM at physical &B600 for port &F5 = &5B', () => {
    // Documented: the roller RAM "is located at &3600 (mapped to &B600) in
    // bank 2", and CP/M writes &5B to &F5. Block = &5B >> 5 = 2, offset =
    // (&5B & &1F) * 512 = 27 * 512 = &3600, so 2 * &4000 + &3600 = &B600.
    const { asic } = build();
    asic.rollerBase = 0x5B;
    expect(asic.rollerAddress).toBe(0xB600);
  });

  it('expands an entry into block, 16-byte unit and row offset', () => {
    // An entry of &2C98: block 1 (b15-13), unit &193 (b12-3), offset 0 (b2-0).
    // 1 * &4000 + &193 * 16 = &4000 + &1930 = &5930.
    expect(rollerEntryAddress(0x2C98)).toBe(0x5930);
    // The low three bits pass straight through as the row within the cell.
    expect(rollerEntryAddress(0x2C9B)).toBe(0x5933);
    // Top of memory: block 7 with every unit bit set stays inside 128K.
    expect(rollerEntryAddress(0xFFFF)).toBe(0x1FFF7);
  });

  it('reads its entry from RAM live, so scrolling takes effect immediately', () => {
    const { mem, asic } = build();
    asic.rollerBase = 0x5B;                 // roller RAM at &B600
    // Entry for line 3 lives at &B600 + 6.
    mem.getRamBank(2)[0x3606] = 0x98;
    mem.getRamBank(2)[0x3607] = 0x2C;
    expect(asic.lineAddress(3)).toBe(0x5930);
    // Rewrite it: the next fetch must follow the new value.
    mem.getRamBank(2)[0x3606] = 0x00;
    mem.getRamBank(2)[0x3607] = 0x20;
    expect(asic.lineAddress(3)).toBe(0x4000);
  });
});

describe('roller RAM start offset (port &F6)', () => {
  // MAME pcw_v.cpp: roller_ram_offs = offset << 1, then += 2 and &= 511 per
  // line — &F6 picks the table entry line 0 reads, wrapping in 512 bytes.
  it('starts the walk at entry &F6 and wraps within the 512-byte table', () => {
    const { mem, asic } = build();
    asic.rollerBase = 0x5B;                 // table at &B600 (bank 2, &3600)
    const bank = mem.getRamBank(2);
    const put = (entry: number, value: number): void => {
      bank[0x3600 + entry * 2] = value & 0xFF;
      bank[0x3600 + entry * 2 + 1] = value >> 8;
    };
    put(5, 0x2000);                          // → &4000
    put(255, 0x2C98);                        // → &5930
    put(0, 0x2008);                          // → &4010
    asic.rollerOffset = 5;
    expect(asic.lineAddress(0)).toBe(0x4000);        // entry 5
    asic.rollerOffset = 250;
    expect(asic.lineAddress(5)).toBe(0x5930);        // entry 255
    expect(asic.lineAddress(6)).toBe(0x4010);        // wraps to entry 0, not &B800
  });

  it('does not move the picture on the monitor', () => {
    const { mem, asic } = build();
    asic.rollerBase = 0x5B;
    const bank = mem.getRamBank(2);
    for (let e = 0; e < 256; e++) { bank[0x3600 + e * 2] = 0; bank[0x3600 + e * 2 + 1] = 0x20; }
    mem.getRamBank(1)[0] = 0xFF;             // &4000: 8 ink pixels
    asic.rollerOffset = 3;
    const buf = new Uint32Array(PCW_SCREEN_WIDTH * PCW_SCREEN_HEIGHT);
    asic.renderScanline(buf, 0);
    expect(buf[PCW_BORDER_TOP * PCW_SCREEN_WIDTH + PCW_BORDER_LEFT]).toBe(asic.ink >>> 0);
  });
});

/**
 * Frame timing from the Amstrad "Joyce" software interface specification
 * (issue 9): the timer interrupts "during every vertical ('frame') flyback and
 * every 52 scan lines thereafter", "approximately 2 scans (128 microseconds)
 * into the 26 scan (1664 microseconds) frame flyback status signal", which
 * "ends 1024 microseconds [16 lines] before the monitor starts displaying pixel
 * scans". With line 0 the first displayed line of a 312-line frame, flyback is
 * 312-16-26 = 270 to 295 and the first tick 272; 272+52 wraps to 12.
 */
describe('interrupt cadence', () => {
  /** A tick raised and counted, as the CPU's next two opcode fetches do. */
  function tick(asic: PcwAsic, line: number): void {
    asic.beginLine(line);
    asic.syncTickBefore(1);
    asic.syncTickAfter();
  }

  it('fires six times a 50Hz field, two lines into flyback and every 52 after', () => {
    const lines: number[] = [];
    for (let line = 0; line < 312; line++) {
      if (PcwAsic.isInterruptLine(line)) lines.push(line);
    }
    expect(lines).toEqual([12, 64, 116, 168, 220, 272]);
  });

  it('fires five times a 60Hz field, keeping the 52-line period across the frame', () => {
    // 260 lines: flyback 218-243, tick at 220, and 220+52 wraps to 12 again.
    const lines: number[] = [];
    for (let line = 0; line < 260; line++) {
      if (PcwAsic.isInterruptLine(line)) lines.push(line);
    }
    expect(lines).toEqual([12, 64, 116, 168, 220]);
  });

  it('counts pending interrupts and saturates at four bits', () => {
    const { asic } = build();
    for (let i = 0; i < 3; i++) tick(asic, 12);
    expect(asic.status & 0x0F).toBe(3);
    for (let i = 0; i < 40; i++) tick(asic, 12);
    expect(asic.status & 0x0F).toBe(0x0F);
  });

  it('does not raise a tick on a line between timer lines', () => {
    const { asic } = build();
    tick(asic, 13);
    tick(asic, 0);
    expect(asic.status & 0x0F).toBe(0);
  });

  it('clears the counter on a &F4 read but not on a &F8 read', () => {
    const { asic } = build();
    tick(asic, 12);
    tick(asic, 64);
    expect(asic.status & 0x0F).toBe(2);
    // &F8 leaves it alone…
    expect(asic.status & 0x0F).toBe(2);
    // …&F4 returns the same byte and then resets b3-0.
    expect(asic.readMemCtlStatus() & 0x0F).toBe(2);
    expect(asic.status & 0x0F).toBe(0);
  });

  it('pulses /INT on a timer tick until the pulse ends, leaving the count alone', () => {
    const { asic } = build();
    asic.beginLine(12);
    expect(asic.intPending).toBe(true);
    asic.endTimerPulse();
    expect(asic.intPending).toBe(false);
    asic.syncTickBefore(1);
    asic.syncTickAfter();
    expect(asic.status & 0x0F).toBe(1);
  });

  it('counts a tick only at the second opcode fetch after it', () => {
    // "The counter is synchronized by two CPU instruction fetch cycles (M1)."
    const { asic } = build();
    asic.beginLine(12);
    expect(asic.status & 0x0F).toBe(0);      // raised, not yet latched
    asic.syncTickBefore(1);
    expect(asic.status & 0x0F).toBe(0);      // latched by one M1
    asic.syncTickAfter();
    expect(asic.status & 0x0F).toBe(1);      // counted by the next
  });

  it('loses a tick latched by the M1 of the instruction that reads &F4', () => {
    // "If the M1 of a counter read command latches a new pending timer
    // interrupt, the counter will not at the time of the read operation have
    // been incremented, and therefore this new interrupt will be lost."
    const { asic } = build();
    asic.beginLine(12);
    asic.syncTickBefore(1);                  // IN A,(&F4): one M1
    expect(asic.readMemCtlStatus() & 0x0F).toBe(0);
    asic.syncTickAfter();
    expect(asic.status & 0x0F).toBe(0);
  });

  it('keeps a tick an ED-prefixed read latches, which has made both fetches first', () => {
    // IN A,(C) is ED 78: two M1s before the I/O read, so the count is in.
    const { asic } = build();
    asic.beginLine(12);
    asic.syncTickBefore(2);
    expect(asic.readMemCtlStatus() & 0x0F).toBe(1);
  });

  it('routes the FDC interrupt to /INT, /NMI or nowhere', () => {
    const { asic } = build();
    asic.fdcInt = true;
    asic.fdcRoute = 'none';
    expect(asic.intPending).toBe(false);
    expect(asic.nmiPending).toBe(false);
    asic.fdcRoute = 'int';
    expect(asic.intPending).toBe(true);
    expect(asic.nmiPending).toBe(false);
    asic.fdcRoute = 'nmi';
    expect(asic.intPending).toBe(false);
    expect(asic.nmiPending).toBe(true);
  });
});

describe('status byte', () => {
  it('reports frame flyback for exactly the 26 lines 270-295 at 50Hz', () => {
    const { asic } = build();
    const flyback: number[] = [];
    for (let line = 0; line < 312; line++) {
      asic.beginLine(line);
      if (asic.status & PCW_STATUS_FLYBACK) flyback.push(line);
    }
    expect(flyback[0]).toBe(270);
    expect(flyback.length).toBe(26);
    expect(flyback[25]).toBe(295);
  });

  it('reports frame flyback for lines 218-243 at 60Hz', () => {
    const { asic } = build();
    asic.timing = PCW_TIMING_60HZ;
    const flyback: number[] = [];
    for (let line = 0; line < 260; line++) {
      asic.beginLine(line);
      if (asic.status & PCW_STATUS_FLYBACK) flyback.push(line);
    }
    expect(flyback[0]).toBe(218);
    expect(flyback.length).toBe(26);
  });

  it('keeps flyback low through the displayed lines', () => {
    const { asic } = build();
    asic.beginLine(0);
    expect(asic.status & PCW_STATUS_FLYBACK).toBe(0);
    asic.beginLine(255);
    expect(asic.status & PCW_STATUS_FLYBACK).toBe(0);
  });

  it('sets b4 on a 50Hz machine and clears it on a 60Hz one', () => {
    // "D4 50 / /60Hz Frame Rate Option"
    const { asic } = build();
    expect(asic.timing).toBe(PCW_TIMING_50HZ);
    expect(asic.status & 0x10).toBe(0x10);
    asic.timing = PCW_TIMING_60HZ;
    expect(asic.status & 0x10).toBe(0);
  });

  it('reports the FDC interrupt in b5 whatever it is routed to', () => {
    const { asic } = build();
    asic.fdcRoute = 'none';
    asic.fdcInt = true;
    expect(asic.status & 0x20).toBe(0x20);
    expect(asic.status & 0x80).toBe(0);      // b7 undefined: reads 0
  });
});

describe('scan-line rendering', () => {
  const pixels = () => new Uint32Array(PCW_SCREEN_WIDTH * PCW_SCREEN_HEIGHT);

  /** Point line 0 at physical &4000 and put `bytes` there with stride 8. */
  function layOutLine(mem: PcwMemory, asic: PcwAsic, bytes: number[]): void {
    asic.rollerBase = 0x5B;                       // roller RAM at &B600
    mem.getRamBank(2)[0x3600] = 0x00;             // entry = &2000 → address &4000
    mem.getRamBank(2)[0x3601] = 0x20;
    bytes.forEach((b, i) => { mem.getRamBank(1)[i * 8] = b; });
  }

  it('draws bit 7 of the first byte as the leftmost pixel', () => {
    const { mem, asic } = build();
    asic.ink = 0xFFFFFFFF; asic.paper = 0xFF000000;
    layOutLine(mem, asic, [0x81]);
    const buf = pixels();
    asic.renderScanline(buf, 0);

    const row = PCW_BORDER_TOP * PCW_SCREEN_WIDTH + PCW_BORDER_LEFT;
    expect(buf[row]).toBe(0xFFFFFFFF);       // bit 7
    expect(buf[row + 1]).toBe(0xFF000000);   // bit 6
    expect(buf[row + 6]).toBe(0xFF000000);   // bit 1
    expect(buf[row + 7]).toBe(0xFFFFFFFF);   // bit 0
  });

  it('takes every eighth byte across the line', () => {
    const { mem, asic } = build();
    asic.ink = 0xFFFFFFFF; asic.paper = 0xFF000000;
    layOutLine(mem, asic, [0x00, 0xFF]);
    // A byte written between the two strided ones must not appear.
    mem.getRamBank(1)[1] = 0xFF;
    const buf = pixels();
    asic.renderScanline(buf, 0);

    const row = PCW_BORDER_TOP * PCW_SCREEN_WIDTH + PCW_BORDER_LEFT;
    for (let x = 0; x < 8; x++) expect(buf[row + x]).toBe(0xFF000000);
    for (let x = 8; x < 16; x++) expect(buf[row + x]).toBe(0xFFFFFFFF);
  });

  it('swaps ink and paper in reverse video, and blanks when disabled', () => {
    const { mem, asic } = build();
    asic.ink = 0xFFFFFFFF; asic.paper = 0xFF000000;
    layOutLine(mem, asic, [0x80]);
    const row = PCW_BORDER_TOP * PCW_SCREEN_WIDTH + PCW_BORDER_LEFT;

    asic.videoCtl = PCW_VIDEO_ENABLE | PCW_VIDEO_REVERSE;
    const reversed = pixels();
    asic.renderScanline(reversed, 0);
    expect(reversed[row]).toBe(0xFF000000);
    expect(reversed[row + 1]).toBe(0xFFFFFFFF);

    // b6 clear, b7 clear: all paper, whatever the bitmap says.
    asic.videoCtl = 0;
    const off = pixels();
    asic.renderScanline(off, 0);
    expect(off[row]).toBe(0xFF000000);
    expect(off[row + 1]).toBe(0xFF000000);
  });

  it('draws nothing below the 256 displayed lines', () => {
    const { mem, asic } = build();
    asic.ink = 0xFFFFFFFF; asic.paper = 0xFF000000;
    layOutLine(mem, asic, [0xFF]);
    const buf = pixels();
    buf.fill(0);
    asic.renderScanline(buf, PCW_DISPLAY_HEIGHT);
    expect(buf.every(p => p === 0)).toBe(true);
  });

  it('shows only the first 200 lines at 60Hz', () => {
    // "only the first 200 of the 256 scan lines are displayed on the Screen"
    const { mem, asic } = build();
    asic.timing = PCW_TIMING_60HZ;
    asic.ink = 0xFFFFFFFF; asic.paper = 0xFF000000;
    layOutLine(mem, asic, [0xFF]);
    // Every roller entry points at the same line, so any drawn line has ink.
    const bank = mem.getRamBank(2);
    for (let e = 0; e < 256; e++) { bank[0x3600 + e * 2] = 0x00; bank[0x3600 + e * 2 + 1] = 0x20; }
    const buf = pixels();
    buf.fill(0);
    asic.renderScanline(buf, 199);
    expect(buf[(PCW_BORDER_TOP + 199) * PCW_SCREEN_WIDTH + PCW_BORDER_LEFT]).toBe(0xFFFFFFFF);
    buf.fill(0);
    asic.renderScanline(buf, 200);
    expect(buf.every(p => p === 0)).toBe(true);
  });
});
