/**
 * Electron Plus 1 analogue port: the ADC0844 at &FC70 and the fire buttons in
 * the status register at &FC72.
 *
 * Expected values: ADC0844 data sheet (a write is the MUX address and starts a
 * conversion of about 40 µs; /INTR goes low at the end and high again when the
 * result is read); the Plus 1's status register (b6 /INTR, b5 joystick 2
 * fire, b4 joystick 1 fire, low while pressed); and the BBC-compatible stick
 * wiring (full left / full up read 255). The real-ROM test checks the whole
 * path through the Plus 1 Expansion ROM's ADVAL.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ElectronMachine } from '@/machines/electron/electron-machine.ts';

function fitted(): ElectronMachine {
  const m = new ElectronMachine('electron', null);
  m.setExpansions(true, false);
  m.reset();
  return m;
}

describe('Electron Plus 1 ADC0844', () => {
  it('converts the channel written, raising /INTR (status b6 low) after 40 µs', () => {
    const m = fitted();
    m.plus1.adc[2] = 0x3C;
    m.plus1.write(0xFC70, 0x06, 1000);              // single-ended channel 3 (MUX 6)
    expect(m.plus1.read(0xFC72, 1079)! & 0x40).toBe(0x40);   // still converting
    expect(m.plus1.read(0xFC72, 1080)! & 0x40).toBe(0x00);   // done, unread
    expect(m.plus1.read(0xFC70, 1081)).toBe(0x3C);
    expect(m.plus1.read(0xFC72, 1082)! & 0x40).toBe(0x40);   // reading it put /INTR high
    m.destroy();
  });

  it('a read during a conversion returns the previous result', () => {
    const m = fitted();
    m.plus1.adc[0] = 0x11;
    m.plus1.write(0xFC70, 0x04, 0);
    expect(m.plus1.read(0xFC70, 100)).toBe(0x11);
    m.plus1.adc[1] = 0x22;
    m.plus1.write(0xFC70, 0x05, 200);
    expect(m.plus1.read(0xFC70, 210)).toBe(0x11);
    expect(m.plus1.read(0xFC70, 280)).toBe(0x22);
    m.destroy();
  });

  it('maps player 1 to channels 1/2 (index 0/1) and player 2 to 3/4, left and up high', () => {
    const m = fitted();
    const joy = m.services.input.joystick!;
    joy.press('left', true, 'kempston', 0);
    joy.press('down', true, 'kempston', 0);
    joy.press('right', true, 'kempston', 1);
    joy.press('up', true, 'kempston', 1);
    expect(m.plus1.adc).toEqual([0xFF, 0x00, 0x00, 0xFF]);
    joy.press('down', false, 'kempston', 0);
    expect(m.plus1.adc[1]).toBe(0x80);
    joy.analog!('x', 0.5, 0);
    expect(m.plus1.adc[0]).toBe(Math.round(0.25 * 255));
    m.destroy();
  });

  it('fire buttons ground status b4 (joystick 1) and b5 (joystick 2)', () => {
    const m = fitted();
    const joy = m.services.input.joystick!;
    expect(m.memory.readByte(0xFC72) & 0x30).toBe(0x30);
    joy.press('fire', true, 'kempston', 0);
    expect(m.memory.readByte(0xFC72) & 0x30).toBe(0x20);
    joy.press('fire', true, 'kempston', 1);
    expect(m.memory.readByte(0xFC72) & 0x30).toBe(0x00);
    m.destroy();
  });

  it('has no joystick without the Plus 1, so the cursor keys stay the keyboard\'s', () => {
    const m = new ElectronMachine('electron', null);
    expect(m.services.input.joystick).toBeNull();
    m.setExpansions(true, false);
    expect(m.services.input.joystick).not.toBeNull();
    m.destroy();
  });
});

const CACHE = resolve(__dirname, '../mcp/.cache');
const haveRoms = ['electron-basic.rom', 'electron-os.rom', 'electron-plus1.rom']
  .every(r => existsSync(resolve(CACHE, r)));

describe.skipIf(!haveRoms)('Electron ADVAL through the Plus 1 Expansion ROM', () => {
  function boot(): ElectronMachine {
    const rom = new Uint8Array(0x8000);
    rom.set(readFileSync(resolve(CACHE, 'electron-basic.rom')), 0);
    rom.set(readFileSync(resolve(CACHE, 'electron-os.rom')), 0x4000);
    const m = new ElectronMachine('electron', null);
    m.loadROM(rom);
    m.setExpansions(true, false);
    m.installPlus1Rom(new Uint8Array(readFileSync(resolve(CACHE, 'electron-plus1.rom'))));
    m.reset();
    for (let i = 0; i < 250; i++) m.tick();
    return m;
  }
  function type(m: ElectronMachine, s: string): void {
    for (const ch of s) {
      const ev = {
        code: ch === '\n' ? 'Enter' : /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : '',
        key: ch === '\n' ? 'Enter' : ch, shift: false, ctrl: false, alt: false,
      };
      m.services.input.keyDown(ev);
      for (let i = 0; i < 3; i++) m.tick();
      m.services.input.keyUp(ev);
      for (let i = 0; i < 3; i++) m.tick();
    }
  }
  function intVar(m: ElectronMachine, name: string): number {
    const a = 0x400 + 4 * (name.charCodeAt(0) - 0x40);
    const r = m.memory.ram;
    return (r[a] | (r[a + 1] << 8) | (r[a + 2] << 16) | (r[a + 3] << 24)) >>> 0;
  }

  it('reads full left, centre, full down and joystick 1 fire', () => {
    const m = boot();
    const joy = m.services.input.joystick!;
    joy.press('left', true, 'kempston', 0);
    joy.press('fire', true, 'kempston', 0);
    joy.press('down', true, 'kempston', 1);
    for (let i = 0; i < 10; i++) m.tick();
    type(m, 'A%=ADVAL(1):B%=ADVAL(2):C%=ADVAL(4):D%=ADVAL(0) AND 255\n');
    for (let i = 0; i < 5; i++) m.tick();
    // The Plus 1 returns its 8-bit result as the high byte of ADVAL.
    expect(intVar(m, 'A')).toBe(0xFF00);
    expect(intVar(m, 'B')).toBe(0x8000);
    expect(intVar(m, 'C')).toBe(0);
    expect(intVar(m, 'D')).toBe(1);
    m.destroy();
  }, 60_000);
});
