/**
 * The Plus 1's printer port: data latched and strobed by a write to &FC71, BUSY
 * on bit 7 of the status at &FC72 (Acorn Electron Plus 1 User Guide). The
 * length of BUSY belongs to the printer; the tests only hold it to "up after a
 * strobe, down again soon after, down before anything is sent".
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ElectronMachine } from '@/machines/electron/electron-machine.ts';
import { ElectronPlus1 } from '@/machines/electron/peripherals/plus1.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

describe('Plus 1 printer port', () => {
  it('reports ready (b7 clear) until something is sent', () => {
    const p = new ElectronPlus1();
    expect(p.read(0xFC72, 0)! & 0x80).toBe(0);
  });

  it('a write to &FC71 captures the byte and raises BUSY, which drops again', () => {
    const p = new ElectronPlus1();
    expect(p.write(0xFC71, 0x41, 1000)).toBe(true);
    expect(p.read(0xFC72, 1001)! & 0x80).toBe(0x80);
    expect(p.read(0xFC72, 1000 + 5000)! & 0x80).toBe(0);
    p.write(0xFC71, 0x0D, 20_000);
    expect(p.printed).toEqual([0x41, 0x0D]);
  });

  it('BUSY does not disturb the other status bits (ADC /INTR, fire buttons, b3-b0 high)', () => {
    const p = new ElectronPlus1();
    p.write(0xFC71, 0x41, 0);
    expect(p.read(0xFC72, 1)! & 0x7F).toBe(0x7F);
    p.fire[0] = true;
    expect(p.read(0xFC72, 1)! & 0x7F).toBe(0x6F);
  });

  it('a reset clears what was printed and BUSY', () => {
    const p = new ElectronPlus1();
    p.write(0xFC71, 0x41, 0);
    p.reset();
    expect(p.printed).toEqual([]);
    expect(p.read(0xFC72, 1)! & 0x80).toBe(0);
  });

  it('the output and BUSY survive a state save and load; a state from before BUSY existed loads ready', () => {
    const a = new ElectronPlus1();
    a.write(0xFC71, 0x48, 500);
    const w = new StateWriter();
    a.saveState(w);
    a.saveBusy(w);
    const b = new ElectronPlus1();
    const r = new StateReader(w.finish());
    b.loadState(r);
    b.loadBusy(r);
    expect(b.printed).toEqual([0x48]);
    expect(b.read(0xFC72, 501)! & 0x80).toBe(0x80);

    const old = new StateWriter();
    a.saveState(old);
    const c = new ElectronPlus1();
    const r2 = new StateReader(old.finish());
    c.loadState(r2);
    c.loadBusy(r2);
    expect(c.printed).toEqual([0x48]);
    expect(c.read(0xFC72, 501)! & 0x80).toBe(0);
  });
});

describe('Electron printer service', () => {
  it('offers nothing before the Plus 1 is fitted or anything is printed, then the text', () => {
    const m = new ElectronMachine('electron', null);
    expect(m.services.debug.printerExport!()).toBeNull();
    m.setExpansions(true, false);
    expect(m.services.debug.printerExport!()).toBeNull();
    m.memory.writeByte(0xFC71, 0x48);
    m.memory.writeByte(0xFC71, 0x49);
    const out = m.services.debug.printerExport!()!;
    expect(Array.from(out.data)).toEqual([0x48, 0x49]);
    expect(out.filename).toMatch(/\.txt$/);
    m.destroy();
  });
});

const CACHE = resolve(import.meta.dirname, '../mcp/.cache');
const haveRoms = ['electron-basic.rom', 'electron-os.rom', 'electron-plus1.rom']
  .every(r => existsSync(resolve(CACHE, r)));

describe.skipIf(!haveRoms)('Plus 1 printer through the real Plus 1 expansion ROM', () => {
  it('VDU 2 : PRINT "HELLO" sends the text to the port, waiting out BUSY between bytes', () => {
    const rom = new Uint8Array(0x8000);
    rom.set(readFileSync(resolve(CACHE, 'electron-basic.rom')), 0);
    rom.set(readFileSync(resolve(CACHE, 'electron-os.rom')), 0x4000);
    const m = new ElectronMachine('electron', null);
    m.loadROM(rom);
    m.setExpansions(true, false);
    m.installPlus1Rom(new Uint8Array(readFileSync(resolve(CACHE, 'electron-plus1.rom'))));
    m.reset();
    for (let i = 0; i < 250; i++) m.tick();

    // Every byte the driver sends must follow a read of the status port.
    let polled = false;
    let unpolled = 0;
    const read = m.plus1.read.bind(m.plus1);
    m.plus1.read = (addr, now) => { if (addr === 0xFC72) polled = true; return read(addr, now); };
    const write = m.plus1.write.bind(m.plus1);
    m.plus1.write = (addr, val, now) => {
      if (addr === 0xFC71) { if (!polled) unpolled++; polled = false; }
      return write(addr, val, now);
    };

    const type = (s: string): void => {
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
    };
    type('*FX5,1\n');                        // printer: parallel
    for (let i = 0; i < 30; i++) m.tick();
    type('VDU2\n');                          // printer on
    for (let i = 0; i < 30; i++) m.tick();
    type('PRINT "HELLO"\n');
    for (let i = 0; i < 200; i++) m.tick();
    type('VDU3\n');
    for (let i = 0; i < 30; i++) m.tick();

    const text = String.fromCharCode(...m.services.debug.printerExport!()!.data);
    expect(text).toContain('PRINT "HELLO"\r');     // the echoed command line
    expect(text).toContain('\rHELLO\r');           // the output of the statement
    expect(text).not.toContain('VDU2');            // printer was off until VDU 2 ran
    expect(unpolled).toBe(0);
    m.destroy();
  }, 60_000);

  it('a printer that stays BUSY holds the text back until it is ready', () => {
    const rom = new Uint8Array(0x8000);
    rom.set(readFileSync(resolve(CACHE, 'electron-basic.rom')), 0);
    rom.set(readFileSync(resolve(CACHE, 'electron-os.rom')), 0x4000);
    const m = new ElectronMachine('electron', null);
    m.loadROM(rom);
    m.setExpansions(true, false);
    m.installPlus1Rom(new Uint8Array(readFileSync(resolve(CACHE, 'electron-plus1.rom'))));
    m.reset();
    for (let i = 0; i < 250; i++) m.tick();
    const type = (s: string): void => {
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
    };
    type('*FX5,1\n');
    for (let i = 0; i < 30; i++) m.tick();
    m.plus1.printerBusyUntil = Infinity;                // out of paper, say
    type('VDU2\n');
    for (let i = 0; i < 100; i++) m.tick();
    expect(m.plus1.printed).toEqual([]);
    m.plus1.printerBusyUntil = 0;
    for (let i = 0; i < 100; i++) m.tick();
    expect(m.plus1.printed.length).toBeGreaterThan(0);
    m.destroy();
  }, 60_000);
});
