/**
 * Apple II Plus integration tests — registration, memory map, soft switches,
 * keyboard, video addressing/attributes, OCR and the Disk II controller. No
 * system ROM is required: a tiny synthetic ROM drives the CPU checks, and the
 * disk tests read the nibble stream the controller produces.
 */

import { describe, it, expect } from 'vitest';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';
import { apple2Entry } from '@/machines/apple2/descriptor.ts';
import { Disk2 } from '@/machines/apple2/peripherals/disk2.ts';
import { createFrameIndicators } from '@/machines/machine.ts';
import { Apple2Cassette } from '@/machines/apple2/apple2-cassette.ts';
import { apple2KeyByte } from '@/machines/apple2/apple2-keyboard.ts';
import { hiresRowBase, textRowBase } from '@/machines/apple2/apple2-video.ts';
import type { Apple2VideoMode, Apple2VideoState } from '@/machines/apple2/apple2-video.ts';
import { apple2Char, ocrApple2Text } from '@/ocr/apple2.ts';
import { parseApple2Disk } from '@/media/floppy/apple2.ts';
import {
  APPLE2_BORDER_LEFT, APPLE2_BORDER_TOP, APPLE2_SCREEN_HEIGHT, APPLE2_SCREEN_WIDTH,
} from '@/machines/apple2/constants.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';

const key = (code: string, k: string, shift = false): HostKeyEvent =>
  ({ code, key: k, shift, ctrl: false, alt: false });

function make(): Apple2Machine { return new Apple2Machine('apple2-plus', null); }

/** Byte offset in the frame of narrow-mode dot `x` on picture line `y`. The 280-dot
 *  modes are drawn pixel-doubled, so a dot's first pixel is at 2x. */
const dotAt = (x: number, y: number): number =>
  ((APPLE2_BORDER_TOP + y) * APPLE2_SCREEN_WIDTH + APPLE2_BORDER_LEFT + 2 * x) * 4;

/** A 12K system ROM that stores $42 at $10 and loops. */
function makeRom(): Uint8Array {
  const rom = new Uint8Array(0x3000);
  rom.set([0xA9, 0x42, 0x85, 0x10, 0x4C, 0x04, 0xD0], 0x0000);
  rom[0x2FFC] = 0x00;   // reset vector -> $D000
  rom[0x2FFD] = 0xD0;
  return rom;
}

describe('apple2-plus registration', () => {
  it('is registered with the m6502 CPU family', () => {
    expect(apple2Entry.models).toContain('apple2-plus');
    const m = make();
    try {
      expect(m.kind).toBe('apple2');
      expect(m.descriptor.cpuFamily).toBe('m6502');
      expect(m.services.debug.ports).toBeNull();
      expect(m.services.tape).not.toBeNull();
      expect(m.services.disks).not.toBeNull();
    } finally {
      m.destroy();
    }
  });

  it('reports the 280×192 active area inside a bordered buffer', () => {
    const m = make();
    try {
      expect(m.frameWidth).toBe(APPLE2_SCREEN_WIDTH);
      expect(m.frameHeight).toBe(APPLE2_SCREEN_HEIGHT);
      expect(m.pixels.length).toBe(APPLE2_SCREEN_WIDTH * APPLE2_SCREEN_HEIGHT * 4);
    } finally {
      m.destroy();
    }
  });

  it('routes the media it advertises', () => {
    const m = make();
    try {
      const exts = m.services.media.accepts().map(t => t.ext);
      expect(exts).toEqual(expect.arrayContaining(['.dsk', '.do', '.po', '.wav']));
    } finally {
      m.destroy();
    }
  });
});

describe('apple2-plus memory map', () => {
  it('maps RAM below $C000, card ROM at $C600 and the system ROM at $D000', () => {
    const m = make();
    try {
      m.memory.ram[0x1234] = 0xAB;
      expect(m.memory.readByte(0x1234)).toBe(0xAB);

      m.memory.loadSlotRom(6, Uint8Array.from({ length: 256 }, (_, i) => i));
      expect(m.memory.readByte(0xC600)).toBe(0x00);
      expect(m.memory.readByte(0xC601)).toBe(0x01);
      expect(m.memory.readByte(0xC700)).toBe(0xFF);   // empty slot 7

      m.memory.loadRom(makeRom());
      expect(m.memory.readByte(0xD000)).toBe(0xA9);
      expect(m.memory.readByte(0xFFFF)).toBe(0x00);
    } finally {
      m.destroy();
    }
  });

  it('ignores writes to ROM windows', () => {
    const m = make();
    try {
      m.memory.loadRom(makeRom());
      m.memory.writeByte(0xC600, 0x99);
      m.memory.writeByte(0xD000, 0x99);
      expect(m.memory.readByte(0xD000)).toBe(0xA9);
    } finally {
      m.destroy();
    }
  });

  it('splits the 48K of RAM into three 16K banks', () => {
    const m = make();
    try {
      expect(m.memory.ramBankCount).toBe(3);
      m.memory.ram[0x8000] = 0x11;
      expect(m.memory.getRamBank(2)[0]).toBe(0x11);
      expect(m.memory.getRamBank(0)[0]).toBe(0x00);
    } finally {
      m.destroy();
    }
  });
});

describe('apple2-plus soft switches', () => {
  it('flips the display switches on $C050-$C057 reads and writes', () => {
    const m = make();
    try {
      m.memory.readByte(0xC050);              // graphics
      expect(m.textMode).toBe(false);
      m.memory.readByte(0xC051);              // text
      expect(m.textMode).toBe(true);

      m.memory.writeByte(0xC053, 0);          // mixed
      expect(m.mixed).toBe(true);
      m.memory.writeByte(0xC052, 0);          // full screen
      expect(m.mixed).toBe(false);

      m.memory.readByte(0xC055);              // page 2
      expect(m.page2).toBe(true);
      m.memory.readByte(0xC057);              // hires
      expect(m.hires).toBe(true);
      m.memory.readByte(0xC056);              // lores
      expect(m.hires).toBe(false);
    } finally {
      m.destroy();
    }
  });

  it('reads the keyboard on $C000 and clears on $C010', () => {
    const m = make();
    try {
      m.services.input.keyDown(key('KeyA', 'a'));
      expect(m.memory.readByte(0xC000)).toBe(0xC1);   // 'A' | strobe
      m.memory.readByte(0xC010);                       // clear strobe
      expect(m.memory.readByte(0xC000)).toBe(0x41);
      m.services.input.keyUp(key('KeyA', 'a'));
    } finally {
      m.destroy();
    }
  });

  it('toggles the speaker on $C030', () => {
    const m = make();
    try {
      expect(m.speaker.level).toBe(0);
      m.memory.readByte(0xC030);
      expect(m.speaker.level).toBe(1);
      m.memory.writeByte(0xC030, 0);
      expect(m.speaker.level).toBe(0);
    } finally {
      m.destroy();
    }
  });
});

