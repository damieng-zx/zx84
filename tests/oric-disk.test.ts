/**
 * Oric Microdisc: the controller's registers, the control latch's memory flip,
 * and the `.dsk` container.
 *
 * The latch tests are written from the hardware reference's bit table rather than
 * from the implementation: bit 1 is ROMDIS in *negative* logic (0 disables the
 * BASIC ROM), bit 7 is EPROM select (0 maps the boot ROM at `$E000`), bits 5-6
 * are the drive and bit 4 the side. Everything else follows from that.
 */

import { describe, expect, it } from 'vitest';
import { OricMachine } from '@/machines/oric/oric-machine.ts';
import {
  ORIC_DSK_MFM, ORIC_DSK_OLD, isOricDsk, oricDskKind, parseOricDsk,
} from '@/media/floppy/oric-dsk.ts';

/** A machine with a Microdisc fitted. */
function withCard(): OricMachine {
  const m = new OricMachine('atmos', null);
  m.prepare({ get: <T,>(key: string, fallback: T): T => (key === 'oric-microdisc' ? true as T : fallback) });
  return m;
}

/** Build an `ORICDISK` image by hand: sides, tracks, sectors-per-track, sectors. */
function oldImage(sides: number, tracks: number, sectors: number, fill: (side: number, track: number, sector: number) => number): Uint8Array {
  const header = new Uint8Array(256);
  for (let i = 0; i < ORIC_DSK_OLD.length; i++) header[i] = ORIC_DSK_OLD.charCodeAt(i);
  const put = (at: number, v: number): void => {
    header[at] = v & 0xFF; header[at + 1] = (v >> 8) & 0xFF;
    header[at + 2] = (v >> 16) & 0xFF; header[at + 3] = (v >> 24) & 0xFF;
  };
  put(8, sides); put(12, tracks); put(16, sectors);
  const body = new Uint8Array(sides * tracks * sectors * 256);
  let at = 0;
  for (let side = 0; side < sides; side++) {
    for (let track = 0; track < tracks; track++) {
      for (let sector = 1; sector <= sectors; sector++) {
        body.fill(fill(side, track, sector), at, at + 256);
        at += 256;
      }
    }
  }
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

describe('oric .dsk containers', () => {
  it('tells the two formats this extension hides apart by signature', () => {
    const old = oldImage(1, 2, 17, () => 0xAA);
    expect(oricDskKind(old)).toBe('old');
    expect(isOricDsk(old)).toBe(true);
    // A header that says MFM_DISK is the other format.
    const mfm = new Uint8Array(0x400);
    for (let i = 0; i < ORIC_DSK_MFM.length; i++) mfm[i] = ORIC_DSK_MFM.charCodeAt(i);
    expect(oricDskKind(mfm)).toBe('mfm');
    // A CPC DSK is neither, and must be refused rather than misparsed.
    const cpc = new Uint8Array(0x400);
    for (const [i, ch] of [...'MV - CPCEMU Disk-File\r\n'].entries()) cpc[i] = ch.charCodeAt(0);
    expect(isOricDsk(cpc)).toBe(false);
  });

  it('reads an ORICDISK image side-major, track by track', () => {
    // Side 0 track 1 sector 1 is $13; side 1 track 0 sector 1 is $21. That
    // ordering — all of side 0, then all of side 1 — is what the format means,
    // so getting it wrong swaps the sides.
    const data = oldImage(2, 2, 3, (side, track, sector) => (side + 1) * 0x10 + track * 2 + sector);
    const image = parseOricDsk(data);
    expect(image.numSides).toBe(2);
    expect(image.numTracks).toBe(2);
    expect(image.tracks[1][0]!.sectors[0].data[0]).toBe(0x10 + 2 + 1);
    expect(image.tracks[0][1]!.sectors[0].data[0]).toBe(0x20 + 0 + 1);
    // Sector IDs run from 1, as the WD1793 expects.
    expect(image.tracks[0][0]!.sectors.map(s => s.r)).toEqual([1, 2, 3]);
    expect(image.tracks[0][0]!.sectors[0].data).toHaveLength(256);
  });

  it('refuses a truncated image rather than reading past the end', () => {
    const full = oldImage(1, 2, 3, () => 0);
    expect(() => parseOricDsk(full.slice(0, 256 + 256))).toThrow(/truncated/);
  });
});

describe('oric Microdisc', () => {
  it('offers four drives only while a card is fitted', () => {
    const bare = new OricMachine('atmos', null);
    try {
      expect(bare.microdisc).toBeNull();
      expect(bare.services.disks.drives).toHaveLength(0);
    } finally {
      bare.destroy();
    }
    const fitted = withCard();
    try {
      expect(fitted.microdisc).not.toBeNull();
      expect(fitted.services.disks.drives.map(d => d.id)).toEqual(['a', 'b', 'c', 'd']);
    } finally {
      fitted.destroy();
    }
  });

  it('flips the memory map from the control latch, exactly as the bits say', () => {
    const m = withCard();
    try {
      // Give the machine a ROM whose first byte is known, so the test can tell
      // the ROM from the overlay rather than trusting the flag.
      const rom = new Uint8Array(0x4000);
      rom[0] = 0x4C;
      m.loadROM(rom);
      // Fitting the card leaves the latch at its power-on value, which maps
      // neither the overlay nor the EPROM; start from an explicit ROM-visible
      // state so the transitions below are the thing under test.
      m.memory.writeByte(0x0314, 0x02);
      // Bit 1 is ROMDIS in negative logic: clear disables the BASIC ROM and
      // maps the overlay RAM in at $C000. Bit 7 similar for the EPROM.
      const latch = (v: number): void => m.memory.writeByte(0x0314, v);

      latch(0x02);   // bit 1 set: ROM visible
      expect(m.memory.basicRomOn).toBe(true);
      expect(m.memory.epromOn).toBe(false);
      expect(m.memory.readByte(0xC000), 'the ROM, not RAM').toBe(0x4C);

      latch(0x00);   // bit 1 clear: overlay RAM in place of the ROM
      expect(m.memory.basicRomOn).toBe(false);
      m.memory.ram[0xC000] = 0x99;
      expect(m.memory.readByte(0xC000)).toBe(0x99);

      latch(0x00);   // bit 1 clear and bit 7 clear: overlay + boot EPROM
      expect(m.memory.epromOn).toBe(true);
      latch(0x80);   // bit 7 set deselects the EPROM
      expect(m.memory.epromOn).toBe(false);
      latch(0x02);   // bit 1 set puts the ROM back, so no EPROM either way
      expect(m.memory.epromOn).toBe(false);
      expect(m.memory.basicRomOn).toBe(true);
    } finally {
      m.destroy();
    }
  });

  it('decodes the card above the VIA, so its registers never reach it', () => {
    const m = withCard();
    try {
      // $0310-$031B are the card's; the VIA is only mirrored elsewhere in the
      // page. Writing the card's track register must not touch the VIA.
      const ddrbBefore = m.via.ddrb;
      m.memory.writeByte(0x0311, 0x2A);      // track register
      expect(m.via.ddrb).toBe(ddrbBefore);
      expect(m.microdisc!.fdc.readTrack()).toBe(0x2A);

      // And a VIA register elsewhere in the page still works.
      m.memory.writeByte(0x0302, 0x5A);
      expect(m.via.ddrb).toBe(0x5A);
    } finally {
      m.destroy();
    }
  });

  it('reports INTRQ and DRQ in the negative logic the ROM polls', () => {
    const m = withCard();
    try {
      // Idle: both lines read as $FF, i.e. bits 7 clear = not asserted.
      expect(m.memory.readByte(0x0314)).toBe(0xFF);
      expect(m.memory.readByte(0x0318)).toBe(0xFF);
      // With interrupts disabled the latch read stays $FF however the
      // controller feels, which is what makes polling safe.
      m.memory.writeByte(0x0314, 0x02);
      expect(m.memory.readByte(0x0314)).toBe(0xFF);
    } finally {
      m.destroy();
    }
  });

  it('mounts a disk in a drive and saves it back as .dsk', async () => {
    const m = withCard();
    try {
      const data = oldImage(1, 4, 4, (_side, track, sector) => track * 4 + sector);
      const result = await m.services.media.mount(data, 'GAME.dsk');
      expect(result.ok).toBe(true);
      expect(m.services.disks.drives[0].loaded).toBe(true);
      expect(m.services.disks.drives[0].mediaName).toBe('GAME.dsk');

      const saved = m.services.disks.save('a');
      expect(saved?.name).toBe('GAME.dsk');
      // What it wrote must itself be a readable Oric image with the same bytes.
      const back = parseOricDsk(saved!.data);
      expect(back.numTracks).toBe(4);
      expect(back.tracks[3][0]!.sectors[3].data[0]).toBe(3 * 4 + 4);
    } finally {
      m.destroy();
    }
  });

  it('refuses a disk when no card is fitted', async () => {
    const m = new OricMachine('atmos', null);
    try {
      const data = oldImage(1, 2, 4, () => 0);
      const result = await m.services.media.mount(data, 'GAME.dsk');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Microdisc/);
      // And it is not offered in the Load picker either.
      expect(m.services.media.accepts().some(a => a.ext === '.dsk')).toBe(false);
    } finally {
      m.destroy();
    }
  });
});
