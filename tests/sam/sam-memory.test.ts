/**
 * SamMemory — the SAM Coupé paging truth table.
 *
 * Every expectation here is derived from the SAM Technical Manual's LMPR/HMPR
 * definitions and SimCoupe's `UpdatePaging()`, hand-computed. Nothing is read
 * back out of the implementation to build an expectation.
 *
 *   Section A (0000-3FFF): ROM 0 unless LMPR bit 5, else page (lmpr & 0x1F)
 *   Section B (4000-7FFF): page ((lmpr + 1) & 0x1F)          -- always RAM
 *   Section C (8000-BFFF): external[lepr] if HMPR bit 7, else page (hmpr & 0x1F)
 *   Section D (C000-FFFF): external[hepr] if HMPR bit 7,
 *                          else ROM 1 if LMPR bit 6,
 *                          else page ((hmpr + 1) & 0x1F)
 */

import { describe, expect, it } from 'vitest';
import { SamMemory } from '@/machines/sam/sam-memory.ts';
import { createSamConfig } from '@/machines/sam/config.ts';
import { SAM_PAGE_SIZE, SAM_ROM_SIZE } from '@/machines/sam/constants.ts';
import type { SamModel } from '@/machines/sam/models.ts';

const SECTION_A = 0x0000;
const SECTION_B = 0x4000;
const SECTION_C = 0x8000;
const SECTION_D = 0xC000;

function memory(model: SamModel = 'sam512'): SamMemory {
  return new SamMemory(createSamConfig(model));
}

/** A 32K ROM whose two halves are filled with distinguishable constants. */
function markedRom(): Uint8Array {
  const rom = new Uint8Array(SAM_ROM_SIZE);
  rom.fill(0xA0, 0, SAM_PAGE_SIZE);              // ROM 0
  rom.fill(0xB1, SAM_PAGE_SIZE, SAM_ROM_SIZE);   // ROM 1
  return rom;
}

/** Stamp each internal page with its own page number at offset 0. */
function markPages(m: SamMemory, pages: number): void {
  for (let p = 0; p < pages; p++) m.getRamBank(p)[0] = p;
}

describe('SamMemory paging', () => {
  it('boots with ROM 0 over section A and page 1 in section B', () => {
    const m = memory();
    m.loadRom(markedRom());
    markPages(m, 32);

    // LMPR = 0 → ROM0_OFF clear, so ROM 0 is paged in; section B is page 1.
    expect(m.readByte(SECTION_A)).toBe(0xA0);
    expect(m.readByte(SECTION_B)).toBe(1);
  });

  it('pages RAM into section A when LMPR bit 5 is set', () => {
    const m = memory();
    m.loadRom(markedRom());
    markPages(m, 32);

    m.setLmpr(0x20 | 5);   // ROM0_OFF + page 5
    expect(m.readByte(SECTION_A)).toBe(5);
    expect(m.readByte(SECTION_B)).toBe(6);
  });

  it('wraps section B inside the 5-bit page field, so LMPR=0x3F maps page 0', () => {
    // The classic off-by-one: (lmpr + 1) & 0x1F, NOT page | 1 and NOT page + 1
    // in 8 bits. With page 31 selected, section B must roll round to page 0.
    const m = memory();
    markPages(m, 32);

    m.setLmpr(0x20 | 0x1F);   // ROM0_OFF + page 31
    expect(m.readByte(SECTION_A)).toBe(31);
    expect(m.readByte(SECTION_B)).toBe(0);
  });

  it('wraps section D inside the 5-bit page field too', () => {
    const m = memory();
    markPages(m, 32);

    m.setHmpr(0x1F);   // page 31 into C, so D wraps to page 0
    expect(m.readByte(SECTION_C)).toBe(31);
    expect(m.readByte(SECTION_D)).toBe(0);
  });

  it('pages ROM 1 over section D when LMPR bit 6 is set', () => {
    const m = memory();
    m.loadRom(markedRom());
    markPages(m, 32);

    m.setHmpr(4);
    expect(m.readByte(SECTION_D)).toBe(5);   // page 5 before ROM 1 is enabled

    m.setLmpr(0x40);                         // LMPR_ROM1
    expect(m.readByte(SECTION_D)).toBe(0xB1);
  });

  it('discards writes to a ROM-overlaid section without disturbing the RAM beneath', () => {
    const m = memory();
    m.loadRom(markedRom());

    // ROM 0 is over section A at LMPR = 0. Writing there must be swallowed.
    m.writeByte(SECTION_A, 0x5A);
    expect(m.readByte(SECTION_A)).toBe(0xA0);

    // And it must not have leaked into page 0's RAM either.
    m.setLmpr(0x20);   // page RAM 0 in
    expect(m.readByte(SECTION_A)).toBe(0x00);
  });
});