/** A mono 8-bit PCM WAVE of `samples` bytes at `rate` Hz, alternating +/- each sample. */
function squareWav(rate: number, samples: number): Uint8Array {
  const out = new Uint8Array(44 + samples);
  const v = new DataView(out.buffer);
  const tag = (at: number, t: string) => { for (let i = 0; i < 4; i++) out[at + i] = t.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + samples, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  tag(36, 'data'); v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) out[44 + i] = (i & 1) ? 0x20 : 0xE0;
  return out;
}

describe('apple2-plus cassette deck', () => {
  it('plays from the start of the recording whenever play is pressed', () => {
    // The deck is driven off the machine's absolute clock; pressing play 10 s
    // into the session must start at 0 s of the tape, not 10 s into it.
    const deck = new Apple2Cassette();
    expect(deck.mountWav(squareWav(1000, 1000), 'tone.wav')).toBe(true);
    deck.advanceTo(10);                       // machine has been running, tape stopped
    expect(deck.progress).toBe(0);
    deck.playing = true;
    deck.advanceTo(10.1);                     // 0.1 s of a 1 s recording
    expect(deck.progress).toBeCloseTo(0.1, 2);
  });

  it('does not run on while paused', () => {
    const deck = new Apple2Cassette();
    deck.mountWav(squareWav(1000, 1000), 'tone.wav');
    deck.playing = true;
    deck.advanceTo(0.1);
    deck.playing = false;
    deck.advanceTo(0.5);                      // paused for 0.4 s
    deck.playing = true;
    deck.advanceTo(0.6);
    expect(deck.progress).toBeCloseTo(0.2, 2);
  });
});

describe('apple2 hardware options', () => {
  const settingsView = (values: Record<string, unknown>) =>
    ({ get: (key: string, fallback: unknown) => (key in values ? values[key] : fallback) }) as never;
  const prepared = (values: Record<string, unknown>, model: 'apple2' | 'apple2-plus' = 'apple2-plus') => {
    const m = new Apple2Machine(model, null);
    const requests = m.prepare(settingsView(values));
    return { m, requests };
  };

  it('fits the Disk II and language card by default', () => {
    const { m, requests } = prepared({});
    try {
      expect(requests.map(r => r.cacheKey)).toContain('apple2-disk2-rom');
      expect(m.services.disks.drives.map(d => d.id)).toEqual(['a', 'b']);
    } finally { m.destroy(); }
  });

  it('leaves the Disk II out: no card ROM, no drives, no slot-6 I/O', () => {
    const { m, requests } = prepared({ 'apple2-disk2': false });
    try {
      expect(requests.map(r => r.cacheKey)).not.toContain('apple2-disk2-rom');
      expect(m.services.disks.drives).toEqual([]);
      expect(m.memory.readByte(0xC0EC)).toBe(0xFF);          // an empty slot floats high
      expect(m.disk2.motorOn).toBe(false);
    } finally { m.destroy(); }
  });

  it('refuses to mount a disk when no controller is fitted', async () => {
    const { m } = prepared({ 'apple2-disk2': false });
    try {
      const res = await m.services.media.mount(new Uint8Array(35 * 4096), 'x.dsk', 'a');
      expect(res.ok).toBe(false);
    } finally { m.destroy(); }
  });

  it('routes unit:N mount targets to drive N+1 (unit 1 is the second drive)', async () => {
    // The Drive pane and the MCP `load` tool address drives as `unit:N`, counting
    // from 0; unit 1 must land in drive 2 and leave drive 1 alone.
    const { m } = prepared({});
    try {
      const raw = new Uint8Array(35 * 16 * 256);
      const second = await m.services.media.mount(raw, 'two.dsk', 'unit:1');
      expect(second.ok).toBe(true);
      expect(m.services.disks.drives.map(d => d.loaded)).toEqual([false, true]);
      expect(m.services.disks.drives[1].mediaName).toBe('two.dsk');
      const first = await m.services.media.mount(raw, 'one.dsk', 'unit:0');
      expect(first.ok).toBe(true);
      expect(m.services.disks.drives.map(d => d.mediaName)).toEqual(['one.dsk', 'two.dsk']);
    } finally { m.destroy(); }
  });

  it('refuses a mount into the second drive when only one is fitted', async () => {
    const { m } = prepared({ 'drive-count:apple2': 1 });
    try {
      const res = await m.services.media.mount(new Uint8Array(35 * 16 * 256), 'two.dsk', 'unit:1');
      expect(res.ok).toBe(false);
      expect(m.services.disks.drives.map(d => d.loaded)).toEqual([false]);
    } finally { m.destroy(); }
  });

  it('attaches one or two drives', () => {
    expect(prepared({ 'drive-count:apple2': 1 }).m.services.disks.drives.map(d => d.id)).toEqual(['a']);
    const { m } = prepared({ 'drive-count:apple2': 2 });
    try {
      expect(m.services.disks.drives.map(d => d.id)).toEqual(['a', 'b']);
    } finally { m.destroy(); }
  });

  it('only switches the language card in when it is fitted', () => {
    const rom = new Uint8Array(0x3000).fill(0xEA);
    for (const fitted of [true, false]) {
      const { m } = prepared({ 'apple2-langcard': fitted });
      try {
        m.memory.loadRom(rom);
        m.memory.readByte(0xC083); m.memory.readByte(0xC083);   // read RAM, write enabled
        m.memory.writeByte(0xD000, 0x42);
        expect(m.memory.readByte(0xD000), `fitted=${fitted}`).toBe(fitted ? 0x42 : 0xEA);
      } finally { m.destroy(); }
    }
  });
});

describe('apple ][ (original)', () => {
  it('is registered alongside the ][+', () => {
    expect(apple2Entry.models).toEqual(['apple2', 'apple2-plus', 'apple2e', 'apple2e-enhanced', 'apple2c']);
    expect(apple2Entry.romSources('apple2')).toEqual(['apple2/apple2.rom']);
    expect(apple2Entry.romSources('apple2-plus')).toEqual(['apple2/apple2plus.rom']);
  });

  it('boots a disk by jumping to the Disk II boot ROM, as C600G would', () => {
    // The original Monitor has no Autostart: a reset lands in the Monitor, not
    // in a slot scan, so booting from the media menu must do the typing itself.
    const m = new Apple2Machine('apple2', null);
    try {
      m.bootDisc();
      expect(m.cpu.pc).toBe(0xC600);
    } finally { m.destroy(); }
  });

  it('lets the ][+ Autostart ROM do the booting instead', () => {
    const m = new Apple2Machine('apple2-plus', null);
    try {
      m.loadROM(makeRom());
      m.bootDisc();
      expect(m.cpu.pc).toBe(0xD000);          // straight to the reset vector in ROM
    } finally { m.destroy(); }
  });

  it('does not touch the warm-start vector the Autostart ROM would use', () => {
    const m = new Apple2Machine('apple2', null);
    try {
      m.memory.ram[0x3F2] = 0x12;
      m.reset();
      expect(m.memory.ram[0x3F2]).toBe(0x12);
    } finally { m.destroy(); }
  });
});

