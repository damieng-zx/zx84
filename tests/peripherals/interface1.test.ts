/**
 * ZX Interface 1 — shadow-ROM paging + microdrive drive-select chain.
 *
 * Paging (Fuse `z80_ops.c`): the 8KB IF1 ROM pages into 0x0000-0x1FFF on an
 * M1 opcode fetch at 0x0008 or 0x1708, and pages out on a fetch at 0x0700.
 * Only the bottom 8KB is overlaid; 0x2000-0x3FFF stays the Spectrum ROM.
 *
 * Drive select (Fuse `if1.c` port_ctr_out): a falling edge on COMMS CLK
 * (control port 0xEF bit 1) shifts the 8-stage motor-on chain, loading the
 * inverted COMMS DATA (bit 0) into stage 0. Exactly one drive's motor is on
 * during normal access.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Interface1 } from '@/machines/spectrum/peripherals/interface1.ts';
import { Microdrive, BLOCK_LEN } from '@/machines/spectrum/peripherals/microdrive.ts';
import { SpectrumMemory } from '@/machines/spectrum/memory.ts';

describe('Interface1 — initial state', () => {
  it('starts disabled, not paged, no ROM, with 8 microdrives', () => {
    const if1 = new Interface1();
    expect(if1.enabled).toBe(false);
    expect(if1.pagedIn).toBe(false);
    expect(if1.romLoaded).toBe(false);
    expect(if1.drives.length).toBe(8);
    expect(if1.drives.every((d) => d instanceof Microdrive)).toBe(true);
  });

  it('loadROM accepts an 8KB image', () => {
    const if1 = new Interface1();
    if1.loadROM(new Uint8Array(8192).map((_, i) => i & 0xff));
    expect(if1.romLoaded).toBe(true);
    expect(if1.rom[0]).toBe(0);
    expect(if1.rom[8191]).toBe(8191 & 0xff);
  });
});

describe('Interface1 — port decode', () => {
  let if1: Interface1;
  beforeEach(() => { if1 = new Interface1(); });

  it('matches the microdrive data (0xE7), control (0xEF) and RS232 (0xF7) ports by low byte', () => {
    expect(if1.matchPort(0xe7)).toBe(true);
    expect(if1.matchPort(0xef)).toBe(true);
    expect(if1.matchPort(0xf7)).toBe(true);
    expect(if1.matchPort(0xfee7)).toBe(true); // high byte ignored
  });

  it('does not match unrelated ports', () => {
    expect(if1.matchPort(0xfe)).toBe(false);
    expect(if1.matchPort(0x1f)).toBe(false);
    expect(if1.matchPort(0xfffd)).toBe(false);
  });
});

describe('Interface1 — shadow ROM paging', () => {
  function makeMem(): SpectrumMemory {
    const mem = new SpectrumMemory('48k');
    mem.romPages[0].fill(0x99);            // whole Spectrum ROM = 0x99
    mem.romPages[0][0x0000] = 0xAA;        // a low-half marker
    mem.romPages[0][0x2000] = 0xC3;        // an upper-half marker
    // Re-establish slot 0 from the (now-populated) ROM page.
    mem.restoreSlot0();
    return mem;
  }

  it('checkM1Page pages the IF1 ROM in at 0x0008', () => {
    const mem = makeMem();
    const if1 = new Interface1();
    if1.rom.fill(0x11);
    if1.romLoaded = true;

    if1.checkM1Page(0x0008, mem);
    expect(if1.pagedIn).toBe(true);
    expect(mem.readByte(0x0000)).toBe(0x11);  // IF1 ROM low half
    expect(mem.readByte(0x2000)).toBe(0xC3);  // Spectrum ROM upper half preserved
  });

  it('does NOT page out inside checkM1Page at 0x0700 — that must happen AFTER the RET there runs', () => {
    // The IF1 ROM byte at 0x0700 is a RET (the clean exit); it must be fetched
    // and executed from the IF1 ROM, so checkM1Page (which runs BEFORE the
    // instruction) must leave the IF1 paged in. Paging out here was the bug
    // that made CAT fall into Spectrum-ROM garbage. The frame loop pages out
    // after the instruction via shouldPageOut()/pageOut().
    const mem = makeMem();
    const if1 = new Interface1();
    if1.rom.fill(0x11);
    if1.rom[0x0700] = 0xC9;   // RET, as in the real IF1 ROM
    if1.romLoaded = true;
    if1.checkM1Page(0x0008, mem);          // page in
    expect(if1.pagedIn).toBe(true);

    if1.checkM1Page(0x0700, mem);          // pre-instruction: must NOT page out
    expect(if1.pagedIn).toBe(true);
    expect(mem.readByte(0x0700)).toBe(0xC9); // the RET is still the IF1 ROM's
    expect(if1.shouldPageOut(0x0700)).toBe(true);

    if1.pageOut(mem);                       // frame loop does this AFTER the RET
    expect(if1.pagedIn).toBe(false);
    expect(mem.readByte(0x0000)).toBe(0xAA); // original Spectrum ROM restored
  });

  it('shouldPageOut is only true at 0x0700 while paged in', () => {
    const if1 = new Interface1();
    expect(if1.shouldPageOut(0x0700)).toBe(false); // not paged in
    if1.pagedIn = true;
    expect(if1.shouldPageOut(0x0700)).toBe(true);
    expect(if1.shouldPageOut(0x0008)).toBe(false);
  });

  it('also pages in at 0x1708 (channel handler)', () => {
    const mem = makeMem();
    const if1 = new Interface1();
    if1.romLoaded = true;
    if1.checkM1Page(0x1708, mem);
    expect(if1.pagedIn).toBe(true);
  });

  it('ignores other fetch addresses', () => {
    const mem = makeMem();
    const if1 = new Interface1();
    if1.romLoaded = true;
    if1.checkM1Page(0x0009, mem);
    if1.checkM1Page(0x1234, mem);
    expect(if1.pagedIn).toBe(false);
  });

  it('does not page in when no ROM is loaded', () => {
    const mem = makeMem();
    const if1 = new Interface1();
    if1.checkM1Page(0x0008, mem);
    expect(if1.pagedIn).toBe(false);
  });
});

describe('Interface1 — drive-select chain', () => {
  let if1: Interface1;
  beforeEach(() => { if1 = new Interface1(); });

  /** Pulse a COMMS CLK falling edge carrying the given COMMS DATA bit. */
  function clock(dataBit: number): void {
    if1.writeControl(0x02 | dataBit);  // CLK high
    if1.writeControl(0x00 | dataBit);  // CLK low → falling edge shifts the chain
  }

  it('a single motor-on pulse selects drive 1 (stage 0)', () => {
    clock(0);                       // COMMS DATA = 0 → motor-on into stage 0
    expect(if1.drives[0].motorOn).toBe(true);
    expect(if1.drives.slice(1).some((d) => d.motorOn)).toBe(false);
  });

  it('shifting the motor-on bit along selects successive drives', () => {
    clock(0);                       // drive 1 on
    clock(1);                       // shift: stage0→stage1, new stage0 = off
    expect(if1.drives[0].motorOn).toBe(false);
    expect(if1.drives[1].motorOn).toBe(true);
  });

  it('reset clears all drive selection and paging', () => {
    clock(0);
    if1.pagedIn = true;
    if1.reset();
    expect(if1.drives.every((d) => !d.motorOn)).toBe(true);
    expect(if1.pagedIn).toBe(false);
  });
});

describe('Interface1 — data transfer across the selected drive', () => {
  it('reads bytes from the one selected drive through port 0xE7', () => {
    const if1 = new Interface1();
    // Put a ramp cartridge in drive 1.
    const raw = new Uint8Array(4 * BLOCK_LEN + 1);
    for (let i = 0; i < 4 * BLOCK_LEN; i++) raw[i] = i & 0xff;
    if1.drives[0].loadMDR(raw);
    // Select drive 1.
    if1.writeControl(0x02); if1.writeControl(0x00);
    if1.writeControl(0xEF); // status read path resets/aligns via restart
    if1.readStatus();       // triggers restart() → head at block start
    const first = if1.readData();
    expect(first).toBe(0x00); // byte at loop offset 0
  });

  it('an idle bus (no drive selected) reads 0xFF', () => {
    const if1 = new Interface1();
    expect(if1.readData()).toBe(0xff);
    expect(if1.readStatus() & 0x06).toBe(0x06); // GAP & SYNC high → no block
  });
});