describe('SamMemory write protection (LMPR bit 7)', () => {
  it('protects both low sections, not just section A', () => {
    // The Technical Manual describes LMPR bit 7 as write-protecting the lower
    // 32K, i.e. sections A and B together.
    const m = memory();
    m.setLmpr(0x20);            // RAM in section A, no protection
    m.writeByte(SECTION_A, 0x11);
    m.writeByte(SECTION_B, 0x22);
    expect(m.readByte(SECTION_A)).toBe(0x11);
    expect(m.readByte(SECTION_B)).toBe(0x22);

    m.setLmpr(0x20 | 0x80);     // same paging, now write-protected
    m.writeByte(SECTION_A, 0xEE);
    m.writeByte(SECTION_B, 0xEE);
    expect(m.readByte(SECTION_A)).toBe(0x11);
    expect(m.readByte(SECTION_B)).toBe(0x22);
  });

  it('leaves the high sections writable while the low 32K is protected', () => {
    const m = memory();
    m.setLmpr(0x80);
    m.writeByte(SECTION_C, 0x33);
    m.writeByte(SECTION_D, 0x44);
    expect(m.readByte(SECTION_C)).toBe(0x33);
    expect(m.readByte(SECTION_D)).toBe(0x44);
  });
});

describe('SamMemory model differences', () => {
  it('reads open bus from an unfitted page, and does NOT alias a fitted one', () => {
    // This is what lets the ROM size memory. Its routine pages each candidate
    // into section C, writes 0xFF and reads it back, then writes 0x00 and reads
    // that back. An aliasing model passes both checks, so every machine would
    // report 512K — including a 256K one, which is plainly wrong.
    const m = memory('sam256');
    m.setLmpr(0x20 | 0);
    m.writeByte(SECTION_A, 0x77);

    m.setLmpr(0x20 | 16);                     // page 16: not fitted on a 256K
    expect(m.readByte(SECTION_A)).toBe(0xFF); // open bus, not page 0's 0x77
  });

  it('swallows writes to an unfitted page without disturbing fitted RAM', () => {
    const m = memory('sam256');
    m.setLmpr(0x20 | 0);
    m.writeByte(SECTION_A, 0x77);

    m.setLmpr(0x20 | 16);
    m.writeByte(SECTION_A, 0x5A);             // lost

    m.setLmpr(0x20 | 0);
    expect(m.readByte(SECTION_A)).toBe(0x77); // page 0 untouched
  });

  it('fails the ROM sizing probe on an unfitted page, and passes on a fitted one', () => {
    // The probe itself, run directly: write FF / read back, then write 00 /
    // read back. Both must hold for the ROM to count the page as present.
    const probe = (m: SamMemory, page: number): boolean => {
      m.setHmpr(page);
      m.writeByte(SECTION_C, 0xFF);
      if (m.readByte(SECTION_C) !== 0xFF) return false;
      m.writeByte(SECTION_C, 0x00);
      return m.readByte(SECTION_C) === 0x00;
    };

    const m256 = memory('sam256');
    expect(probe(m256, 15)).toBe(true);
    expect(probe(m256, 16)).toBe(false);      // where a 256K machine stops

    const m512 = memory('sam512');
    expect(probe(m512, 16)).toBe(true);
    expect(probe(m512, 31)).toBe(true);       // a 512K machine has them all
  });

  it('gives a 512K machine 32 distinct pages', () => {
    const m = memory('sam512');
    m.setLmpr(0x20 | 0);
    m.writeByte(SECTION_A, 0x77);

    m.setLmpr(0x20 | 16);
    expect(m.readByte(SECTION_A)).toBe(0x00);
  });
});