describe('apple2-plus language card', () => {
  const rd = (m: Apple2Machine, a: number) => m.memory.readByte(a);
  const wr = (m: Apple2Machine, a: number, v: number) => m.memory.writeByte(a, v);
  const machineWithRom = (): Apple2Machine => {
    const m = make();
    const rom = new Uint8Array(0x3000).fill(0xEA);   // ROM reads as $EA everywhere
    m.memory.loadRom(rom);
    return m;
  };

  it('reads the system ROM and ignores writes until the card is switched in', () => {
    const m = machineWithRom();
    try {
      wr(m, 0xD000, 0x55);
      expect(rd(m, 0xD000)).toBe(0xEA);
      expect(rd(m, 0xFFFF)).toBe(0xEA);
    } finally { m.destroy(); }
  });

  it('needs two consecutive reads of an odd switch to enable writing', () => {
    const m = machineWithRom();
    try {
      rd(m, 0xC081);                                  // one read: not enough
      wr(m, 0xE000, 0x66);
      rd(m, 0xC080);                                  // read RAM, write protected
      expect(rd(m, 0xE000)).toBe(0x00);               // the write was ignored
      rd(m, 0xC081); wr(m, 0xC081, 0);                // a write access restarts the count
      rd(m, 0xC081);
      wr(m, 0xE000, 0x66);
      rd(m, 0xC080);
      expect(rd(m, 0xE000)).toBe(0x00);
      rd(m, 0xC081); rd(m, 0xC081);                   // now properly enabled
      wr(m, 0xE000, 0x66);
      expect(rd(m, 0xE000)).toBe(0xEA);               // $C081 still reads ROM
      rd(m, 0xC080);
      expect(rd(m, 0xE000)).toBe(0x66);
    } finally { m.destroy(); }
  });

  it('has two $D000 banks sharing one $E000 area', () => {
    const m = machineWithRom();
    try {
      rd(m, 0xC083); rd(m, 0xC083);                   // bank 2, read+write
      wr(m, 0xD000, 0x22); wr(m, 0xE123, 0x99);
      rd(m, 0xC08B); rd(m, 0xC08B);                   // bank 1, read+write
      wr(m, 0xD000, 0x11);
      expect(rd(m, 0xD000)).toBe(0x11);
      expect(rd(m, 0xE123)).toBe(0x99);               // common to both banks
      rd(m, 0xC080);                                  // bank 2
      expect(rd(m, 0xD000)).toBe(0x22);
      rd(m, 0xC088);                                  // bank 1
      expect(rd(m, 0xD000)).toBe(0x11);
    } finally { m.destroy(); }
  });

  it('goes back to reading ROM on reset but keeps the RAM contents', () => {
    const m = machineWithRom();
    try {
      rd(m, 0xC083); rd(m, 0xC083);
      wr(m, 0xD800, 0x77);
      m.reset();
      expect(rd(m, 0xD800)).toBe(0xEA);
      rd(m, 0xC080);
      expect(rd(m, 0xD800)).toBe(0x77);
    } finally { m.destroy(); }
  });
});

describe('apple2 Videx Videoterm', () => {
  const fitted = (model: 'apple2' | 'apple2-plus' = 'apple2-plus') => {
    const m = new Apple2Machine(model, null);
    const requests = m.prepare({ get: (key: string, fallback: unknown) => (key === 'apple2-80col' ? true : fallback) } as never);
    return { m, requests };
  };
  const crtc = (m: Apple2Machine, reg: number, value: number) => {
    m.memory.writeByte(0xC0B0, reg);                  // address register
    m.memory.writeByte(0xC0B1, value);                // data register
  };
  const dotAt = (m: Apple2Machine, x: number, y: number): number => {
    const at = (y * APPLE2_SCREEN_WIDTH + APPLE2_BORDER_LEFT + x) * 4;
    return m.pixels[at];
  };

  it('is fitted in slot 3 on the ][ and ][+ and asks for its ROMs', () => {
    for (const model of ['apple2', 'apple2-plus'] as const) {
      const { m, requests } = fitted(model);
      try {
        expect(m.memory.cards[3]).toBe(m.videx);
        expect(requests.map(r => r.cacheKey)).toEqual(expect.arrayContaining(['apple2-videx-rom', 'apple2-videx-chargen']));
      } finally { m.destroy(); }
    }
    const plain = new Apple2Machine('apple2-plus', null);
    plain.prepare({ get: (_k: string, f: unknown) => f } as never);
    try { expect(plain.videx).toBeNull(); } finally { plain.destroy(); }
  });

  it('serves its firmware at $C3xx and, once selected, at $C800', () => {
    const { m } = fitted();
    try {
      m.videx!.loadRom(new Uint8Array(0x400).map((_, i) => i & 0xFF));
      expect(m.memory.readByte(0xC800)).toBe(0xFF);   // nothing owns $C800 yet
      expect(m.memory.readByte(0xC305)).toBe(0x05);   // the card's page
      expect(m.memory.readByte(0xC8F0)).toBe(0xF0);   // now selected: firmware ROM
      expect(m.memory.readByte(0xCBFF)).toBe(0xFF);   // last byte of the 1K image (0x3FF & 0xFF)
      m.memory.readByte(0xCFFF);                      // releases the area
      expect(m.memory.readByte(0xC8F0)).toBe(0xFF);
    } finally { m.destroy(); }
  });

  it('shows a 512-byte window onto its 2K RAM, bank chosen by the address bits', () => {
    const { m } = fitted();
    try {
      m.memory.readByte(0xC300);                      // select the card's expansion area
      m.memory.readByte(0xC0B0);                      // bank 0
      m.memory.writeByte(0xCC00, 0x11);
      m.memory.readByte(0xC0B4);                      // bank 1 (address bit 2)
      m.memory.writeByte(0xCC00, 0x22);
      m.memory.readByte(0xC0BC);                      // bank 3
      m.memory.writeByte(0xCDFF, 0x33);
      expect(m.videx!.ram[0x000]).toBe(0x11);
      expect(m.videx!.ram[0x200]).toBe(0x22);
      expect(m.videx!.ram[0x600 + 0x1FF]).toBe(0x33);
      m.memory.readByte(0xC0B0);
      expect(m.memory.readByte(0xCC00)).toBe(0x11);
    } finally { m.destroy(); }
  });

  it('shows its own output only once the firmware has programmed 80 columns', () => {
    const { m } = fitted();
    try {
      expect(m.videx!.view.active).toBe(false);
      crtc(m, 1, 80);                                 // R1: horizontal displayed
      expect(m.videx!.view.active).toBe(true);
      crtc(m, 12, 0x01); crtc(m, 13, 0x40);           // start address
      crtc(m, 14, 0x00); crtc(m, 15, 0x02);           // cursor
      expect(m.videx!.view.start).toBe(0x140);
      expect(m.videx!.view.cursor).toBe(2);
      m.reset();
      expect(m.videx!.view.active).toBe(false);
    } finally { m.destroy(); }
  });

  it('draws 80 columns of 7 by 9 characters with inverse video and a cursor', () => {
    const { m } = fitted();
    try {
      const font = new Uint8Array(0x800);
      for (let r = 0; r < 9; r++) font['A'.charCodeAt(0) * 16 + r] = 0x80;   // leftmost dot of every row
      m.videx!.loadFont(font);
      m.videx!.ram[0] = 0x41;                         // 'A'
      m.videx!.ram[1] = 0xC1;                         // inverse 'A'
      crtc(m, 1, 80);
      crtc(m, 10, 0x00 | 0x20);                       // cursor hidden
      m.video.render({
        ram: m.memory.ram, textMode: true, mixed: false, page2: false, hires: false,
        charset: m.charset, flashPhase: false, mode: 'mono', videx: m.videx!.view,
      } as never);
      const top = (240 - 24 * 9) >> 1;
      expect(dotAt(m, 0, top)).toBe(0xFF);            // 'A': leftmost dot lit
      expect(dotAt(m, 1, top)).toBe(0x00);
      expect(dotAt(m, 7, top)).toBe(0x00);            // inverse 'A': leftmost dark, the rest lit
      expect(dotAt(m, 8, top)).toBe(0xFF);
      expect(dotAt(m, 7 * 79, top + 9 * 23)).toBe(0x00);   // blank cell at the end (code 0, font row 0)
    } finally { m.destroy(); }
  });

  it('reads its screen for OCR', () => {
    const { m } = fitted();
    try {
      m.videx!.ram[0] = 0x48; m.videx!.ram[1] = 0x49;      // "HI"
      crtc(m, 1, 80);
      const text = m.ocrScreenForMcp();
      expect(text.split('\n')[0]).toBe('HI');
    } finally { m.destroy(); }
  });
});

