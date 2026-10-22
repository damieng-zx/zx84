/**
 * GTIA register tests.
 *
 * The write map is the colour/player register bank and the read map is the
 * collision/trigger bank; the two alias the same addresses. PAL is reported
 * through bit 0 of $D014 ($0F NTSC, $01 PAL), triggers are active low, and
 * HITCLR clears every collision latch.
 */

import { describe, it, expect } from 'vitest';
import { Gtia } from '@/machines/atari/gtia.ts';

describe('gtia registers', () => {
  it('writes the colour registers at $D012-$D01A', () => {
    const gtia = new Gtia();
    gtia.writeReg(0x12, 0x11); // COLPM0
    gtia.writeReg(0x15, 0x22); // COLPM3
    gtia.writeReg(0x16, 0x33); // COLPF0
    gtia.writeReg(0x19, 0x44); // COLPF3
    gtia.writeReg(0x1a, 0x55); // COLBK
    // The colour registers have no bit 0: odd values are stored even.
    expect(Array.from(gtia.colpm)).toEqual([0x10, 0, 0, 0x22]);
    expect(gtia.colpf[0]).toBe(0x32);
    expect(gtia.colpf[3]).toBe(0x44);
    expect(gtia.colbk).toBe(0x54);
  });

  it('writes player/missile graphics at $D00D-$D011', () => {
    const gtia = new Gtia();
    gtia.writeReg(0x0d, 0x80);
    gtia.writeReg(0x10, 0x01);
    gtia.writeReg(0x11, 0x03);
    expect(gtia.grafp[0]).toBe(0x80);
    expect(gtia.grafp[3]).toBe(0x01);
    expect(gtia.grafm).toBe(0x03);
  });

  it('reports triggers active low and the console switches active low', () => {
    // TRIG0-3 drive only bit 0; bits 1-7 always read 0 (the XL OS compares
    // TRIG3 as a whole byte, so these matter).
    const gtia = new Gtia();
    expect(gtia.readReg(0x10)).toBe(0x01); // released
    gtia.setTrigger(0, true);
    expect(gtia.readReg(0x10)).toBe(0x00);

    gtia.setConsole(true, false, true); // START and OPTION pressed
    expect(gtia.readReg(0x1f) & 0x07).toBe(0x02);
  });

  it('reports the TV standard on $D014', () => {
    const ntsc = new Gtia();
    expect(ntsc.readReg(0x14)).toBe(0x0f);
    const pal = new Gtia();
    pal.pal = true;
    expect(pal.readReg(0x14)).toBe(0x01);
  });

  it('returns collision latches until HITCLR is written', () => {
    const gtia = new Gtia();
    gtia.hits[0] = 0x0f;
    gtia.hits[15] = 0x03;
    expect(gtia.readReg(0x00)).toBe(0x0f);
    expect(gtia.readReg(0x0f)).toBe(0x03);
    gtia.writeReg(0x1e, 0x00);
    expect(gtia.readReg(0x00)).toBe(0);
    expect(gtia.readReg(0x0f)).toBe(0);
  });

  it('latches the internal speaker on CONSOL bit 3', () => {
    const gtia = new Gtia();
    gtia.writeReg(0x1f, 0x08);
    expect(gtia.speaker).toBe(true);
    gtia.writeReg(0x1f, 0x00);
    expect(gtia.speaker).toBe(false);
  });

  it('decodes the GTIA mode from PRIOR bits 6-7', () => {
    const gtia = new Gtia();
    gtia.writeReg(0x1b, 0x3f); // priority, fifth player, multicolour only
    expect(gtia.gtiaMode).toBe(0);

    gtia.writeReg(0x1b, 0x40);
    expect(gtia.gtiaMode).toBe(9);
    gtia.writeReg(0x1b, 0x80);
    expect(gtia.gtiaMode).toBe(10);
    gtia.writeReg(0x1b, 0xc0);
    expect(gtia.gtiaMode).toBe(11);
  });
});

describe('gtia CONSOL read', () => {
  // Layout 0000 SPK OPT SEL STA; a line written as 1 is grounded and reads 0.
  it('reads $07 after the OS writes $08, with no key down', () => {
    const gtia = new Gtia();
    gtia.writeReg(0x1f, 0x08);
    expect(gtia.readReg(0x1f)).toBe(0x07);
  });

  it('reads $0F with nothing written, and pressed keys low', () => {
    const gtia = new Gtia();
    expect(gtia.readReg(0x1f)).toBe(0x0f);
    gtia.setConsole(true, false, false); // START
    expect(gtia.readReg(0x1f)).toBe(0x0e);
  });

  it('reads a key line written as 1 as pressed', () => {
    const gtia = new Gtia();
    gtia.writeReg(0x1f, 0x09); // speaker sunk, START line grounded
    expect(gtia.readReg(0x1f)).toBe(0x06);
  });
});