describe('SamMemory external megabyte interface (HMPR bit 7)', () => {
  it('reads open bus and swallows writes when no interface is fitted', () => {
    // Software probes for the megabyte this way: page it in, write, read back.
    // A machine without it must answer 0xFF, never internal RAM.
    const m = memory('sam512');
    m.setHmpr(0x80);
    m.writeByte(SECTION_C, 0x5A);
    m.writeByte(SECTION_D, 0x5A);
    expect(m.readByte(SECTION_C)).toBe(0xFF);
    expect(m.readByte(SECTION_D)).toBe(0xFF);
  });

  it('does not corrupt internal RAM through the absent external window', () => {
    const m = memory('sam512');
    m.setHmpr(0);
    m.writeByte(SECTION_C, 0x11);   // internal page 0

    m.setHmpr(0x80);                // external window (absent)
    m.writeByte(SECTION_C, 0xEE);

    m.setHmpr(0);                   // back to internal page 0
    expect(m.readByte(SECTION_C)).toBe(0x11);
  });

  it('pages independent external pages into sections C and D via LEPR/HEPR', () => {
    const m = memory('sam1m');
    m.setHmpr(0x80);

    m.setLepr(3);
    m.setHepr(9);
    m.writeByte(SECTION_C, 0x33);
    m.writeByte(SECTION_D, 0x99);

    // Swapping the two registers must swap which bytes appear.
    m.setLepr(9);
    m.setHepr(3);
    expect(m.readByte(SECTION_C)).toBe(0x99);
    expect(m.readByte(SECTION_D)).toBe(0x33);
  });

  it('takes precedence over ROM 1 in section D', () => {
    // UpdatePaging tests HMPR_MCNTRL before LMPR_ROM1.
    const m = memory('sam1m');
    m.loadRom(markedRom());
    m.setLmpr(0x40);        // ask for ROM 1 over section D
    expect(m.readByte(SECTION_D)).toBe(0xB1);

    m.setHmpr(0x80);        // external memory wins
    m.setHepr(0);
    expect(m.readByte(SECTION_D)).toBe(0x00);
  });
});

describe('SamMemory VMPR decode', () => {
  it('reports the screen mode as 1-4 from VMPR bits 5-6', () => {
    const m = memory();
    for (const [bits, mode] of [[0x00, 1], [0x20, 2], [0x40, 3], [0x60, 4]] as const) {
      m.setVmpr(bits);
      expect(m.videoMode).toBe(mode);
    }
  });

  it('ignores the low page bit in modes 3 and 4, which need a 24K page pair', () => {
    const m = memory();
    m.setVmpr(0x00 | 5);   // mode 1, page 5
    expect(m.videoBasePage).toBe(5);

    m.setVmpr(0x40 | 5);   // mode 3, page 5 → base page 4
    expect(m.videoBasePage).toBe(4);

    m.setVmpr(0x60 | 5);   // mode 4, page 5 → base page 4
    expect(m.videoBasePage).toBe(4);
  });

  it('does not disturb CPU paging', () => {
    const m = memory();
    markPages(m, 32);
    m.setLmpr(0x20 | 7);
    m.setVmpr(0x60 | 13);
    expect(m.readByte(SECTION_A)).toBe(7);
  });
});

describe('SamMemory snapshots', () => {
  it('snapshot() shows the ROM overlay but ramSnapshot() shows the RAM beneath', () => {
    const m = memory();
    m.loadRom(markedRom());
    m.getRamBank(0)[0] = 0x42;   // page 0 sits under ROM 0 at LMPR = 0

    expect(m.snapshot()[0]).toBe(0xA0);
    expect(m.ramSnapshot()[0]).toBe(0x42);
  });

  it('reset() restores the power-on paging registers', () => {
    const m = memory();
    m.loadRom(markedRom());
    m.setLmpr(0x20 | 9);
    m.setHmpr(0x80);
    m.setLepr(4);

    m.reset();

    expect(m.readByte(SECTION_A)).toBe(0xA0);   // ROM 0 back over section A
    expect(m.pagingState().lmpr).toBe(0);
    expect(m.pagingState().externalPaged).toBe(false);
  });
});