describe('apple2 Mockingboard', () => {
  const fitted = () => {
    const m = new Apple2Machine('apple2-plus', null);
    m.prepare({ get: (key: string, fallback: unknown) => (key === 'apple2-mockingboard' ? true : fallback) } as never);
    return m;
  };
  /** One AY bus cycle through VIA `via` (0 = $C400, 1 = $C480): latch the register, then write it. */
  const ayWrite = (m: Apple2Machine, via: 0 | 1, reg: number, value: number) => {
    const base = 0xC400 + via * 0x80;
    m.memory.writeByte(base + 0x02, 0x07);          // DDRB: BC1, BDIR, RESET are outputs
    m.memory.writeByte(base + 0x03, 0xFF);          // DDRA: the data bus
    m.memory.writeByte(base + 0x01, reg);           // register number on the bus
    m.memory.writeByte(base + 0x00, 0x07);          // BDIR=1 BC1=1: latch address
    m.memory.writeByte(base + 0x00, 0x04);          // inactive
    m.memory.writeByte(base + 0x01, value);
    m.memory.writeByte(base + 0x00, 0x06);          // BDIR=1 BC1=0: write
    m.memory.writeByte(base + 0x00, 0x04);
  };

  it('is only present when the option fits it', () => {
    const plain = new Apple2Machine('apple2-plus', null);
    plain.prepare({ get: (_k: string, f: unknown) => f } as never);
    try { expect(plain.mockingboard).toBeNull(); } finally { plain.destroy(); }
    const m = fitted();
    try {
      expect(m.mockingboard).not.toBeNull();
      expect(m.memory.cards[4]).toBe(m.mockingboard);
    } finally { m.destroy(); }
  });

  it('programs each AY through its own VIA', () => {
    const m = fitted();
    try {
      ayWrite(m, 0, 0, 0x34);                        // first AY, tone A fine
      ayWrite(m, 1, 0, 0x56);                        // second AY at $C480
      expect(m.mockingboard!.ay[0].getRegisters()[0]).toBe(0x34);
      expect(m.mockingboard!.ay[1].getRegisters()[0]).toBe(0x56);
    } finally { m.destroy(); }
  });

  it('reads an AY register back over the bus', () => {
    const m = fitted();
    try {
      ayWrite(m, 0, 7, 0x38);
      m.memory.writeByte(0xC403, 0x00);              // port A becomes an input
      m.memory.writeByte(0xC401, 0x00);
      m.memory.writeByte(0xC400, 0x07);              // latch register 7 (port A still driving 0..)
      m.memory.writeByte(0xC403, 0xFF);
      m.memory.writeByte(0xC401, 0x07);
      m.memory.writeByte(0xC400, 0x07);
      m.memory.writeByte(0xC400, 0x04);
      m.memory.writeByte(0xC403, 0x00);              // release the data bus
      m.memory.writeByte(0xC400, 0x05);              // BDIR=0 BC1=1: the chip drives the bus
      expect(m.memory.readByte(0xC401)).toBe(0x38);
    } finally { m.destroy(); }
  });

  it('resets the AY when the reset line goes low', () => {
    const m = fitted();
    try {
      ayWrite(m, 0, 8, 0x0F);
      expect(m.mockingboard!.ay[0].getRegisters()[8]).toBe(0x0F);
      m.memory.writeByte(0xC400, 0x00);              // RESET pin low
      expect(m.mockingboard!.ay[0].getRegisters()[8]).toBe(0);
    } finally { m.destroy(); }
  });

  it('raises IRQ from a VIA timer and clears it when the timer is read', () => {
    const m = fitted();
    try {
      m.memory.writeByte(0xC40E, 0xC0);              // IER: enable T1
      m.memory.writeByte(0xC404, 0x10);              // T1 latch low
      m.memory.writeByte(0xC405, 0x00);              // T1 high: start counting 16 cycles
      expect(m.mockingboard!.irq).toBe(false);
      m.mockingboard!.tick(40);
      expect(m.mockingboard!.irq).toBe(true);
      m.memory.readByte(0xC404);                     // reading T1 low acknowledges
      expect(m.mockingboard!.irq).toBe(false);
    } finally { m.destroy(); }
  });

  it('plays the first AY on the left channel and the second on the right', () => {
    const m = fitted();
    try {
      ayWrite(m, 0, 0, 0x20); ayWrite(m, 0, 1, 0x00);   // tone A period
      ayWrite(m, 0, 7, 0x3E);                           // tone A on, noise off
      ayWrite(m, 0, 8, 0x0F);                           // full volume
      let left = 0, right = 0;
      for (let i = 0; i < 2000; i++) {
        const s = m.mockingboard!.generateSampleStereo();
        left += Math.abs(s.left); right += Math.abs(s.right);
      }
      expect(left).toBeGreaterThan(10);
      expect(right).toBe(0);
    } finally { m.destroy(); }
  });
});

