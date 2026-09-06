/**
 * The SAM Coupé software library: the SSX screen decoder and the catalog
 * client that `tools/build-sam-catalog.ts` publishes for.
 *
 * The SSX sizes below are not invented — they are the lengths of ZXDB's own
 * `.ssx`/`.ss4` files, which is the only thing in the format that says which
 * screen mode wrote it.
 */

import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SamMachine } from '@/machines/sam/sam-machine.ts';
import { blankMgtDisk, serializeMgt } from '@/media/floppy/mgt-image.ts';
import { decodeSsx, isSsx, SSX_HEIGHT, SSX_WIDTH } from '@/machines/sam/ssx.ts';
import { SAM_PALETTES } from '@/machines/sam/constants.ts';
import {
  matchesSamFormatFilter, matchesSamGenreFilter, primarySamFile, resolveSamGame,
  resolveSamGames, SAM_LIBRARY_FORMATS,
  type RawSamCatalog,
} from '@/library/sam-catalog.ts';

const MODE1_LEN = 6144 + 768 + 16;
const MODE2_LEN = 6144 + 6144 + 16;
const MODE3_LEN = 24576 + 4;
const MODE4_LEN = 24576 + 16;
const RASTER_LEN = SSX_WIDTH * SSX_HEIGHT;

const palette = SAM_PALETTES.linear;

/** Pixel at (x, y) of a decoded screen, as a packed palette value. */
function pixel(rgba: Uint8ClampedArray, x: number, y: number): number {
  return new Uint32Array(rgba.buffer)[y * SSX_WIDTH + x];
}

describe('SSX screen dumps', () => {
  it('recognises exactly the five lengths the format can have', () => {
    for (const length of [MODE1_LEN, MODE2_LEN, MODE3_LEN, MODE4_LEN, RASTER_LEN]) {
      expect(isSsx(new Uint8Array(length))).toBe(true);
    }
    // A truncated file, a Spectrum .scr, and a stray byte are all refused
    // rather than guessed at.
    for (const length of [0, 6912, 6927, 24576, 65536]) {
      expect(isSsx(new Uint8Array(length))).toBe(false);
      expect(decodeSsx(new Uint8Array(length))).toBeNull();
    }
  });

  it('decodes a mode 4 dump, high nibble leftmost, two pixels per byte', () => {
    const data = new Uint8Array(MODE4_LEN);
    data[0] = 0x12;                       // first two pixels: CLUT 1 then 2
    data.set([0x00, 0x7F, 0x40], 24576);  // CLUT 0/1/2
    const rgba = decodeSsx(data)!;
    expect(pixel(rgba, 0, 0)).toBe(palette[0x7F]);
    expect(pixel(rgba, 1, 0)).toBe(palette[0x7F]);   // 256 px doubled to 512
    expect(pixel(rgba, 2, 0)).toBe(palette[0x40]);
    expect(pixel(rgba, 4, 0)).toBe(palette[0x00]);
  });

  it('decodes a mode 3 dump at full width from only four CLUT entries', () => {
    const data = new Uint8Array(MODE3_LEN);
    data[0] = 0b00011011;                 // four pixels: 0, 1, 2, 3
    data.set([0x00, 0x7F, 0x40, 0x02], 24576);
    const rgba = decodeSsx(data)!;
    expect(pixel(rgba, 0, 0)).toBe(palette[0x00]);
    expect(pixel(rgba, 1, 0)).toBe(palette[0x7F]);
    expect(pixel(rgba, 2, 0)).toBe(palette[0x40]);
    expect(pixel(rgba, 3, 0)).toBe(palette[0x02]);
  });

  it('decodes mode 1 through the attribute, with BRIGHT as CLUT bit 3', () => {
    const data = new Uint8Array(MODE1_LEN);
    data[0] = 0x80;                       // leftmost pixel is ink
    data[6144] = 0x41;                    // BRIGHT + ink 1 → CLUT 9, paper 0 → 8
    const clut = new Uint8Array(16).fill(0);
    clut[8] = 0x10; clut[9] = 0x7F;
    data.set(clut, 6144 + 768);
    const rgba = decodeSsx(data)!;
    expect(pixel(rgba, 0, 0)).toBe(palette[0x7F]);   // ink
    expect(pixel(rgba, 2, 0)).toBe(palette[0x10]);   // paper
  });

  it('reads a raster dump as one palette code per mode 3 pixel', () => {
    const data = new Uint8Array(RASTER_LEN);
    data[0] = 0x7F;
    data[RASTER_LEN - 1] = 0x40;
    const rgba = decodeSsx(data)!;
    expect(pixel(rgba, 0, 0)).toBe(palette[0x7F]);
    expect(pixel(rgba, SSX_WIDTH - 1, SSX_HEIGHT - 1)).toBe(palette[0x40]);
  });
});

