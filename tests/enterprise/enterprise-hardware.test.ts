/**
 * Enterprise 64/128 chip behaviour, checked against the hardware description
 * (EXOS 2.1 technical manual; the behaviour ep128emu and Clock Signal agree
 * on), not against this implementation.
 */

import { describe, it, expect } from 'vitest';
import { Nick, NICK_COLOURS } from '@/machines/enterprise/nick.ts';
import { Dave } from '@/machines/enterprise/dave.ts';
import { EnterpriseMemory } from '@/machines/enterprise/memory.ts';
import { EnterpriseMachine } from '@/machines/enterprise/enterprise-machine.ts';
import { buildHostFsRom, exosFileType, HostFileBundle, HostFsHandler } from '@/machines/enterprise/hostfs.ts';
import {
  blankFatImage, fatGeometry, fatRootDirectory, parseFatImage, serializeFatImage,
} from '@/media/floppy/fat-image.ts';

describe('Nick colour byte', () => {
  // Bits 7..0 are G0 R0 B0 G1 R1 B1 G2 R2: red and green three bits each,
  // blue two, most significant bit lowest in the byte.
  it('decodes the three red bits (0, 3, 6) to full red', () => {
    expect(NICK_COLOURS[0x49]).toBe(0xFF0000FF);
  });
  it('decodes the three green bits (1, 4, 7) to full green', () => {
    expect(NICK_COLOURS[0x92]).toBe(0xFF00FF00);
  });
  it('decodes the two blue bits (2, 5) to full blue', () => {
    expect(NICK_COLOURS[0x24]).toBe(0xFFFF0000);
  });
  it('treats bit 0 as the most significant red bit (4/7)', () => {
    expect(NICK_COLOURS[0x01] & 0xFF).toBe(Math.round(4 * 255 / 7));
  });
});

/** A one-block line parameter table at 0x0000 with the given fields. */
function nickWith(lpb: { mode: number; colours: number; lm: number; rm: number; ld1: number; ld2?: number; palette: number[] }): { nick: Nick; vram: Uint8Array } {
  const vram = new Uint8Array(0x10000);
  vram[0] = 0xFF;                                         // 1 line
  vram[1] = (lpb.colours << 5) | (lpb.mode << 1) | 0x01;  // RELOAD
  vram[2] = lpb.lm;
  vram[3] = lpb.rm;
  vram[4] = lpb.ld1 & 0xFF; vram[5] = lpb.ld1 >> 8;
  vram[6] = (lpb.ld2 ?? 0) & 0xFF; vram[7] = (lpb.ld2 ?? 0) >> 8;
  lpb.palette.forEach((c, i) => { vram[8 + i] = c; });
  const nick = new Nick(vram);
  return { nick, vram };
}

describe('Nick display slots', () => {
  const WHITE = NICK_COLOURS[0xFF], BLACK = NICK_COLOURS[0x00];

  it('draws two-colour PIXEL mode at 16 pixels a slot from two LD1 bytes', () => {
    const { nick, vram } = nickWith({ mode: 1, colours: 0, lm: 0x10, rm: 0x11, ld1: 0x1000, palette: [0x00, 0xFF] });
    vram[0x1000] = 0xF0;
    vram[0x1001] = 0x0F;
    nick.writePort(1, 0x49);                              // red border
    const row = new Uint32Array(768);
    nick.beginLine();
    nick.endLine(row, 0);
    const x = (0x10 - 7) * 16;                            // slot 7 is pixel 0
    expect([...row.subarray(x, x + 16)]).toEqual([
      WHITE, WHITE, WHITE, WHITE, BLACK, BLACK, BLACK, BLACK,
      BLACK, BLACK, BLACK, BLACK, WHITE, WHITE, WHITE, WHITE,
    ]);
    expect(row[x - 1]).toBe(NICK_COLOURS[0x49]);          // left of the margin
    expect(row[x + 16]).toBe(NICK_COLOURS[0x49]);         // right of it
  });

  it('takes four-colour pixel n from bits 7-n and 3-n', () => {
    // 0x81: pixel 0 = bit7 | bit3<<1 = 1; pixel 3 = bit4 | bit0<<1 = 2.
    const { nick, vram } = nickWith({ mode: 7, colours: 1, lm: 0x10, rm: 0x11, ld1: 0x2000, palette: [0x00, 0x49, 0x92, 0x24] });
    vram[0x2000] = 0x81;
    const row = new Uint32Array(768);
    nick.beginLine();
    nick.endLine(row, 0);
    const x = (0x10 - 7) * 16;
    // LPIXEL: one byte a slot, so four pixels of four output pixels each.
    expect(row[x]).toBe(NICK_COLOURS[0x49]);
    expect(row[x + 4]).toBe(NICK_COLOURS[0x00]);
    expect(row[x + 12]).toBe(NICK_COLOURS[0x92]);
  });

  it('colours ATTRIBUTE mode from the attribute byte: high nibble for 0 bits, low for 1 bits', () => {
    const palette = [0x00, 0x49, 0x92, 0x24, 0xFF, 0x00, 0x00, 0x00];
    const { nick, vram } = nickWith({ mode: 2, colours: 0, lm: 0x10, rm: 0x11, ld1: 0x3000, ld2: 0x4000, palette });
    vram[0x3000] = 0x14;                                  // paper 1 (red), ink 4 (white)
    vram[0x4000] = 0x80;                                  // first pixel ink, rest paper
    const row = new Uint32Array(768);
    nick.beginLine();
    nick.endLine(row, 0);
    const x = (0x10 - 7) * 16;
    expect(row[x]).toBe(NICK_COLOURS[0xFF]);
    expect(row[x + 2]).toBe(NICK_COLOURS[0x49]);
  });

  it('raises VINT for a block with bit 7 of the mode byte set', () => {
    const { nick, vram } = nickWith({ mode: 1, colours: 0, lm: 0x3F, rm: 0, ld1: 0, palette: [] });
    vram[1] |= 0x80;
    const seen: boolean[] = [];
    nick.onInterrupt = (on) => seen.push(on);
    nick.beginLine();
    expect(seen).toEqual([true]);
  });
});