describe('apple2 paddles and joystick', () => {
  /** How many counts a PREAD loop would measure for paddle `n`. */
  const measure = (m: Apple2Machine, n: number): number => {
    m.memory.readByte(0xC070);                       // trigger the timers
    let counts = 0;
    for (;;) {
      if ((m.memory.readByte(0xC064 + n) & 0x80) === 0) return counts;
      m.cpu.tStates += 11;                           // one pass of the ROM's PREAD loop
      if (++counts > 300) return counts;
    }
  };

  it('times a centred paddle at about half scale', () => {
    const m = make();
    try {
      const counts = measure(m, 0);
      expect(counts).toBeGreaterThan(125);
      expect(counts).toBeLessThan(131);
    } finally { m.destroy(); }
  });

  it('moves with a joystick: left/right and up/down drive the two axes to the ends', () => {
    const m = make();
    try {
      const joy = m.services.input.joystick!;
      joy.press('left', true, 'fixed', 0);
      expect(measure(m, 0)).toBeLessThan(5);
      joy.press('left', false, 'fixed', 0);
      joy.press('right', true, 'fixed', 0);
      expect(measure(m, 0)).toBeGreaterThan(250);
      joy.press('right', false, 'fixed', 0);
      joy.press('down', true, 'fixed', 0);
      expect(measure(m, 1)).toBeGreaterThan(250);      // Y is the second paddle
      expect(measure(m, 0)).toBeGreaterThan(125);      // X stayed centred
      joy.press('down', false, 'fixed', 0);
      joy.press('up', true, 'fixed', 0);
      expect(measure(m, 1)).toBeLessThan(5);
    } finally { m.destroy(); }
  });

  it('puts player two on paddles 2 and 3', () => {
    const m = make();
    try {
      m.services.input.joystick!.press('right', true, 'fixed', 1);
      expect(measure(m, 2)).toBeGreaterThan(250);
      expect(measure(m, 0)).toBeLessThan(131);
    } finally { m.destroy(); }
  });

  it('reads the fire buttons as push buttons 0-2', () => {
    const m = make();
    try {
      const joy = m.services.input.joystick!;
      joy.press('fire', true, 'fixed', 0);
      expect(m.memory.readByte(0xC061) & 0x80).toBe(0x80);
      expect(m.memory.readByte(0xC062) & 0x80).toBe(0);
      joy.press('fire2', true, 'fixed', 0);
      expect(m.memory.readByte(0xC062) & 0x80).toBe(0x80);
      m.services.input.releaseAll();
      expect(m.memory.readByte(0xC061) & 0x80).toBe(0);
    } finally { m.destroy(); }
  });

  it('reads full scale and no buttons when nothing is plugged in', () => {
    const m = new Apple2Machine('apple2-plus', null);
    m.prepare({ get: (key: string, fallback: unknown) => (key === 'apple2-joystick' ? false : fallback) } as never);
    try {
      m.services.input.joystick!.press('fire', true, 'fixed', 0);
      expect(m.memory.readByte(0xC061) & 0x80).toBe(0);
      expect(measure(m, 0)).toBeGreaterThan(250);
    } finally { m.destroy(); }
  });
});

describe('apple2-plus game port', () => {
  it('reads the pushbuttons as released (bit 7 clear)', () => {
    // A pushbutton input is high only while its switch is closed; with nothing
    // attached $C061-$C063 must not read as a held button.
    const m = make();
    try {
      for (const addr of [0xC061, 0xC062, 0xC063]) {
        expect(m.memory.readByte(addr) & 0x80, `$${addr.toString(16)}`).toBe(0);
      }
    } finally {
      m.destroy();
    }
  });
});

describe('apple2-plus KEY indicator', () => {
  const keyLed = (m: Apple2Machine): number => {
    const out = createFrameIndicators();
    m.services.probe.sample(out);
    return out.keyboard;
  };

  it('lights when the program polls the keyboard port, not when a key is pressed', () => {
    const m = make();
    try {
      expect(keyLed(m)).toBe(0);
      m.keyboard.setKey(0x41, true);                 // a key goes down; nothing has looked yet
      expect(keyLed(m)).toBe(0);
      m.memory.readByte(0xC000);                     // the program polls $C000
      expect(keyLed(m)).toBeGreaterThan(0);
    } finally {
      m.destroy();
    }
  });

  it('clears with the next frame when nothing polls', () => {
    const m = make();
    try {
      m.loadROM(makeRom());                          // loops on $10 without touching the keyboard
      m.reset();
      m.memory.readByte(0xC000);
      expect(keyLed(m)).toBeGreaterThan(0);
      m.tick();
      expect(keyLed(m)).toBe(0);
    } finally {
      m.destroy();
    }
  });
});

describe('apple2-plus keyboard mapping', () => {
  it('encodes the classic II+ shift pairs and control chars', () => {
    expect(apple2KeyByte(key('KeyA', 'a'))).toBe(0x41);           // upper-case only
    expect(apple2KeyByte(key('Digit1', '1'))).toBe(0x31);
    expect(apple2KeyByte(key('Digit1', '!', true))).toBe(0x21);   // shift+1 = !
    expect(apple2KeyByte(key('Minus', '-'))).toBe(0x2D);
    expect(apple2KeyByte(key('Minus', '_', true))).toBe(0x5F);    // shift+- = _
    expect(apple2KeyByte(key('Equal', '+', true))).toBe(0x2B);
    expect(apple2KeyByte(key('Semicolon', ';'))).toBe(0x3B);
    expect(apple2KeyByte(key('Quote', '"', true))).toBe(0x22);
    expect(apple2KeyByte(key('Enter', 'Enter'))).toBe(0x0D);
    expect(apple2KeyByte(key('Backspace', 'Backspace'))).toBe(0x08);
    expect(apple2KeyByte(key('Space', ' '))).toBe(0x20);
    expect(apple2KeyByte({ code: 'KeyC', key: 'c', shift: false, ctrl: true, alt: false }))
      .toBe(0x03);                                                // Ctrl-C
    expect(apple2KeyByte(key('ShiftLeft', 'Shift'))).toBeNull();
  });
});

