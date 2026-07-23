import { describe, it, expect, beforeEach } from 'vitest';
import { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import { einsteinEntry } from '@/machines/einstein/descriptor.ts';
import { V9938 } from '@/cores/v9938.ts';

function machine(): EinsteinMachine {
  const m = new EinsteinMachine('einstein-256', null);
  m.turbo = true; // skip the audio path in headless runFrame
  return m;
}

/** A synthetic MOS: enable the display (R1 = BL|M1), set R7 = white bg,
 *  then spin. Assembled by hand:
 *    3E 50      LD A,0x50
 *    D3 09      OUT (0x09),A
 *    3E 81      LD A,0x81      ; R1
 *    D3 09      OUT (0x09),A
 *    3E 0F      LD A,0x0F
 *    D3 09      OUT (0x09),A
 *    3E 87      LD A,0x87      ; R7 = 0x0F (fg 0, bg 15)
 *    D3 09      OUT (0x09),A
 *    18 FE      JR $
 */
const SMOKE_ROM = [
  0x3E, 0x50, 0xD3, 0x09, 0x3E, 0x81, 0xD3, 0x09,
  0x3E, 0x0F, 0xD3, 0x09, 0x3E, 0x87, 0xD3, 0x09,
  0x18, 0xFE,
];

describe('Einstein 256 memory window', () => {
  let m: EinsteinMachine;
  beforeEach(() => {
    m = machine();
    const rom = new Uint8Array(0x4000);
    rom[0x0000] = 0xAA;
    rom[0x2000] = 0xBB;   // would be 0xAA if the TC-01 mirror were applied
    m.loadROM(rom);
    m.reset();
  });

  it('maps the 16KB MOS linearly with no mirror', () => {
    expect(m.memory.readByte(0x0000)).toBe(0xAA);
    expect(m.memory.readByte(0x2000)).toBe(0xBB); // not the mirror of 0x0000
    expect(m.memory.readByte(0x4000)).toBe(0xFF); // upper window reads 0xFF
  });

  it('still toggles the overlay via port 0x24 and writes through to RAM', () => {
    m.memory.writeByte(0x0000, 0x55);
    m.cpu.portOut(0x24, 0x00);
    expect(m.memory.readByte(0x0000)).toBe(0x55);
  });
});

describe('Einstein 256 V9938 port decode', () => {
  let m: EinsteinMachine;
  beforeEach(() => { m = machine(); m.reset(); });

  it('owns a V9938 with 192KB of VRAM', () => {
    expect(m.vdp).toBeInstanceOf(V9938);
    expect(m.vdp.vram.length).toBe(0x30000);
  });

  it('routes register writes through port 0x09 and reads status back', () => {
    m.cpu.portOut(0x09, 0x60);
    m.cpu.portOut(0x09, 0x80 | 1);   // R1 = BL + IE1
    expect(m.vdp.regs[1]).toBe(0x60);
    expect(m.cpu.portIn(0x09) & 0x80).toBe(0); // S0 F clear before vblank
  });

  it('routes palette and indirect-register writes through 0x0A/0x0B', () => {
    const vdp = m.vdp as V9938;
    m.cpu.portOut(0x09, 0x00);
    m.cpu.portOut(0x09, 0x80 | 16);  // R16 = palette index 0
    m.cpu.portOut(0x0A, 0x77);
    m.cpu.portOut(0x0A, 0x07);
    expect(vdp.pens[0]).toBe(0xFFFFFFFF);
    m.cpu.portOut(0x09, 0x00);
    m.cpu.portOut(0x09, 0x80 | 17);  // R17 = indirect index 0
    m.cpu.portOut(0x0B, 0x02);       // R0 = 0x02 → Graphic 2
    expect(vdp.regs[0]).toBe(0x02);
  });

  it('masks the VDP interrupt via port 0x80', () => {
    expect(m.vdpIntEnabled).toBe(true);
    m.cpu.portOut(0x80, 0x01);
    expect(m.vdpIntEnabled).toBe(false);
    m.cpu.portOut(0x80, 0x00);
    expect(m.vdpIntEnabled).toBe(true);
  });
});

describe('Einstein 256 system status port 0x26', () => {
  let m: EinsteinMachine;
  beforeEach(() => { m = machine(); m.reset(); });

  it('reports ROM state, hardwired 50Hz/English dips and no mouse', () => {
    const v = m.cpu.portIn(0x26);
    expect(v & 0x02).toBe(0x02);     // ROM paged in at reset
    expect(v & 0x04).toBe(0x04);     // dipswitch 1: 625-line 50Hz
    expect(v & 0x40).toBe(0x40);     // no mouse
    m.cpu.portOut(0x24, 0x00);       // page the ROM out
    expect(m.cpu.portIn(0x26) & 0x02).toBe(0);
  });

  it('reflects the ALPHA LOCK key on bit 0', () => {
    expect(m.cpu.portIn(0x26) & 0x01).toBe(0);
    m.keyboard.handleKeyEvent('CapsLock', true);
    expect(m.cpu.portIn(0x26) & 0x01).toBe(1);
  });

  it('toggles the ALPHA LOCK latch via port 0x22', () => {
    expect(m.keyboard.alphaLockState).toBe(true);
    m.cpu.portOut(0x22, 0x00);
    expect(m.keyboard.alphaLockState).toBe(false);
    m.cpu.portIn(0x22);              // reads toggle too
    expect(m.keyboard.alphaLockState).toBe(true);
  });
});

describe('Einstein 256 registry entry', () => {
  it('classifies a dropped ROM by size, only while an Einstein is active', () => {
    expect(einsteinEntry.detectModelForRom?.(new Uint8Array(0x4000), 'einstein')).toBe('einstein-256');
    expect(einsteinEntry.detectModelForRom?.(new Uint8Array(0x2000), 'einstein-256')).toBe('einstein');
    expect(einsteinEntry.detectModelForRom?.(new Uint8Array(0x1000), 'einstein')).toBeNull();
    // 8/16KB collide with Spectrum ROMs — don't steal them from other machines.
    expect(einsteinEntry.detectModelForRom?.(new Uint8Array(0x4000), '48k')).toBeNull();
    expect(einsteinEntry.detectModelForRom?.(new Uint8Array(0x2000), 'hx-10')).toBeNull();
  });

  it('lists both models and sources the 16KB MOS 2.1 for the 256', () => {
    expect(einsteinEntry.models).toContain('einstein-256');
    const src = einsteinEntry.romSources('einstein-256');
    expect(src).toHaveLength(1);
    expect(src[0]).toContain('mos21.rom');
  });

  it('describes a 512×212 active area for the 256', () => {
    const d = einsteinEntry.descriptor('einstein-256');
    expect(d.screen.activeWidth).toBe(512);
    expect(d.screen.activeHeight).toBe(212);
    expect(d.screen.width).toBe(576);
    expect(d.screen.height).toBe(240);
  });
});

describe('Einstein 256 boot smoke', () => {
  it('runs the CPU and renders the display the ROM sets up', () => {
    const m = machine();
    const rom = new Uint8Array(0x4000);
    rom.set(SMOKE_ROM, 0);
    m.loadROM(rom);
    m.reset();

    const t0 = m.cpu.tStates;
    for (let i = 0; i < 3; i++) m.tick();
    expect(m.cpu.tStates).toBeGreaterThan(t0);   // CPU is running, not halted

    const vdp = m.vdp as V9938;
    expect(vdp.regs[1]).toBe(0x50);              // the ROM's R1 write landed
    expect(vdp.regs[7]).toBe(0x0F);              // fg 0 / bg 15
    // Active area top-left pixel: text cell 0, pattern all 0 → bg = white.
    const px32 = new Uint32Array(m.pixels.buffer);
    const active = (14 + 10) * 576 + 32;         // 192-line mode is vertically centred
    expect(px32[active]).toBe(vdp.pens[15]);
    expect(px32[14 * 576 + 32]).toBe(vdp.backdrop());
    expect(m.frameWidth).toBe(576);
    expect(m.frameHeight).toBe(240);
  });
});