describe('Dave timers', () => {
  /** T-states (at 4MHz) from acknowledging the sound latch until it sets again. */
  function soundPeriod(dave: Dave): number {
    dave.write(0x14, 0x03);                               // enable + clear
    let t = 0;
    while (!dave.irq && t < 10_000_000) { dave.advance(16, false); t += 16; }
    return t;
  }

  it('runs the 1kHz sound interrupt every 4000 T-states', () => {
    const dave = new Dave();
    dave.reset();
    dave.write(0x07, 0x00);                               // source: 1kHz
    soundPeriod(dave);                                    // align to an edge
    expect(soundPeriod(dave)).toBe(4000);
  });

  it('runs the 50Hz sound interrupt every 80000 T-states', () => {
    const dave = new Dave();
    dave.reset();
    dave.write(0x07, 0x20);                               // source: 50Hz
    soundPeriod(dave);
    expect(soundPeriod(dave)).toBe(80_000);
  });

  it('interrupts from tone channel 0 twice per cycle of its square wave', () => {
    // f = 99: the 250kHz counter reloads every 100 ticks (1600 T), so the
    // tone is 1250Hz and its divider runs out 2500 times a second.
    const dave = new Dave();
    dave.reset();
    dave.write(0x00, 99);
    dave.write(0x01, 0x00);
    dave.write(0x07, 0x40);                               // source: tone channel 0
    soundPeriod(dave);
    expect(soundPeriod(dave)).toBe(1600);
  });

  it('latches the 1Hz interrupt once a second', () => {
    const dave = new Dave();
    dave.reset();
    const period = (): number => {
      dave.write(0x14, 0x0C);
      let t = 0;
      while (!dave.irq && t < 10_000_000) { dave.advance(16, false); t += 16; }
      return t;
    };
    period();
    expect(period()).toBe(4_000_000);
  });

  it('drops /INT when the latch is cleared and cannot latch while disabled', () => {
    const dave = new Dave();
    dave.reset();
    dave.write(0x14, 0x10);                               // enable INT1 (VINT)
    dave.setInt1(true);
    dave.setInt1(false);                                  // falling edge latches
    expect(dave.irq).toBe(true);
    expect(dave.readInterrupts() & 0x20).toBe(0x20);
    dave.write(0x14, 0x30);                               // clear the latch
    expect(dave.irq).toBe(false);
    dave.write(0x14, 0x00);                               // disable
    dave.setInt1(true);
    dave.setInt1(false);
    expect(dave.irq).toBe(false);
  });
});

describe('Dave paging', () => {
  it('fits the 128\'s RAM at segments F8-FF with FC-FF as video RAM', () => {
    const mem = new EnterpriseMemory('ep128');
    expect(mem.firstRamSegment).toBe(0xF8);
    mem.setPage(1, 0xF8);
    mem.writeByte(0x4000, 0x5A);
    expect(mem.ram[0]).toBe(0x5A);
    expect(mem.videoPageMask & 0x02).toBe(0);
    mem.setPage(2, 0xFC);
    mem.writeByte(0x8000, 0xA5);
    expect(mem.videoRam[0]).toBe(0xA5);
    expect(mem.videoPageMask & 0x04).toBe(0x04);
  });

  it('has nothing below FC on the 64: those segments read 0xFF', () => {
    const mem = new EnterpriseMemory('ep64');
    mem.setPage(1, 0xF8);
    mem.writeByte(0x4000, 0x00);
    expect(mem.readByte(0x4000)).toBe(0xFF);
  });

  it('ignores writes to ROM', () => {
    const mem = new EnterpriseMemory('ep128');
    mem.loadRom(0x04, new Uint8Array(0x4000).fill(0x11), 1);
    mem.setPage(3, 0x04);
    mem.writeByte(0xC000, 0x22);
    expect(mem.readByte(0xC000)).toBe(0x11);
  });
});