describe('apple2-plus video addressing', () => {
  const view = (
    m: Apple2Machine, mode: Apple2VideoMode, over: Partial<Apple2VideoState> = {},
  ): Apple2VideoState => ({
    ram: m.memory.ram, textMode: false, mixed: false, page2: false,
    hires: false, charset: m.charset, flashPhase: false, mode, ...over,
  });

  it('walks text/lores rows in the interleaved order', () => {
    // Row 0 at $400; row 1 is +$80; row 8 wraps to the next 40-byte block.
    expect(textRowBase('page1', 0)).toBe(0x400);
    expect(textRowBase('page1', 1)).toBe(0x480);
    expect(textRowBase('page1', 8)).toBe(0x428);
    expect(textRowBase('page2', 0)).toBe(0x800);
  });

  it('walks hires scanlines in the 8-line-interleaved order', () => {
    expect(hiresRowBase('page1', 0)).toBe(0x2000);
    expect(hiresRowBase('page1', 1)).toBe(0x2400);
    expect(hiresRowBase('page1', 8)).toBe(0x2080);
    expect(hiresRowBase('page1', 64)).toBe(0x2028);
    expect(hiresRowBase('page2', 0)).toBe(0x4000);
  });

  it('renders lores blocks with the low/high nibbles as top/bottom pens', () => {
    const m = make();
    try {
      m.charset.load(new Uint8Array(2048));
      m.memory.ram[0x400] = 0x0F;   // low nibble F (white) top, high 0 (black) bottom
      m.video.render(view(m, 'mono'));
      const red = (x: number, y: number) => m.pixels[dotAt(x, y)];
      expect(red(2, 0)).toBe(0xFF);   // top block, white pen
      expect(red(2, 4)).toBe(0x00);   // bottom block, black pen
    } finally {
      m.destroy();
    }
  });

  it('treats bit 0 as the leftmost hi-res pixel', () => {
    // The ROM's HPLOT mask table puts x=0 in bit 0 — Applesoft's `HPLOT 0,0`
    // writes $01 and `HPLOT 6,0` writes $40 — so the seven pixels run bit 0 …
    // bit 6 left to right.
    const m = make();
    try {
      m.charset.load(new Uint8Array(2048));
      const red = (x: number) => m.pixels[dotAt(x, 0)];
      expect(m.memory.ram[0x2000] ?? 0).toBe(0);
      m.memory.ram[0x2000] = 0x01;   // bit 0 set -> the leftmost pixel lights
      m.video.render(view(m, 'mono', { hires: true }));
      expect(red(0)).toBe(0xFF);
      expect(red(6)).toBe(0x00);
      m.memory.ram[0x2000] = 0x40;   // bit 6 set -> the byte's rightmost pixel
      m.video.render(view(m, 'mono', { hires: true }));
      expect(red(6)).toBe(0xFF);
      expect(red(0)).toBe(0x00);
    } finally {
      m.destroy();
    }
  });

  it('draws each 280-dot pixel as two frame pixels', () => {
    // The frame is 560 wide so 80-column text and double hi-res fit; the narrow
    // modes are doubled horizontally, so one lit dot is exactly two lit pixels.
    const m = make();
    try {
      m.charset.load(new Uint8Array(2048));
      m.memory.ram[0x2000] = 0x02;                       // dot 1 only
      m.video.render(view(m, 'mono', { hires: true }));
      const lit = (x: number) => m.pixels[dotAt(0, 0) + x * 4] === 0xFF;
      expect([0, 1, 2, 3, 4, 5].map(lit)).toEqual([false, false, true, true, false, false]);
    } finally {
      m.destroy();
    }
  });

  it('decodes composite colour: alternating bytes make a solid line', () => {
    // A byte is seven dots — 3.5 chroma cycles — so the phase slips 180° at
    // every byte boundary. A single repeated byte therefore beats green/violet
    // per byte; the documented recipe for a solid line is to alternate the
    // pair. "$2A $55 $2A $55" is 14 green pixels.
    const m = make();
    try {
      m.charset.load(new Uint8Array(2048));
      const fill = (b0: number | null, b1 = 0) => {
        for (let i = 0; i < 40; i++) m.memory.ram[0x2000 + i] = b0 === null ? b1 : ((i & 1) ? b1 : b0);
        m.video.render(view(m, 'ntsc', { hires: true }));
      };
      const sample = (x: number) => {
        const at = dotAt(x, 0);
        return [m.pixels[at], m.pixels[at + 1], m.pixels[at + 2]];
      };
      fill(0x2A, 0x55);
      for (const x of [20, 60, 100, 140, 180]) {
        const [r, g, b] = sample(x);
        expect(g, `green at ${x}`).toBeGreaterThan(180);
        expect(r, `green at ${x}`).toBeLessThan(60);
        expect(b, `green at ${x}`).toBeLessThan(60);
      }
      fill(null, 0x7F);                                   // white is phase-free
      expect(sample(140).every(v => v > 240)).toBe(true);
      fill(null, 0x00);                                   // so is black
      expect(sample(140)).toEqual([0, 0, 0]);
    } finally {
      m.destroy();
    }
  });

  it('PAL colour is stable from line to line', () => {
    // PAL's per-line V inversion is undone by the decoder, so identical
    // scanlines of a coloured pattern must decode identically — no striping —
    // and the pattern must still carry colour (not collapse to grey).
    const m = make();
    try {
      m.charset.load(new Uint8Array(2048));
      for (const base of [0x2000, 0x2400, 0x2800]) {        // hires lines 0, 1, 2
        for (let i = 0; i < 40; i++) m.memory.ram[base + i] = (i & 1) ? 0x55 : 0x2A;
      }
      m.video.render(view(m, 'pal', { hires: true }));
      const sample = (line: number) => {
        const at = dotAt(140, line);
        return [m.pixels[at], m.pixels[at + 1], m.pixels[at + 2]];
      };
      expect(sample(1)).toEqual(sample(0));
      expect(sample(2)).toEqual(sample(0));
      const [r, g, b] = sample(1);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(40);
    } finally {
      m.destroy();
    }
  });

  it('flat text areas are pure black/white in the composite modes', () => {
    // Runs of identical dots carry no chroma, so an inverse (all-lit) cell is
    // exactly white in its interior and the blank cell beside it exactly black.
    const m = make();
    try {
      m.charset.load(new Uint8Array(2048));
      m.memory.ram[0x400] = 0x00;     // inverse blank: every dot lit
      m.memory.ram[0x401] = 0x80;     // normal blank: every dot dark
      m.memory.ram[0x402] = 0x80;
      for (const mode of ['ntsc', 'pal'] as const) {
        m.video.render(view(m, mode, { textMode: true }));
        const lit = dotAt(3, 3), dark = dotAt(14 + 3, 3);   // cell 2, clear of the lit edge
        expect([m.pixels[lit], m.pixels[lit + 1], m.pixels[lit + 2]], mode).toEqual([255, 255, 255]);
        expect([m.pixels[dark], m.pixels[dark + 1], m.pixels[dark + 2]], mode).toEqual([0, 0, 0]);
      }
    } finally {
      m.destroy();
    }
  });

  it('renders the green screen in phosphor green', () => {
    const m = make();
    try {
      m.charset.load(new Uint8Array(2048));
      for (let i = 0; i < 40; i++) m.memory.ram[0x2000 + i] = 0x7F;   // solid line
      const at = dotAt(140, 0);
      const rgb = () => [m.pixels[at], m.pixels[at + 1], m.pixels[at + 2]];
      m.video.render(view(m, 'mono', { hires: true }));
      expect(rgb()).toEqual([0xFF, 0xFF, 0xFF]);
      m.video.render(view(m, 'green', { hires: true }));
      expect(rgb()).toEqual([0x33, 0xFF, 0x33]);
    } finally {
      m.destroy();
    }
  });

  it('renders text attributes: $80 normal, $40 flashing, $00-$3F inverse', () => {
    const m = make();
    try {
      // Glyph 1 ('A') has a fully lit first row and blank rows below.
      const font = new Uint8Array(2048);
      font[1 * 8] = 0x7F;
      m.charset.load(font);
      const render = (byte: number, flashPhase: boolean) => {
        m.memory.ram[0x400] = byte;
        m.video.render(view(m, 'mono', { textMode: true, flashPhase }));
        let lit = 0;
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 7; x++) if (m.pixels[dotAt(x, y)] > 0x40) lit++;
        }
        return lit;
      };
      // Row 0 lit (7 px) and seven blank rows -> 7 lit normally; inverted
      // gives 7 blank rows lit (49) and row 0 dark.
      expect(render(0xC1, false)).toBe(7);       // $80+ normal
      expect(render(0x01, false)).toBe(49);      // $00-$3F inverse
      expect(render(0x41, false)).toBe(7);       // $40-$7F flashing, "on" phase
      expect(render(0x41, true)).toBe(49);       // flashing, "off" phase
    } finally {
      m.destroy();
    }
  });
});