describe('SAM catalog', () => {
  const catalog: RawSamCatalog = {
    genres: ['Arcade Game: Platform', 'Utility: Word Processor'],
    publishers: ['Revelation Software'],
    games: [
      {
        i: 1, t: 'Astroball', y: 1992, g: 0, p: 0, d: '/a/Astroball.dsk.zip',
        s: '/a/load.ssx', sx: ['/a/run.scr', '/a/run.png'],
      },
      { i: 2, t: 'Fred issue 11', d: '/f/FRED11A.dsk.zip', ds: [['/f/FRED11B.dsk.zip', 'Disk 2']] },
      { i: 3, t: 'Donkey Kong', f: '/d/DonkeyKong.tap.zip' },
    ],
  };

  it('resolves the dictionaries and leaves absent fields empty', () => {
    const [astroball, fred, donkey] = resolveSamGames(catalog);
    expect(astroball.genre).toBe('Arcade Game: Platform');
    expect(astroball.publisher).toBe('Revelation Software');
    expect(astroball.year).toBe(1992);
    expect(astroball.screen).toBe('/a/load.ssx');
    expect(fred.year).toBeNull();
    expect(fred.genre).toBe('');
    expect(donkey.screen).toBe('');
    expect(donkey.screens).toEqual([]);
  });

  it('keeps every screenshot candidate, best first', () => {
    // The host serves some of ZXDB's screen extensions and not others, so the
    // viewer needs somewhere to fall back to when the best one 404s.
    const [astroball] = resolveSamGames(catalog);
    expect(astroball.screens).toEqual(['/a/load.ssx', '/a/run.scr', '/a/run.png']);
    expect(astroball.screen).toBe(astroball.screens[0]);
  });

  it('numbers a multi-disk release from one, and keeps the order', () => {
    const fred = resolveSamGame(catalog.games[1], catalog);
    expect(fred.disks).toEqual([
      { link: '/f/FRED11A.dsk.zip', label: 'Disk 1' },
      { link: '/f/FRED11B.dsk.zip', label: 'Disk 2' },
    ]);
    expect(primarySamFile(fred)).toBe('/f/FRED11A.dsk.zip');
  });

  it('falls back to the tape when a title has no disk', () => {
    const donkey = resolveSamGame(catalog.games[2], catalog);
    expect(donkey.disks).toEqual([]);
    expect(donkey.formats).toEqual(['tape']);
    expect(primarySamFile(donkey)).toBe('/d/DonkeyKong.tap.zip');
  });

  it('filters by format, with an empty selection meaning "any"', () => {
    const [astroball, , donkey] = resolveSamGames(catalog);
    const none = new Set<never>();
    expect(matchesSamFormatFilter(astroball, none)).toBe(true);
    expect(matchesSamFormatFilter(donkey, none)).toBe(true);

    expect(matchesSamFormatFilter(astroball, new Set(['disk'] as const))).toBe(true);
    expect(matchesSamFormatFilter(donkey, new Set(['disk'] as const))).toBe(false);
    expect(matchesSamFormatFilter(donkey, new Set(['tape'] as const))).toBe(true);
    expect(matchesSamFormatFilter(astroball, new Set(SAM_LIBRARY_FORMATS))).toBe(true);
  });

  it('filters by genre, and an untagged title only shows unfiltered', () => {
    const [astroball, fred] = resolveSamGames(catalog);
    const platform = new Set(['Arcade Game: Platform']);
    expect(matchesSamGenreFilter(astroball, platform)).toBe(true);
    expect(matchesSamGenreFilter(fred, platform)).toBe(false);
    expect(matchesSamGenreFilter(fred, new Set())).toBe(true);
  });
});

