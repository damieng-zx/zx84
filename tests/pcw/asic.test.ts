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
import { PcwAsic, rollerEntryAddress } from '@/machines/pcw/asic.ts';
import {
  PCW_BORDER_LEFT, PCW_BORDER_TOP, PCW_DISPLAY_HEIGHT, PCW_LINES_PER_FRAME,
  PCW_SCREEN_HEIGHT, PCW_SCREEN_WIDTH, PCW_STATUS_32_LINE, PCW_STATUS_FLYBACK,
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

describe('interrupt cadence', () => {
  it('fires six times a field, two lines into flyback and every 52 after', () => {
    const lines: number[] = [];
    for (let line = 0; line < PCW_LINES_PER_FRAME; line++) {
      if (PcwAsic.isInterruptLine(line)) lines.push(line);
    }
    // 258 is 2 lines into flyback (the display is 256 lines); +52 wrapping.
    expect(lines).toEqual([50, 102, 154, 206, 258, 310]);
  });

  it('counts pending interrupts and saturates at four bits', () => {
    const { asic } = build();
    for (let i = 0; i < 3; i++) asic.beginLine(258);
    expect(asic.status & 0x0F).toBe(3);
    for (let i = 0; i < 40; i++) asic.beginLine(258);
    expect(asic.status & 0x0F).toBe(0x0F);
  });

  it('clears the counter on a &F4 read but not on a &F8 read', () => {
    const { asic } = build();
    asic.beginLine(50);
    asic.beginLine(102);
    expect(asic.status & 0x0F).toBe(2);
    // &F8 leaves it alone…
    expect(asic.status & 0x0F).toBe(2);
    // …&F4 returns the same byte and then resets b3-0.
    expect(asic.readMemCtlStatus() & 0x0F).toBe(2);
    expect(asic.status & 0x0F).toBe(0);
  });

  it('drops /INT when the CPU takes the interrupt, leaving the count alone', () => {
    const { asic } = build();
    asic.beginLine(258);
    expect(asic.intPending).toBe(true);
    asic.acknowledgeTimer();
    expect(asic.intPending).toBe(false);
    expect(asic.status & 0x0F).toBe(1);
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
  it('reports flyback only outside the 256 displayed lines', () => {
    const { asic } = build();
    asic.beginLine(0);
    expect(asic.status & PCW_STATUS_FLYBACK).toBe(0);
    asic.beginLine(PCW_DISPLAY_HEIGHT - 1);
    expect(asic.status & PCW_STATUS_FLYBACK).toBe(0);
    asic.beginLine(PCW_DISPLAY_HEIGHT);
    expect(asic.status & PCW_STATUS_FLYBACK).toBe(PCW_STATUS_FLYBACK);
  });

  it('always reports a 32-line screen on a 50Hz machine', () => {
    const { asic } = build();
    expect(asic.status & PCW_STATUS_32_LINE).toBe(PCW_STATUS_32_LINE);
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

  it('draws nothing during flyback', () => {
    const { mem, asic } = build();
    asic.ink = 0xFFFFFFFF; asic.paper = 0xFF000000;
    layOutLine(mem, asic, [0xFF]);
    const buf = pixels();
    buf.fill(0);
    asic.renderScanline(buf, PCW_DISPLAY_HEIGHT);
    expect(buf.every(p => p === 0)).toBe(true);
  });
});
