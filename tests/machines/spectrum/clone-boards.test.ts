/**
 * Scorpion ZS-256 board logic (even-M1 wait, Turbo+ 7 MHz clock, #FF attribute
 * port, Magic button) and the Pentagon 1024's hardware multicolour.
 *
 * Expected values are worked out by hand from the published behaviour, not read
 * back from the implementation:
 *  - Scorpion even M1: an opcode fetch from RAM that would start on an odd
 *    T-state (counted from the frame interrupt) takes one extra wait; ROM
 *    fetches are not delayed. LD A,n is 7 T-states, so back to back from an
 *    even start the second one starts on an odd T-state and waits: 7, then 8
 *    for each of the rest.
 *  - Turbo+: IN from the 7FFD address switches to 7 MHz, IN from 1FFD back to
 *    3.5 MHz (ZX Format #2). At 7 MHz an instruction takes half as many
 *    3.5 MHz T-states, so ten LD A,n (70 T) cost 35.
 *  - #FF reads the attribute under the beam, 0xFF outside the 256x192 display;
 *    the Scorpion first pixel is at T-state 14344, 224 T per line, 4 T per cell.
 *  - Magic: NMI taken at the next opcode fetch >= 0x4000, ROM at 0x0000 becomes
 *    the service monitor (128K ROM selected) or TR-DOS (48K BASIC selected),
 *    entry at 0x0066, return address pushed; dropped again on a fetch >= 0x4000.
 *  - Pentagon 1024 EFF7 bit 5: one attribute per bitmap byte, bitmap at
 *    0x4000-0x57FF and attributes at 0x6000-0x77FF.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { saveSZXSync, loadSZX } from '@/machines/spectrum/snapshots/szx.ts';

function rom64(): Uint8Array {
  const rom = new Uint8Array(65536);
  for (let p = 0; p < 4; p++) rom[p * 16384] = 0xA0 + p;
  return rom;
}

function scorpion(): Spectrum {
  const s = new Spectrum('scorpion256', null);
  s.loadROM(rom64());
  s.cpu.tStates = 0;
  s.contention.frameStartTStates = 0;
  return s;
}

/** `count` copies of LD A,0 (3E 00) from `addr`, written straight into the live map. */
function ldALoop(s: Spectrum, addr: number, count: number): void {
  for (let i = 0; i < count; i++) { s.memory.flat[addr + 2 * i] = 0x3E; s.memory.flat[addr + 2 * i + 1] = 0x00; }
}

function runInstructions(s: Spectrum, pc: number, n: number): number {
  s.cpu.pc = pc;
  const t0 = s.cpu.tStates;
  for (let i = 0; i < n; i++) s.cpu.step();
  return s.cpu.tStates - t0;
}

describe('Scorpion - even M1', () => {
  it('stretches LD A,n fetched from RAM to 8 T-states after the first (7 + 9 x 8 = 79)', () => {
    const s = scorpion();
    ldALoop(s, 0x8000, 10);
    expect(runInstructions(s, 0x8000, 10)).toBe(79);
  });

  it('does not delay fetches from ROM (10 x 7 = 70)', () => {
    const s = scorpion();
    ldALoop(s, 0x0000, 10);      // slot 0 is ROM here; the live map is what the CPU fetches from
    expect(runInstructions(s, 0x0000, 10)).toBe(70);
  });

  it('delays fetches from RAM mapped over 0x0000 (1FFD D0)', () => {
    const s = scorpion();
    s.cpu.portOutHandler!(0x1FFD, 0x01);
    ldALoop(s, 0x0000, 10);
    expect(runInstructions(s, 0x0000, 10)).toBe(79);
  });

  it('counts parity from the frame interrupt, not from T-state zero', () => {
    const s = scorpion();
    s.contention.frameStartTStates = 1;      // the frame began on an odd T-state
    ldALoop(s, 0x8000, 10);
    s.cpu.tStates = 1;                        // first fetch at frame T-state 0: even, no wait
    expect(runInstructions(s, 0x8000, 10)).toBe(79);
  });

  it('is absent on the Pentagon 128 (10 x 7 = 70 from RAM)', () => {
    const p = new Spectrum('pentagon128', null);
    p.loadROM(new Uint8Array(32768));
    p.cpu.tStates = 0;
    ldALoop(p, 0x8000, 10);
    expect(runInstructions(p, 0x8000, 10)).toBe(70);
    expect(p.scorpion).toBeNull();
  });
});

