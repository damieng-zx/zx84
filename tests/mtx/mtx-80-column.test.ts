import { describe, expect, it } from 'vitest';
import { MtxMachine } from '@/machines/mtx/mtx-machine.ts';
import {
  Mtx80ColumnCard, MTX_80_COLUMN_HEIGHT, MTX_80_COLUMN_WIDTH,
} from '@/machines/mtx/peripherals/fdx-80-column.ts';

function machine(): MtxMachine {
  const m = new MtxMachine('mtx512', null);
  m.reset();
  return m;
}

describe('Memotech FDX 80-column board ports', () => {
  it('latches character and attribute data on an address-low write strobe', () => {
    const m = machine();
    m.set80ColumnEnabled(true);

    m.cpu.portOut(0x31, 0xE3); // write, character+attribute, address bits 10..8 = 3
    m.cpu.portOut(0x32, 0x41);
    m.cpu.portOut(0x33, 0x27);
    m.cpu.portOut(0x30, 0x12);

    expect(m.column80.characters[0x312]).toBe(0x41);
    expect(m.column80.attributes[0x312]).toBe(0x27);

    m.cpu.portOut(0x31, 0x03); // read mode, same high address
    expect(m.cpu.portIn(0x32)).toBe(0x41);
    expect(m.cpu.portIn(0x33)).toBe(0x27);
  });

  it('routes the 6845 register selector and data through ports 38h and 39h', () => {
    const m = machine();
    m.set80ColumnEnabled(true);

    m.cpu.portOut(0x38, 12);
    m.cpu.portOut(0x39, 0x05);

    expect(m.cpu.portIn(0x38)).toBe(12);
    expect(m.cpu.portIn(0x39)).toBe(0x05);
    expect(m.column80.crtc.displayStart).toBe(0x0500);
  });

  it('leaves the expansion ports floating when the option is off', () => {
    const m = machine();

    m.cpu.portOut(0x31, 0xE0);
    m.cpu.portOut(0x32, 0x41);
    m.cpu.portOut(0x30, 0);

    expect(m.column80.characters[0]).toBe(0);
    expect(m.cpu.portIn(0x32)).toBe(0xFF);
    expect(m.cpu.portIn(0x38)).toBe(0xFF);
  });
});

describe('Memotech FDX 80-column rendering', () => {
  it('renders the reconstructed 8x10 alpha PROM and RGB attributes', () => {
    const card = new Mtx80ColumnCard();
    card.reset();
    card.characters[0] = 0x41; // A: row 1 is 00011000 in the documented PROM
    card.attributes[0] = 0x01; // red foreground, black background
    card.crtc.selectRegister(10);
    card.crtc.writeRegister(0x20); // cursor disabled

    card.renderFrame();

    const background = (1 * MTX_80_COLUMN_WIDTH + 0) * 4;
    const foreground = (1 * MTX_80_COLUMN_WIDTH + 3) * 4;
    expect(Array.from(card.pixels.subarray(background, background + 4)))
      .toEqual([0, 0, 0, 255]);
    expect(Array.from(card.pixels.subarray(foreground, foreground + 4)))
      .toEqual([255, 0, 0, 255]);
  });

  it('renders semigraphics from the character-code mosaic bits', () => {
    const card = new Mtx80ColumnCard();
    card.reset();
    card.characters[0] = 0x01; // top-left mosaic block
    card.attributes[0] = 0x82; // graphics mode, green foreground
    card.crtc.selectRegister(10);
    card.crtc.writeRegister(0x20);

    card.renderFrame();

    expect(Array.from(card.pixels.subarray(0, 4))).toEqual([0, 255, 0, 255]);
    expect(Array.from(card.pixels.subarray(4 * 4, 5 * 4))).toEqual([0, 0, 0, 255]);
  });

  it('switches the machine framebuffer and OCR to the 80x24 monitor', () => {
    const m = machine();
    m.set80ColumnEnabled(true);
    for (let i = 0; i < 5; i++) m.column80.characters[i] = 'HELLO'.charCodeAt(i);

    expect([m.frameWidth, m.frameHeight])
      .toEqual([MTX_80_COLUMN_WIDTH, MTX_80_COLUMN_HEIGHT]);
    expect(m.pixels).toBe(m.column80.pixels);
    expect(m.ocrScreenForMcp().split('\n')[0]).toBe('HELLO');

    m.set80ColumnEnabled(false);
    expect([m.frameWidth, m.frameHeight]).toEqual([320, 240]);
    expect(m.pixels).not.toBe(m.column80.pixels);
  });

  it('reads the persisted hardware option through the settings view', () => {
    const m = machine();

    m.applySettings({
      get<T>(key: string, fallback: T): T {
        return (key === 'mtx-80-column' ? true : fallback) as T;
      },
    });

    expect(m.column80.enabled).toBe(true);
  });

  it('reads the persisted 512 KiB RAM expansion through the settings view', () => {
    const m = machine();

    m.applySettings({
      get<T>(key: string, fallback: T): T {
        return (key === 'mtx-512k-ram' ? true : fallback) as T;
      },
    });

    expect(m.memory.ramExpansion512kEnabled).toBe(true);
    expect(m.memory.ramSizeBytes).toBe(576 * 1024);
    expect(m.ramExportBytes().filename).toBe('mtx512-ram-576k.bin');
  });

  it('forces the 80-column display while the CP/M hardware profile is enabled', () => {
    const m = machine();

    m.applySettings({
      get<T>(key: string, fallback: T): T {
        return (key === 'mtx-cpm' ? true : fallback) as T;
      },
    });

    expect(m.cpmSystemEnabled).toBe(true);
    expect(m.column80.enabled).toBe(true);

    m.applySettings({
      get<T>(_key: string, fallback: T): T {
        return fallback;
      },
    });

    expect(m.cpmSystemEnabled).toBe(false);
    expect(m.column80.enabled).toBe(false);
  });
});