describe('apple2-plus OCR', () => {
  it('maps screen codes to the Apple II character order', () => {
    for (const [byte, ch] of [
      [0xC1, 'A'], [0xA0, ' '], [0xB0, '0'], [0xC0, '@'],
      [0x80, '@'], [0x9B, '['], [0xDB, '['], [0xC8, 'H'],
    ] as const) {
      expect(apple2Char(byte)).toBe(ch);
    }
  });

  it('reads the text page into a 40×24 result', () => {
    const ram = new Uint8Array(0x10000);
    const msg = 'HELLO WORLD';
    for (let i = 0; i < msg.length; i++) ram[0x400 + i] = msg.charCodeAt(i) | 0x80;
    const r = ocrApple2Text({ ram, page2: false, textRows: { first: 0, last: 23 } });
    expect(r.cols).toBe(40);
    expect(r.rows).toBe(24);
    expect(r.text.split('\n')[0].slice(0, 11)).toBe('HELLO WORLD');
  });

  it('leaves non-text rows blank in a mixed display', () => {
    const ram = new Uint8Array(0x10000);
    ram[0x400] = 0xC1;
    ram[textRowBase('page1', 20)] = 0xC2;
    const r = ocrApple2Text({ ram, page2: false, textRows: { first: 20, last: 23 } });
    const rows = r.text.split('\n');
    expect(rows[0].trim()).toBe('');
    expect(rows[20][0]).toBe('B');
    expect(r.mask[0]).toBe(false);
    expect(r.mask[20 * 40]).toBe(true);
  });

  it('draws inverse-video cells as swapped colours and normal ones in the ink colour', () => {
    const ram = new Uint8Array(0x10000);
    ram[0x400] = 0x01;                 // inverse 'A'
    ram[0x401] = 0xC1;                 // normal 'A'
    const r = ocrApple2Text({ ram, page2: false, textRows: { first: 0, last: 23 }, ink: '#33ff66' });
    expect(r.html).toContain('<div style="color:#33ff66">');
    expect(r.html).toContain('<span style="color:#000;background:#33ff66">A</span><span>A</span>');
  });

  it('offers the TEXT overlay and places it over the screen it describes', () => {
    const m = make();
    try {
      expect(m.descriptor.ui.statusLeds).toContain('text');
      expect(m.textField.height).toBe(192);
    } finally { m.destroy(); }
  });
});