describe('Scorpion - Turbo+ clock', () => {
  it('IN from the 7FFD address runs the CPU at 7 MHz: ten LD A,n cost 35 T-states', () => {
    const s = scorpion();
    expect(s.cpu.portInHandler!(0x7FFD)).toBe(0xFF);
    expect(s.memory.cpuTurbo).toBe(true);
    ldALoop(s, 0x8000, 10);
    expect(runInstructions(s, 0x8000, 10)).toBe(35);
  });

  it('carries the odd half T-state: three LD A,n cost 3 + 4 + 3', () => {
    const s = scorpion();
    s.cpu.portInHandler!(0x7FFD);
    ldALoop(s, 0x8000, 6);
    // 7 -> 3 (carry 1); 7 + 1 = 8 -> 4 (carry 0); 7 -> 3 (carry 1): 10 in all
    expect(runInstructions(s, 0x8000, 3)).toBe(10);
  });

  it('IN from the 1FFD address returns to 3.5 MHz', () => {
    const s = scorpion();
    s.cpu.portInHandler!(0x7FFD);
    s.cpu.portInHandler!(0x1FFD);
    expect(s.memory.cpuTurbo).toBe(false);
    ldALoop(s, 0x0000, 10);
    expect(runInstructions(s, 0x0000, 10)).toBe(70);
  });

  it('decodes the switch like the paging ports: an IN from 0x3FFD changes nothing', () => {
    const s = scorpion();
    s.cpu.portInHandler!(0x3FFD);
    expect(s.memory.cpuTurbo).toBe(false);
  });

  it('is cleared by reset and not available on the Pentagon', () => {
    const s = scorpion();
    s.cpu.portInHandler!(0x7FFD);
    s.reset();
    expect(s.memory.cpuTurbo).toBe(false);
    const p = new Spectrum('pentagon128', null);
    p.loadROM(new Uint8Array(32768));
    p.cpu.portInHandler!(0x7FFD);
    expect(p.memory.cpuTurbo).toBe(false);
  });

  it('halves the interrupt acknowledge too (IM 1: 13 T becomes 6)', () => {
    const s = scorpion();
    s.cpu.portInHandler!(0x7FFD);
    s.cpu.iff1 = true; s.cpu.im = 1;
    const t0 = s.cpu.tStates;
    expect(s.cpu.interrupt()).toBeGreaterThan(0);
    expect(s.cpu.tStates - t0).toBe(6);
  });

  it('round-trips through an SZX snapshot', async () => {
    const s = scorpion();
    s.cpu.portInHandler!(0x7FFD);
    const szx = saveSZXSync(s.cpu, s.memory, 0, 'scorpion256', 0);
    const t = scorpion();
    expect(t.memory.cpuTurbo).toBe(false);
    await loadSZX(szx, t.cpu, t.memory);
    expect(t.memory.cpuTurbo).toBe(true);
    // And a snapshot taken at 3.5 MHz restores 3.5 MHz.
    s.cpu.portInHandler!(0x1FFD);
    await loadSZX(saveSZXSync(s.cpu, s.memory, 0, 'scorpion256', 0), t.cpu, t.memory);
    expect(t.memory.cpuTurbo).toBe(false);
  });
});

describe('Scorpion - #FF attribute port', () => {
  function withAttr(): Spectrum {
    const s = scorpion();
    s.memory.writeByte(0x5800 + 32 + 10, 0x5A);   // row 1, column 10
    return s;
  }

  it('returns the attribute under the beam: line 10 (row 1), T-state 40 into the line = column 10', () => {
    const s = withAttr();
    s.cpu.tStates = 14344 + 10 * 224 + 40;
    expect(s.cpu.portInHandler!(0x40FF)).toBe(0x5A);
  });

  it('reads 0xFF in the top border, the right border and below the display', () => {
    const s = withAttr();
    s.cpu.tStates = 14343;
    expect(s.cpu.portInHandler!(0x40FF)).toBe(0xFF);
    s.cpu.tStates = 14344 + 10 * 224 + 128;
    expect(s.cpu.portInHandler!(0x40FF)).toBe(0xFF);
    s.cpu.tStates = 14344 + 192 * 224;
    expect(s.cpu.portInHandler!(0x40FF)).toBe(0xFF);
  });

  it('is decoded on A0, A1, A2 and A5 only (xxxxxxxx xx1xx111): 0xDF and 0xFB do not answer', () => {
    const s = withAttr();
    s.cpu.tStates = 14344 + 10 * 224 + 40;
    expect(s.cpu.portInHandler!(0x00FF)).toBe(0x5A);
    expect(s.cpu.portInHandler!(0x00DF)).toBe(0xFF);   // A5 low
    expect(s.cpu.portInHandler!(0x00FB)).toBe(0xFF);   // A2 low
  });
});