describe('Enterprise keyboard ports', () => {
  it('reads the row selected through port B5 back from B5, active low', () => {
    const m = new EnterpriseMachine('ep128', null);
    m.services.input.keyDown({ code: 'KeyA', key: 'a', shift: false, ctrl: false, alt: false });
    m.cpu.portOut(0xB5, 0x01);                            // row 1: A is bit 6
    expect(m.cpu.portIn(0xB5)).toBe(0xBF);
    m.cpu.portOut(0xB5, 0x02);
    expect(m.cpu.portIn(0xB5)).toBe(0xFF);
  });

  it('puts the cursor keys (the built-in joystick) on row 7', () => {
    const m = new EnterpriseMachine('ep128', null);
    m.services.input.keyDown({ code: 'ArrowUp', key: 'ArrowUp', shift: false, ctrl: false, alt: false });
    m.cpu.portOut(0xB5, 0x07);
    expect(m.cpu.portIn(0xB5)).toBe(0xF7);                 // UP is bit 3
  });
});

describe('FILE: device ROM', () => {
  const { image, traps } = buildHostFsRom();

  it('starts with the EXOS_ROM signature', () => {
    expect(String.fromCharCode(...image.subarray(0, 8))).toBe('EXOS_ROM');
  });

  it('points EXOS (through page 1) at a descriptor naming FILE', () => {
    const chain = image[8] | (image[9] << 8);
    expect(chain & 0xC000).toBe(0x4000);
    const at = chain & 0x3FFF;
    const size = image[at] | (image[at + 1] << 8);
    // The name is the last field before XX_SIZE: length byte then text.
    expect(String.fromCharCode(...image.subarray(at - 4, at))).toBe('FILE');
    expect(image[at - 5]).toBe(4);
    // DD_TYPE (the first field XX_SIZE counts) must be zero.
    expect(image[at - size]).toBe(0);
  });

  it('traps every entry the dispatch table names', () => {
    const chain = (image[8] | (image[9] << 8)) & 0x3FFF;
    const size = image[chain] | (image[chain + 1] << 8);
    const tab = (image[chain - size + 3] | (image[chain - size + 4] << 8)) & 0x3FFF;
    const fns: number[] = [];
    for (let fn = 1; fn <= 12; fn++) {
      const entry = image[tab + fn * 2] | (image[tab + fn * 2 + 1] << 8);
      fns.push(traps.get(entry) ?? -1);
    }
    expect(fns).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('opens a file by its stem and reads it in blocks to the caller\'s memory', () => {
    const bundle = new HostFileBundle();
    bundle.add('GAME.PRG', Uint8Array.from([1, 2, 3]));
    const fs = new HostFsHandler();
    fs.bundle = bundle;
    const name = [4, ...'GAME'.split('').map(c => c.charCodeAt(0))];
    const user = new Uint8Array(0x10000);
    const mem = {
      read: (a: number) => (a >= 0x100 && a < 0x105 ? name[a - 0x100] : 0),
      userRead: (a: number) => user[a],
      userWrite: (a: number, v: number) => { user[a] = v; },
    };
    const r = { a: 7, b: 0, c: 0, d: 0x01, e: 0x00 };
    fs.perform(1, r, mem);
    expect(r.a).toBe(0);
    Object.assign(r, { a: 7, b: 0, c: 5, d: 0x20, e: 0x00 });
    fs.perform(6, r, mem);
    expect([...user.subarray(0x2000, 0x2003)]).toEqual([1, 2, 3]);
    expect(r.a).toBe(0xE4);                               // end of file, 2 short
    expect((r.b << 8) | r.c).toBe(2);
  });

  it('reads the module type from a 16-byte EXOS header', () => {
    expect(exosFileType(Uint8Array.from([0, 5, 6, 0, ...new Array(12).fill(0)]))).toBe(5);
    expect(exosFileType(Uint8Array.from([0xC3, 5, 6, 0, ...new Array(12).fill(0)]))).toBe(-1);
  });
});

describe('FAT sector images', () => {
  it('formats a blank 720K disk with the 3.5" DD parameter block', () => {
    const img = blankFatImage(80, 2, 9);
    const raw = serializeFatImage(img);
    expect(raw.length).toBe(737_280);
    expect(raw[21]).toBe(0xF9);                           // media descriptor
    expect(fatGeometry(raw)).toEqual({ tracks: 80, sides: 2, sectors: 9 });
    expect(fatRootDirectory(img)).toEqual([]);
  });

  it('lists root entries, skipping deleted ones and the volume label', () => {
    const raw = serializeFatImage(blankFatImage(80, 2, 9));
    const root = 7 * 512;                                 // 1 reserved + 2 x 3 FAT sectors
    const entry = (i: number, name: string, attr: number, size: number) => {
      const at = root + i * 32;
      raw.set([...name].map(c => c.charCodeAt(0)), at);
      raw[at + 11] = attr;
      raw[at + 28] = size & 0xFF; raw[at + 29] = size >> 8;
    };
    entry(0, 'VOLUME     ', 0x08, 0);
    entry(1, 'GAME    COM', 0x00, 300);
    entry(2, 'åOLD    BAS', 0x00, 10);
    const dir = fatRootDirectory(parseFatImage(raw)!);
    expect(dir.map(e => [e.name, e.size])).toEqual([['GAME.COM', 300]]);
  });
});