describe('mounting what the library actually downloads', () => {
  // ZXDB ships every SAM disk as a gzip stream inside the .zip, so the file
  // that reaches the media service is a `.dsk` whose content is gzip, not the
  // 819,200-byte dump the name implies. SimCoupe reads any stream through zlib
  // for the same reason. Without this the whole catalog is unmountable.
  const mgt = serializeMgt(blankMgtDisk(), 'mgt');

  /** A one-entry ZIP holding `payload`, stored (method 0) so the fixture is
   *  readable — `unzip` accepts stored and deflated alike. */
  function zipOf(name: string, payload: Uint8Array): Uint8Array {
    const nameBytes = new TextEncoder().encode(name);
    const out = new Uint8Array(30 + nameBytes.length + payload.length
      + 46 + nameBytes.length + 22);
    const view = new DataView(out.buffer);
    let at = 0;
    const u32 = (v: number) => { view.setUint32(at, v, true); at += 4; };
    const u16 = (v: number) => { view.setUint16(at, v, true); at += 2; };

    u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);   // local header
    u32(0); u32(payload.length); u32(payload.length);
    u16(nameBytes.length); u16(0);
    out.set(nameBytes, at); at += nameBytes.length;
    out.set(payload, at); at += payload.length;

    const central = at;
    u32(0x02014b50); u16(20); u16(20); u16(0); u16(0); u16(0); u16(0);
    u32(0); u32(payload.length); u32(payload.length);
    u16(nameBytes.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(0);
    out.set(nameBytes, at); at += nameBytes.length;

    const end = at;
    u32(0x06054b50); u16(0); u16(0); u16(1); u16(1);
    u32(end - central); u32(central); u16(0);
    return out.subarray(0, at);
  }

  it('expands a gzipped disk image and mounts it', async () => {
    const machine = new SamMachine('sam512', null);
    const gz = new Uint8Array(gzipSync(Buffer.from(mgt)));
    expect(gz[0]).toBe(0x1F);
    expect(gz[1]).toBe(0x8B);
    expect(gz.length).toBeLessThan(mgt.length);

    const result = await machine.services.media.mount(gz, 'Astroball.dsk');
    expect(result.ok).toBe(true);
    expect(machine.services.disks!.image('1')).not.toBeNull();
    machine.destroy();
  });

  it('still mounts an uncompressed image untouched', async () => {
    const machine = new SamMachine('sam512', null);
    const result = await machine.services.media.mount(mgt, 'Astroball.mgt');
    expect(result.ok).toBe(true);
    machine.destroy();
  });

  it('opens a ZIP archive wearing a .dsk name', async () => {
    // The shell unwraps archives by extension, so one called .dsk sails past
    // it and arrives here still packed. SimCoupe opens these, so we must.
    const machine = new SamMachine('sam512', null);
    const result = await machine.services.media.mount(
      zipOf('CaptainComic.dsk', mgt), 'CaptainComic.dsk');
    expect(result.ok).toBe(true);
    expect(machine.services.disks!.image('a')).not.toBeNull();
    machine.destroy();
  });

  it('unwraps a gzip nested inside a ZIP, and takes the inner name', async () => {
    const machine = new SamMachine('sam512', null);
    const inner = new Uint8Array(gzipSync(Buffer.from(mgt)));
    const result = await machine.services.media.mount(
      zipOf('Game.mgt', inner), 'Game.dsk');
    expect(result.ok).toBe(true);
    expect(machine.services.disks!.drives[0].mediaName).toBe('Game.mgt');
    machine.destroy();
  });

  it('reports an archive with nothing loadable in it', async () => {
    const machine = new SamMachine('sam512', null);
    const result = await machine.services.media.mount(
      zipOf('readme.txt', new Uint8Array(16)), 'Game.dsk');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no loadable file/);
    machine.destroy();
  });

  it('reports a corrupt gzip stream rather than mounting rubbish', async () => {
    const machine = new SamMachine('sam512', null);
    const broken = new Uint8Array([0x1F, 0x8B, 0x08, 0, 0, 0, 0, 0, 9, 9, 9, 9]);
    const result = await machine.services.media.mount(broken, 'Broken.dsk');
    expect(result.ok).toBe(false);
    machine.destroy();
  });
});