describe('Scorpion - Magic button', () => {
  function armed(): Spectrum {
    const s = scorpion();
    s.betaDisk.enabled = true;
    s.memory.flat[0x8000] = 0x00;
    s.cpu.pc = 0x8000;
    s.cpu.sp = 0xFF00;
    return s;
  }

  it('does nothing while the CPU runs ROM below 0x4000', () => {
    const s = armed();
    s.cpu.pc = 0x1000;
    s.scorpion!.pressMagic();
    s.cpu.step();
    expect(s.scorpion!.nmiPending).toBe(true);
    expect(s.cpu.pc).toBe(0x1001);
  });

  it('takes the NMI at the next fetch from RAM with the service ROM behind 0x0000 (128K ROM selected)', () => {
    const s = armed();
    s.scorpion!.pressMagic();
    const t0 = s.cpu.tStates;
    s.cpu.step();
    expect(s.cpu.pc).toBe(0x0066);
    expect(s.cpu.tStates - t0).toBe(11);                 // NMI acknowledge: 11 T-states
    expect(s.memory.readByte(0xFEFE)).toBe(0x00);        // pushed return address 0x8000
    expect(s.memory.readByte(0xFEFF)).toBe(0x80);
    expect(s.memory.readByte(0x0000)).toBe(0xA2);        // service ROM page
    expect(s.betaDisk.pagedIn).toBe(true);               // FDC ports live, as for TR-DOS
    expect(s.scorpion!.nmiPending).toBe(false);
  });

  it('maps TR-DOS instead with 48K BASIC selected (7FFD D4)', () => {
    const s = armed();
    s.cpu.portOutHandler!(0x7FFD, 0x10);
    s.scorpion!.pressMagic();
    s.cpu.step();
    expect(s.memory.readByte(0x0000)).toBe(0xA3);
  });

  it('maps the service ROM when 1FFD D1 asks for it even with 48K BASIC selected', () => {
    const s = armed();
    s.cpu.portOutHandler!(0x7FFD, 0x10);
    s.cpu.portOutHandler!(0x1FFD, 0x02);
    s.scorpion!.pressMagic();
    s.cpu.step();
    expect(s.memory.readByte(0x0000)).toBe(0xA2);
  });

  it('drops the monitor again on the first fetch at 0x4000 or above', () => {
    const s = armed();
    s.scorpion!.pressMagic();
    s.cpu.step();
    s.betaDisk.checkPage(0x8000, s.memory);              // the frame loop's per-instruction trap
    expect(s.betaDisk.pagedIn).toBe(false);
    expect(s.memory.readByte(0x0000)).toBe(0xA0);
  });

  it('is cleared by reset', () => {
    const s = armed();
    s.scorpion!.pressMagic();
    s.reset();
    expect(s.scorpion!.nmiPending).toBe(false);
  });
});

describe('Scorpion - Magic button on the real ZS-256 v2.5c ROM', () => {
  const romPath = resolve(__dirname, '../../../mcp/.cache/scorpion-zs256-v25c.rom');
  it.skipIf(!existsSync(romPath))('enters the service monitor: its first act is OUT 1FFD with D1 set, then it draws a screen', () => {
    const s = new Spectrum('scorpion256', null);
    s.loadROM(new Uint8Array(readFileSync(romPath)));
    s.betaDisk.enabled = true;
    s.reset();
    for (let f = 0; f < 300; f++) s.runUntil(1);       // the menu's key-wait, running from RAM-side code
    expect(s.cpu.pc).toBe(0x3683);
    s.memory.writeByte(0x8000, 0x18); s.memory.writeByte(0x8001, 0xFE);   // JR $ in RAM
    s.cpu.pc = 0x8000;
    s.scorpion!.pressMagic();
    for (let f = 0; f < 200; f++) s.runUntil(1);
    expect(s.memory.port1FFD & 0x02).toBe(0x02);        // the monitor selected its own ROM
    let ink = 0;
    for (let i = 0; i < 6144; i++) if (s.memory.screenBank[i] !== 0) ink++;
    expect(ink).toBeGreaterThan(200);                    // the monitor's text screen
  });
});

describe('Pentagon 1024 - hardware multicolour (EFF7 bit 5)', () => {
  function pentagon1024(): Spectrum {
    const s = new Spectrum('pentagon1024', null);
    s.loadROM(new Uint8Array(32768));
    s.memory.writeByte(0x4000, 0xFF);     // first bitmap byte: eight ink pixels
    s.memory.writeByte(0x5800, 0x01);     // standard attribute: ink blue
    s.memory.writeByte(0x6000, 0x02);     // per-byte attribute: ink red
    return s;
  }

  function firstPixel(s: Spectrum): number {
    s.ula.renderFrame(s.memory.screenBank, 0x4000);
    const px = new Uint32Array(s.ula.pixels.buffer);
    return px[s.ula.borderTop * s.ula.screenWidth + s.ula.borderLeft];
  }

  it('uses the 8x8 attribute at 0x5800 until the bit is set', () => {
    const s = pentagon1024();
    expect(firstPixel(s)).toBe(s.ula.palette[1]);
  });

  it('takes each byte attribute from 0x6000-0x77FF once EFF7 bit 5 is set', () => {
    const s = pentagon1024();
    s.cpu.portOutHandler!(0xEFF7, 0x20);
    expect(firstPixel(s)).toBe(s.ula.palette[2]);
  });

  it('returns to normal attributes when the bit is cleared, and on reset', () => {
    const s = pentagon1024();
    s.cpu.portOutHandler!(0xEFF7, 0x20);
    s.cpu.portOutHandler!(0xEFF7, 0x00);
    expect(firstPixel(s)).toBe(s.ula.palette[1]);
    s.cpu.portOutHandler!(0xEFF7, 0x20);
    s.reset();
    expect(s.ula.attrPerByte).toBe(false);
  });

  it('is not available on the Pentagon 128 (no EFF7 decode)', () => {
    const s = new Spectrum('pentagon128', null);
    s.loadROM(new Uint8Array(32768));
    s.cpu.portOutHandler!(0xEFF7, 0x20);
    expect(s.ula.attrPerByte).toBe(false);
  });
});
