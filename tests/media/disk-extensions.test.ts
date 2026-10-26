/**
 * Which file extensions each machine's MediaService declares and mounts.
 *
 * The shell builds the Load picker, the Drives-pane insert filter and ZIP
 * unwrapping from `media.accepts()`, so a format `mount()` can read but
 * `accepts()` omits is unreachable from the UI. TD0 (Teledisk) is recognised by
 * content in `parseFloppyImage`, which every uPD765A/WD1772 machine routes
 * through, so the +3, CPC and Einstein must take `.td0` alongside `.dsk`.
 */

import { describe, it, expect } from 'vitest';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import { td0Crc } from '@/media/floppy/td0.ts';
import { blankMgtDisk, serializeMgt } from '@/media/floppy/mgt-image.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import type { Machine } from '@/machines/machine.ts';

/** A plain ('TD') Teledisk image of one PCW-shaped track: nine 512-byte
 *  sectors numbered 1..9, each stored raw. Built byte by byte from the
 *  Teledisk layout (12-byte header, track header, sector headers + data, 0xFF
 *  end marker) rather than by calling the parser under test. */
function td0Image(): Uint8Array {
  const out: number[] = [];
  const head = [0x54, 0x44, 0, 0, 21, 0, 1, 0, 0, 1];
  const hcrc = td0Crc(Uint8Array.from(head));
  out.push(...head, hcrc & 0xFF, hcrc >> 8);

  const th = [9, 0, 0];
  out.push(...th, td0Crc(Uint8Array.from(th)) & 0xFF);
  for (let r = 1; r <= 9; r++) {
    const data = new Uint8Array(512).fill(r);
    out.push(0, 0, r, 2, 0, td0Crc(data) & 0xFF);
    const len = data.length + 1;   // the stored length counts the encoding byte
    out.push(len & 0xFF, len >> 8, 0, ...data);
  }
  out.push(0xFF);
  return Uint8Array.from(out);
}

const exts = (m: Machine): string[] => m.services.media.accepts().map(t => t.ext);
const diskTargets = (m: Machine, ext: string): (string | undefined)[] =>
  m.services.media.accepts().filter(t => t.ext === ext).map(t => t.target);

describe('TD0 disk images', () => {
  it('mount into the +3 internal drive and appear in its accepted list', async () => {
    const s = new Spectrum('zx128kplus3', null);
    expect(diskTargets(s, '.td0')).toEqual(['a']);
    const res = await s.services.media.mount(td0Image(), 'game.td0');
    expect(res).toMatchObject({ ok: true, target: 'a' });
    const img = s.services.disks!.image!('a');
    expect(img).not.toBeNull();
    expect(img!.tracks[0][0]!.sectors.map(x => x.r)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(img!.tracks[0][0]!.sectors[4].data[0]).toBe(5);
  });

  it('on a Spectrum with no interface fitted are refused with the Hardware hint', async () => {
    const s = new Spectrum('zx48k', null);
    const res = await s.services.media.mount(td0Image(), 'game.td0');
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Enable the Beta Disk or MGT \+D/);
  });

  it('route to the Beta Disk when it is enabled', async () => {
    const s = new Spectrum('zx48k', null);
    s.start = async () => {};
    s.betaDisk.enabled = true;
    expect(await s.services.media.mount(td0Image(), 'game.td0')).toMatchObject({ ok: true, target: 'beta:0' });
    expect(s.betaDisk.fdc.getDiskImage(0)!.tracks[0][0]!.sectors).toHaveLength(9);
  });

  it('route to the +D when only the +D is enabled', async () => {
    const s = new Spectrum('zx48k', null);
    s.start = async () => {};
    s.mgtPlusD.enabled = true;
    expect(await s.services.media.mount(td0Image(), 'game.td0', 'unit:1')).toMatchObject({ ok: true, target: 'plusd:1' });
    expect(s.mgtPlusD.fdc.getDiskImage(1)!.tracks[0][0]!.sectors).toHaveLength(9);
  });

  it('mount into CPC drive A and B', async () => {
    const c = new CpcMachine('cpc6128', null);
    expect(diskTargets(c, '.td0')).toEqual(['a']);
    expect(await c.services.media.mount(td0Image(), 'game.td0')).toMatchObject({ ok: true, target: 'a' });
    expect(await c.services.media.mount(td0Image(), 'game.td0', 'b')).toMatchObject({ ok: true, target: 'b' });
    expect(c.services.disks!.image!('a')!.tracks[0][0]!.sectors).toHaveLength(9);
  });

  it('are not offered on a tape-only CPC', () => {
    expect(exts(new CpcMachine('cpc464', null))).not.toContain('.td0');
  });

  it('mount into the Einstein WD1772 drive', async () => {
    const e = new EinsteinMachine('einstein-tc01', null);
    e.prepare({ get<T>(_k: string, fallback: T): T { return fallback; } });
    expect(diskTargets(e, '.td0')).toEqual(['a']);
    expect(await e.services.media.mount(td0Image(), 'game.td0')).toMatchObject({ ok: true, target: 'a' });
    expect(e.services.disks!.image!('a')!.tracks[0][0]!.sectors).toHaveLength(9);
  });

  it('a corrupt .td0 is refused with a message, not mounted', async () => {
    const c = new CpcMachine('cpc6128', null);
    const res = await c.services.media.mount(new Uint8Array(64), 'junk.td0');
    expect(res.ok).toBe(false);
  });
});