describe('apple2-plus Disk II controller', () => {
  it('drives the stepper so two phase steps advance one track', () => {
    let cycles = 0;
    const d = new Disk2(() => cycles);
    const raw = new Uint8Array(35 * 16 * 256);
    d.insertDisk(parseApple2Disk(raw, 'dos'), 0);
    expect(d.getUnitTrack(0)).toBe(0);
    d.read(0x01);   // phase 0 on (the current phase: no move)
    d.read(0x03);   // phase 1 on -> half track
    expect(d.getUnitTrack(0)).toBe(0);
    d.read(0x05);   // phase 2 on -> track 1
    expect(d.getUnitTrack(0)).toBe(1);
    d.read(0x07);   // phase 3 on -> still track 1 (1.5 tracks)
    expect(d.getUnitTrack(0)).toBe(1);
    d.read(0x01);   // phase 0 on again -> track 2 (two full steps per track)
    expect(d.getUnitTrack(0)).toBe(2);
  });

  it('only runs with the motor on, and senses write protect on $C0ED', () => {
    let cycles = 0;
    const d = new Disk2(() => cycles);
    const raw = new Uint8Array(35 * 16 * 256);
    raw[0] = 0x11;
    d.insertDisk(parseApple2Disk(raw, 'dos'), 0);

    cycles += 8;
    let any = 0;
    for (let i = 0; i < 64; i++) { cycles += 8; if (d.read(0x0C) !== 0) any++; }
    expect(any).toBe(0);                    // motor off: no data

    d.read(0x09);                           // motor on
    d.read(0x0A);                           // drive 1
    d.writeProtect[0] = true;
    expect(d.read(0x0D)).toBe(0x80);        // write-protect sense
    d.writeProtect[0] = false;
    expect(d.read(0x0D)).toBe(0x00);
  });

  it('streams the GCR track: a leading sync gap then the address prologue', () => {
    let cycles = 0;
    const d = new Disk2(() => cycles);
    const raw = new Uint8Array(35 * 16 * 256);
    d.insertDisk(parseApple2Disk(raw, 'dos'), 0);
    d.read(0x09);                           // motor on
    d.read(0x0A);                           // drive 1

    const got: number[] = [];
    while (got.length < 60) {
      cycles += 8;
      const b = d.read(0x0C);
      if (b !== 0) got.push(b);
    }
    for (let i = 0; i < 48; i++) expect(got[i], `sync ${i}`).toBe(0xFF);
    expect(got.slice(48, 51)).toEqual([0xD5, 0xAA, 0x96]);
  });

  it('keeps spinning for about a second after the motor is switched off', () => {
    // The controller card's one-shot timer holds the drive on after $C0E8.
    // Loaders that switch the motor off between sectors then test for rotation
    // (two reads of the data register that differ) expect to still see it.
    let cycles = 0;
    const d = new Disk2(() => cycles);
    d.insertDisk(parseApple2Disk(new Uint8Array(35 * 16 * 256), 'dos'), 0);
    d.read(0x09);                           // motor on
    d.read(0x0A);                           // drive 1
    d.read(0x08);                           // motor off
    expect(d.motorOn).toBe(true);           // still coasting

    const sees = (): number => {            // distinct values over a stretch of reads
      const seen = new Set<number>();
      for (let i = 0; i < 64; i++) { cycles += 21; seen.add(d.read(0x0C)); }
      return seen.size;
    };
    cycles += 500_000;                      // half a second later
    expect(d.motorOn).toBe(true);
    expect(sees()).toBeGreaterThan(1);      // the disk is still turning

    cycles += 700_000;                      // past the one-second delay
    expect(d.motorOn).toBe(false);
    expect(sees()).toBe(1);                 // stopped: the data register is dead
  });

  it('switching the motor back on cancels a pending spin-down', () => {
    let cycles = 0;
    const d = new Disk2(() => cycles);
    d.insertDisk(parseApple2Disk(new Uint8Array(35 * 16 * 256), 'dos'), 0);
    d.read(0x09);
    d.read(0x08);
    cycles += 500_000;
    d.read(0x09);                           // back on before the timer ran out
    cycles += 2_000_000;
    expect(d.motorOn).toBe(true);
  });

  it('writes the disk volume number into the address fields', () => {
    // DOS 3.3 RWTS rejects a disk whose address-field volume is not the one it
    // asked for (volume mismatch), so a volume-61 disk must present volume 61.
    const raw = new Uint8Array(35 * 16 * 256);
    const vtoc = 17 * 4096;
    raw[vtoc + 1] = 17; raw[vtoc + 3] = 3; raw[vtoc + 6] = 61;
    let cycles = 0;
    const d = new Disk2(() => cycles);
    d.insertDisk(parseApple2Disk(raw, 'dos'), 0);
    d.read(0x09); d.read(0x0A);
    const got: number[] = [];
    while (got.length < 70) { cycles += 8; const b = d.read(0x0C); if (b !== 0) got.push(b); }
    const at = got.findIndex((b, i) => b === 0xD5 && got[i + 1] === 0xAA && got[i + 2] === 0x96);
    // 4-and-4: volume byte pair follows the prologue.
    expect(((got[at + 3] << 1) | 1) & got[at + 4]).toBe(61);
  });

  it('mounting the other drive mid-read does not disturb the active stream', () => {
    const raw = new Uint8Array(35 * 16 * 256);
    const stream = (insertOtherAt: number | null): number[] => {
      let cycles = 0;
      const d = new Disk2(() => cycles);
      d.insertDisk(parseApple2Disk(raw, 'dos'), 0);
      d.read(0x09);                         // motor on
      d.read(0x0A);                         // drive 1
      const got: number[] = [];
      while (got.length < 120) {
        if (got.length === insertOtherAt) {
          d.insertDisk(parseApple2Disk(raw, 'dos'), 1);   // drive 2, drive 1 still selected
          insertOtherAt = null;
        }
        cycles += 8;
        const b = d.read(0x0C);
        if (b !== 0) got.push(b);
      }
      return got;
    };
    expect(stream(60)).toEqual(stream(null));
  });
});

describe('apple2-plus disk mounting', () => {
  it('mounts a ProDOS-order .dsk in ProDOS sector order', async () => {
    const m = make();
    try {
      const raw = new Uint8Array(35 * 16 * 256);
      raw.set([0x00, 0x00, 0x03, 0x00, 0xF5], 0x400);   // ProDOS volume directory header
      raw[256] = 0xA5;                                    // file sector 1 of track 0
      const res = await m.services.media.mount(raw, 'prodos-game.dsk', 'a');
      expect(res.ok).toBe(true);
      // ProDOS order: file sector 1 is the second half of block 0, physical
      // sector 2 (DOS order would put it at physical 13, since DOS_SKEW[13] = 1).
      expect(m.services.disks.image('a')!.tracks[0][0]!.sectors[2].data[0]).toBe(0xA5);
    } finally {
      m.destroy();
    }
  });
});

describe('apple2-plus boot smoke', () => {
  it('cold-resets: clears the ROM warm-start vector so a disc can re-boot', () => {
    const m = make();
    try {
      // The autostart ROM caches a warm-start vector here after booting; left
      // in place, Ctrl-Reset jumps straight into Applesoft.
      m.memory.ram[0x3F2] = 0xAA;
      m.memory.ram[0x3F3] = 0xBB;
      m.memory.ram[0x3F4] = 0xCC;
      m.reset();
      expect(m.memory.ram[0x3F2]).toBe(0);
      expect(m.memory.ram[0x3F3]).toBe(0);
      expect(m.memory.ram[0x3F4]).toBe(0);
    } finally {
      m.destroy();
    }
  });
  it('runs 6502 code installed as the system ROM', () => {
    const m = make();
    try {
      m.services.roms.installSystemRom(makeRom());
      m.reset();
      expect(m.cpu.pc).toBe(0xD000);
      m.tick();
      expect(m.memory.ram[0x10]).toBe(0x42);
    } finally {
      m.destroy();
    }
  });

  it('offers a 48K raw RAM dump for the Save menu', () => {
    const m = make();
    try {
      const dump = m.services.debug.ramExport();
      expect(dump).not.toBeNull();
      expect(dump!.data.length).toBe(0xC000);
      expect(dump!.filename).toContain('apple2-plus');
    } finally {
      m.destroy();
    }
  });
});
