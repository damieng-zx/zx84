/**
 * SAM MediaService routing — the per-machine file-routing contract.
 *
 * The interesting case is `.dsk`. Everywhere else in zx84 that extension means
 * the CPC/+3 container; on the SAM it is almost always a raw 819,200-byte MGT
 * dump. Routing must therefore go by CONTENT, and must test the container
 * magic BEFORE the size table — an 819,200-byte EDSK is possible and would
 * otherwise be misread as a raw dump, which is silent corruption rather than
 * an honest failure.
 *
 * Runs headless against a real SamMachine (display = null).
 */

import { describe, expect, it } from 'vitest';
import { SamMachine } from '@/machines/sam/sam-machine.ts';
import { blankMgtDisk, serializeMgt } from '@/media/floppy/mgt-image.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';

function machine(): SamMachine {
  const m = new SamMachine('sam512', null);
  m.start = async () => {};      // headless: no AudioContext / rAF
  return m;
}

/** A raw 800K SAM dump — the common case, and the ambiguous one. */
function raw800k(): Uint8Array {
  return serializeMgt(blankMgtDisk(80, 2), 'mgt');
}

/** A .sad container header ("Aley's disk backup" + geometry). */
function sadImage(): Uint8Array {
  const out = new Uint8Array(22 + 80 * 2 * 10 * 512);
  const sig = "Aley's disk backup";
  for (let i = 0; i < sig.length; i++) out[i] = sig.charCodeAt(i);
  out[18] = 2; out[19] = 80; out[20] = 10; out[21] = 512 / 64;
  return out;
}

describe('SAM MediaService routing', () => {
  it('mounts a raw 800K .dsk into drive 1 with SAM geometry', async () => {
    const m = machine();
    const r = await m.services.media.mount(raw800k(), 'game.dsk');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('1');

    const img = m.services.disks.image('1')!;
    expect(img.numTracks).toBe(80);
    expect(img.numSides).toBe(2);
    expect(img.tracks[0][0]!.sectors.map(s => s.r)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    m.destroy();
  });

  it('mounts .mgt and .img the same way', async () => {
    for (const name of ['game.mgt', 'game.img']) {
      const m = machine();
      const r = await m.services.media.mount(raw800k(), name);
      expect(r.ok).toBe(true);
      expect(m.services.disks.image('1')).not.toBeNull();
      m.destroy();
    }
  });

  it('refuses a CPC container named .dsk rather than misreading it', async () => {
    // The whole point of checking magic before size.
    const m = machine();
    const cpc = serializeDSK(blankMgtDisk(40, 1));
    const r = await m.services.media.mount(cpc, 'game.dsk');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Amstrad CPC/);
    expect(m.services.disks.image('1')).toBeNull();
    m.destroy();
  });

  it('refuses a .sad rather than guessing its sector ordering', async () => {
    const m = machine();
    const r = await m.services.media.mount(sadImage(), 'game.sad');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not supported yet/);
    m.destroy();
  });

  it('targets drive 2 when asked', async () => {
    const m = machine();
    const r = await m.services.media.mount(raw800k(), 'game.mgt', '2');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('2');
    expect(m.services.disks.image('2')).not.toBeNull();
    expect(m.services.disks.image('1')).toBeNull();
    m.destroy();
  });

  it('rejects a disk image of the wrong size', async () => {
    const m = machine();
    const r = await m.services.media.mount(new Uint8Array(100), 'game.dsk');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unrecognised/);
    m.destroy();
  });

  it('rejects an extension the SAM has no device for', async () => {
    const m = machine();
    const r = await m.services.media.mount(new Uint8Array(1024), 'game.sna');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/\.mgt/);
    m.destroy();
  });

  it('offers the disk and tape extensions it can actually mount', async () => {
    const m = machine();
    const exts = m.services.media.accepts().map(e => e.ext).sort();
    expect(exts).toEqual(['.csw', '.dsk', '.hfe', '.img', '.mgt', '.scp', '.tap', '.tzx']);
    // Disks land in a drive, tapes on the deck.
    const byExt = new Map(m.services.media.accepts().map(e => [e.ext, e.target]));
    expect(byExt.get('.mgt')).toBe('1');
    expect(byExt.get('.tap')).toBe('tape');
    m.destroy();
  });

  it('names the drives and tracks what is loaded', async () => {
    const m = machine();
    await m.services.media.mount(raw800k(), 'demo.mgt');
    const [d1, d2] = m.services.disks.drives;
    expect(d1.id).toBe('1');
    expect(d1.label).toBe('Drive 1:');
    expect(d1.loaded).toBe(true);
    expect(d1.mediaName).toBe('demo.mgt');
    expect(d2.loaded).toBe(false);
    m.destroy();
  });

  it('saves a mounted disk back out as .mgt', async () => {
    const m = machine();
    await m.services.media.mount(raw800k(), 'demo.mgt');
    const saved = m.services.disks.save('1')!;
    expect(saved.name).toBe('demo.mgt');
    expect(saved.data.length).toBe(819200);
    expect(m.services.disks.save('2')).toBeNull();
    m.destroy();
  });

  it('ejects', async () => {
    const m = machine();
    await m.services.media.mount(raw800k(), 'demo.mgt');
    m.services.disks.eject('1');
    expect(m.services.disks.image('1')).toBeNull();
    expect(m.services.disks.drives[0].mediaName).toBe('');
    m.destroy();
  });
});