describe('CPC declares every format its mount() reads', () => {
  it('lists the CDT container under all three tape extensions, and SCP beside HFE', () => {
    const list = exts(new CpcMachine('cpc6128', null));
    for (const ext of ['.cdt', '.tzx', '.tap', '.dsk', '.hfe', '.scp', '.sna']) {
      expect(list, ext).toContain(ext);
    }
  });

  it('routes .tzx and .tap to the tape deck', async () => {
    const c = new CpcMachine('cpc6128', null);
    // An empty TZX: "ZXTape!" 0x1A, version 1.20, no blocks.
    const tzx = Uint8Array.from([0x5A, 0x58, 0x54, 0x61, 0x70, 0x65, 0x21, 0x1A, 1, 20]);
    expect(await c.services.media.mount(tzx, 'game.tzx')).toMatchObject({ ok: true, target: 'tape' });
    // One 2-byte TAP block: flag 0xFF, parity 0xFF.
    const tap = Uint8Array.from([2, 0, 0xFF, 0xFF]);
    expect(await c.services.media.mount(tap, 'game.tap')).toMatchObject({ ok: true, target: 'tape' });
  });

  it('keeps cartridge types to the Plus models', () => {
    expect(exts(new CpcMachine('cpc6128', null))).not.toContain('.cpr');
    expect(exts(new CpcMachine('cpc6128plus', null))).toContain('.cpr');
  });
});

describe('Einstein', () => {
  it('still declares dsk, hfe and scp', () => {
    const e = new EinsteinMachine('einstein-tc01', null);
    e.prepare({ get<T>(_k: string, fallback: T): T { return fallback; } });
    for (const ext of ['.dsk', '.hfe', '.scp']) expect(exts(e)).toContain(ext);
  });
});

describe('raw .dsk on a Spectrum with a +D', () => {
  const plusD = (): Spectrum => {
    const s = new Spectrum('zx48k', null);
    s.start = async () => {};
    s.mgtPlusD.enabled = true;
    return s;
  };
  // 80 tracks × 2 sides × 10 sectors × 512 bytes: the +D's 800K geometry.
  const mgtDump = (): Uint8Array => serializeMgt(blankMgtDisk(80, 2), 'mgt');

  it('is a +D sector dump and mounts in the +D', async () => {
    const s = plusD();
    expect(await s.services.media.mount(mgtDump(), 'sam.dsk')).toMatchObject({ ok: true, target: 'plusd:0' });
    expect(s.mgtPlusD.fdc.getDiskImage(0)).not.toBeNull();
  });

  it('is only offered once the +D is fitted (or on a +3)', () => {
    expect(exts(new Spectrum('zx48k', null))).not.toContain('.dsk');
    expect(exts(plusD())).toContain('.dsk');
    expect(exts(new Spectrum('zx128kplus3', null))).toContain('.dsk');
  });

  it('refuses a CPC-format DSK rather than misreading it as sectors', async () => {
    const res = await plusD().services.media.mount(serializeDSK(blankMgtDisk(40, 1)), 'cpc.dsk');
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Not a recognised \+D image/);
  });

  it('still goes to the uPD765A on a +3', async () => {
    const s = new Spectrum('zx128kplus3', null);
    s.start = async () => {};
    expect(await s.services.media.mount(serializeDSK(blankMgtDisk(40, 1)), 'game.dsk'))
      .toMatchObject({ ok: true, target: 'a' });
  });
});

describe('CSW tapes on the CPC', () => {
  /** CSW v1, RLE, starting low: header 0x20 bytes, then one byte per pulse. */
  function csw(pulses: number[]): Uint8Array {
    const out = new Uint8Array(0x20 + pulses.length);
    [...'Compressed Square Wave\x1A'].forEach((ch, i) => { out[i] = ch.charCodeAt(0); });
    out[0x17] = 1; out[0x18] = 1;                // revision 1.01
    out[0x19] = 0x44; out[0x1A] = 0xAC;          // 44100 Hz
    out[0x1B] = 1;                               // RLE
    out.set(pulses, 0x20);
    return out;
  }

  it('mounts as a pulse block, with the sample rate turned into T-states', async () => {
    const c = new CpcMachine('cpc6128', null);
    expect(exts(c)).toContain('.csw');
    expect(await c.services.media.mount(csw([10, 20, 30]), 'game.csw')).toMatchObject({ ok: true, target: 'tape' });
    const block = c.services.tape!.rawBlocks.find(b => b.kind === 'csw') as { pulses: Uint32Array };
    expect([...block.pulses]).toEqual([10, 20, 30].map(n => Math.round(n * 3_500_000 / 44100)));
  });

  it('a corrupt .csw is refused', async () => {
    const c = new CpcMachine('cpc6128', null);
    expect((await c.services.media.mount(new Uint8Array(64), 'junk.csw')).ok).toBe(false);
  });
});
