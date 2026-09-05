/**
 * SAM MediaService routing — the per-machine file-routing contract.
 *
 * The interesting case is `.dsk`. Everywhere else in zx84 that extension means
 * the CPC/+3 container; on the SAM it is usually a raw 819,200-byte MGT dump.
 * Routing must therefore go by CONTENT, and must test the container magic
 * BEFORE the size table — an 819,200-byte EDSK is possible and would otherwise
 * be misread as a raw dump, which is silent corruption rather than an honest
 * failure. A DSK container is not itself a rejection, though: much of the SAM
 * library ships in one, and nothing inside it reliably says whose disk it is —
 * neither the geometry (the container fixes none) nor the filesystem (SAM game
 * disks are routinely custom-formatted with no directory at all).
 *
 * The drives answer to 'a' and 'b' like every other machine's built-in pair —
 * the SAM's own numbering lives in the label. Giving them machine-specific ids
 * is what once stopped mounted disks appearing in the Drives pane at all.
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

/** An Amstrad-shaped disk: nine 512-byte sectors numbered from 0xC1, as the
 *  CPC's system format does. Used to show it is NOT turned away. */
function cpcDisk(): Uint8Array {
  const image = blankMgtDisk(40, 1);
  for (const sides of image.tracks) {
    for (const track of sides) {
      if (!track) continue;
      track.sectors = track.sectors.slice(0, 9);
      track.sectors.forEach((sector, i) => { sector.r = 0xC1 + i; });
    }
  }
  return serializeDSK(image);
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
  it('mounts a raw 800K .dsk into drive A with SAM geometry', async () => {
    const m = machine();
    const r = await m.services.media.mount(raw800k(), 'game.dsk');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('a');

    const img = m.services.disks.image('a')!;
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
      expect(m.services.disks.image('a')).not.toBeNull();
      m.destroy();
    }
  });

  it('mounts a SAM disk that happens to be in a DSK container', async () => {
    // Much of the SAM library is distributed this way, protected dumps
    // especially.
    const m = machine();
    const r = await m.services.media.mount(serializeDSK(blankMgtDisk(80, 2)), 'game.dsk');
    expect(r.ok).toBe(true);
    const img = m.services.disks.image('a')!;
    expect(img.tracks[0][0]!.sectors.map(s => s.r)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    m.destroy();
  });

  it('mounts a DSK container whatever formatted it, rather than guessing', async () => {
    // Sector layout cannot tell a SAM disk from an Amstrad one — the container
    // fixes no geometry, so a +3 disk may hold ten sectors a track and a SAM
    // disk may hold nine. Refusing on a rule like that turns away real SAM
    // disks; an Amstrad disk mounted here simply does not boot.
    const m = machine();
    const r = await m.services.media.mount(cpcDisk(), 'game.dsk');
    expect(r.ok).toBe(true);
    expect(m.services.disks.image('a')).not.toBeNull();
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
    const r = await m.services.media.mount(raw800k(), 'game.mgt', 'b');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('b');
    expect(m.services.disks.image('b')).not.toBeNull();
    expect(m.services.disks.image('a')).toBeNull();
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
    expect(byExt.get('.mgt')).toBe('a');
    expect(byExt.get('.tap')).toBe('tape');
    m.destroy();
  });

  it('names the drives and tracks what is loaded', async () => {
    const m = machine();
    await m.services.media.mount(raw800k(), 'demo.mgt');
    const [d1, d2] = m.services.disks.drives;
    expect(d1.id).toBe('a');
    expect(d1.label).toBe('Drive 1:');
    expect(d1.loaded).toBe(true);
    expect(d1.mediaName).toBe('demo.mgt');
    expect(d2.loaded).toBe(false);
    m.destroy();
  });

  it('saves a mounted disk back out as .mgt', async () => {
    const m = machine();
    await m.services.media.mount(raw800k(), 'demo.mgt');
    const saved = m.services.disks.save('a')!;
    expect(saved.name).toBe('demo.mgt');
    expect(saved.data.length).toBe(819200);
    expect(m.services.disks.save('b')).toBeNull();

    // The SAM's own '1'/'2' spelling still names the same drives, so anything
    // holding an older id keeps working.
    expect(m.services.disks.save('1')!.name).toBe('demo.mgt');
    m.destroy();
  });

  it('ejects', async () => {
    const m = machine();
    await m.services.media.mount(raw800k(), 'demo.mgt');
    m.services.disks.eject('a');
    expect(m.services.disks.image('a')).toBeNull();
    expect(m.services.disks.drives[0].mediaName).toBe('');
    m.destroy();
  });
});
