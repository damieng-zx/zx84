/**
 * Real Oric disk images.
 *
 * Every other Oric test builds its media by hand, which proves the codecs agree
 * with themselves. These read actual `.dsk` files published by the Oric
 * community, which is the only way to find the things hand-built fixtures
 * cannot: a wrong container field order, a sector-ID convention, a track stride.
 *
 * It found two real bugs on the first run — every `MFM_DISK` image decoded to
 * zero sectors, because the body is the *decoded* byte stream and not an MFM
 * cell stream; and a Microdisc boot stalled because the card's latch was not
 * re-applied to the controller after a reset.
 *
 * The images are fetched once into `ZX84_ORIC_MEDIA` (default
 * `mcp/.cache/oric-media`) and the suite skips without them. They are
 * `sembiance.com`'s public file-format samples plus the official Sedoric 3
 * system disk from `oric-soft.bedroomlan.org`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { oricDskKind, parseOricDsk } from '@/media/floppy/oric-dsk.ts';
import { OricMachine } from '@/machines/oric/oric-machine.ts';
import { ocrOricText } from '@/ocr/oric.ts';

const MEDIA = process.env.ZX84_ORIC_MEDIA ?? join(process.cwd(), 'mcp', '.cache', 'oric-media');
const CACHE = join(process.cwd(), 'mcp', '.cache');
const image = (name: string): Uint8Array | null => {
  const path = join(MEDIA, name);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
};
const haveMedia = image('xenon1.new.dsk') !== null;
const haveRom = existsSync(join(CACHE, 'oric-basic11b.rom'))
  && existsSync(join(CACHE, 'oric-microdis.rom'));

describe.runIf(haveMedia)('real Oric disk images', () => {
  it('decodes every published image, both container formats', () => {
    // Each of these is a real Sedoric or OricDOS disk. A container field read
    // in the wrong order, or a track stride that is not 6400 bytes, yields zero
    // sectors — which is exactly how this first failed.
    const cases: readonly [string, string, number, number, number][] = [
      // file, kind, tracks, sides, sectors
      ['ANIM.DSK', 'mfm', 80, 2, 17 * 80 * 2],
      ['BuggyBoy.dsk', 'mfm', 42, 2, 17 * 42 * 2],
      ['barbitoric.dsk', 'mfm', 42, 2, 17 * 42 * 2],
      ['MINISED2.DSK', 'mfm', 44, 1, 17 * 44],
      ['oricdos.dsk', 'mfm', 80, 2, 16 * 80 * 2],
      ['xenon1.new.dsk', 'mfm', 21, 1, 17 * 21],
      ['xenon1.old.dsk', 'old', 21, 1, 17 * 21],
    ];
    for (const [file, kind, tracks, sides, sectors] of cases) {
      const data = image(file);
      if (!data) continue;
      expect(oricDskKind(data), file).toBe(kind);
      const parsed = parseOricDsk(data);
      expect(parsed.numTracks, `${file} tracks`).toBe(tracks);
      expect(parsed.numSides, `${file} sides`).toBe(sides);
      let count = 0;
      for (const cyl of parsed.tracks) for (const side of cyl) count += side?.sectors.length ?? 0;
      expect(count, `${file} sectors`).toBe(sectors);
    }
  });

  it('numbers sectors from 1, as the controller does', () => {
    // Oric disks number their sectors 1..N; the WD1793's Sector Register is
    // written with that same value. Getting this off by one makes every read a
    // RECORD NOT FOUND.
    const parsed = parseOricDsk(image('xenon1.new.dsk')!);
    expect(parsed.tracks[0]![0]!.sectors.map(s => s.r)).toEqual(
      Array.from({ length: 17 }, (_, i) => i + 1));
  });

  it('reads the same disk byte-identically from both containers', () => {
    // xenon1 is published twice, once per format. If either decoder were wrong
    // the payloads would drift, so this is a cross-check neither can fake.
    const mfm = parseOricDsk(image('xenon1.new.dsk')!);
    const old = parseOricDsk(image('xenon1.old.dsk')!);
    let compared = 0;
    for (let t = 0; t < mfm.numTracks; t++) {
      for (let s = 0; s < mfm.numSides; s++) {
        const a = mfm.tracks[t]?.[s]?.sectors ?? [];
        const b = old.tracks[t]?.[s]?.sectors ?? [];
        expect(a.length, `track ${t} side ${s}`).toBe(b.length);
        for (let i = 0; i < a.length; i++) {
          expect(Array.from(a[i].data), `track ${t} side ${s} sector ${a[i].r}`)
            .toEqual(Array.from(b[i].data));
          compared++;
        }
      }
    }
    expect(compared).toBe(357);
  });

  it('finds the DOS name in the Sedoric system sector', () => {
    // The system sector is track 0 sector 1 and carries the disk name and the
    // DOS version as plain text, which is a good end-to-end check that the
    // payload offsets are right.
    const sedoric = image('SEDORIC3.DSK');
    if (!sedoric) return;
    const parsed = parseOricDsk(sedoric);
    const boot = parsed.tracks[0]![0]!.sectors.find(s => s.r === 1)!.data;
    const text = [...boot].map(v => (v >= 32 && v < 127) ? String.fromCharCode(v) : '.').join('');
    expect(text).toContain('SEDORIC');
    expect(text).toContain('V3.006');
  });
});

describe.runIf(haveMedia && haveRom)('real disks boot a Microdisc', () => {
  /** Boot a disk image the way the EPROM does. */
  function bootDisk(imageData: Uint8Array, fields: number): OricMachine {
    const m = new OricMachine('atmos', null);
    m.loadROM(new Uint8Array(readFileSync(join(CACHE, 'oric-basic11b.rom'))));
    m.loadEprom(new Uint8Array(readFileSync(join(CACHE, 'oric-microdis.rom'))));
    m.prepare({ get: <T,>(key: string, fallback: T): T => (key === 'oric-microdisc' ? true as T : fallback) });
    m.services.disks.insert('a', parseOricDsk(imageData), 'disk.dsk');
    // Power-on latch: overlay RAM in, EPROM selected. A real Microdisc boots
    // this way and the boot code relies on it.
    m.memory.writeByte(0x0314, 0x04);
    m.reset();
    for (let i = 0; i < fields; i++) m.tick();
    return m;
  }

  /** The first few non-blank lines of the screen. */
  function screenText(m: OricMachine): string {
    return ocrOricText(m.memory.ram).text.split('\n').map(l => l.trim()).filter(Boolean).join(' | ');
  }

  it('boots Sedoric 3 to its banner', () => {
    // The official ORIC INTERNATIONAL system disk. Reaching its banner means the
    // EPROM ran, read track 0 through the controller, and the DOS relocated.
    const m = bootDisk(image('SEDORIC3.DSK')!, 700);
    try {
      const screen = screenText(m);
      expect(screen).toContain('SEDORIC V3.0');
      expect(screen).toContain('1985 ORIC INTERNATIONAL');
    } finally {
      m.destroy();
    }
  });

  it('tells the DOS versions apart', () => {
    // ANIM and MINISED ship Sedoric 2.1, the others 3.0 — a machine that got the
    // sector layout wrong would not reproduce a version string at all.
    const v21 = screenText(bootDisk(image('MINISED2.DSK')!, 700));
    expect(v21).toContain('SEDORIC V2.1');
    const v30 = screenText(bootDisk(image('BuggyBoy.dsk')!, 700));
    expect(v30).toContain('SEDORIC V3.0');
  });

  it('falls back to BASIC when the disk has no DOS system sector', () => {
    // oricdos.dsk carries the plain Microdisc boot stub, not Sedoric, so the
    // EPROM hands over to the BASIC ROM.
    const screen = screenText(bootDisk(image('oricdos.dsk')!, 700));
    expect(screen).toContain('ORIC EXTENDED BASIC');
  });
});
