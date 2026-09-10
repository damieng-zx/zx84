/**
 * The Lynx's FD1793 disk interface (96K/128K only).
 *
 * The controller itself is the shared WD179x core; these cover the machine's
 * own disk service, the .ldf media routing, the Drive pane feed and the DOS
 * ROM memory region.
 */

import { describe, expect, it } from 'vitest';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';
import { createFrameIndicators } from '@/machines/machine.ts';

const SPT = 10;
const SB = 512;

function makeLdf(tracks: number, sides: number): Uint8Array {
  const out = new Uint8Array(tracks * sides * SPT * SB);
  for (let c = 0; c < tracks; c++) {
    for (let h = 0; h < sides; h++) {
      const base = (c * sides + h) * SPT * SB;
      for (let s = 0; s < SPT; s++) out[base + s * SB] = c;
    }
  }
  return out;
}

describe('Lynx disk media', () => {
  it('mounts a .ldf into drive A through the media service', async () => {
    const m = new LynxMachine('lynx128', null);
    const res = await m.services.media.mount(makeLdf(80, 2), 'game.ldf');
    expect(res.ok).toBe(true);
    expect(res.target).toBe('a');
    expect(m.services.disks.image('a')).not.toBeNull();
    expect(m.services.disks.drives[0].loaded).toBe(true);
    expect(m.services.disks.drives[0].mediaName).toBe('game.ldf');
    m.destroy();
  });

  it('routes a disk to drive B when asked', async () => {
    const m = new LynxMachine('lynx128', null);
    const res = await m.services.media.mount(makeLdf(40, 1), 'b.ldf', 'b');
    expect(res.target).toBe('b');
    expect(m.services.disks.drives[0].loaded).toBe(false);
    expect(m.services.disks.drives[1].loaded).toBe(true);
    m.destroy();
  });

  it('refuses a disk on the 48K, which has no interface', async () => {
    const m = new LynxMachine('lynx48', null);
    const res = await m.services.media.mount(makeLdf(80, 2), 'game.ldf');
    expect(res.ok).toBe(false);
    expect(m.services.media.accepts().some(t => t.ext === '.ldf')).toBe(false);
    m.destroy();
  });

  it('refuses bytes that are not a Lynx geometry', async () => {
    const m = new LynxMachine('lynx128', null);
    const res = await m.services.media.mount(new Uint8Array(12345), 'x.ldf');
    expect(res.ok).toBe(false);
    m.destroy();
  });

  it('saves the drive back as an .ldf', async () => {
    const m = new LynxMachine('lynx128', null);
    await m.services.media.mount(makeLdf(80, 2), 'game.ldf');
    const saved = m.services.disks.save('a')!;
    expect(saved.name).toBe('game.ldf');
    expect(saved.data.length).toBe(819200);
    m.destroy();
  });

  it('ejects back to an empty drive', async () => {
    const m = new LynxMachine('lynx128', null);
    await m.services.media.mount(makeLdf(80, 2), 'game.ldf');
    m.services.disks.eject('a');
    expect(m.services.disks.image('a')).toBeNull();
    expect(m.services.disks.drives[0].loaded).toBe(false);
    m.destroy();
  });

  it('carries a per-drive write-protect flag', () => {
    const m = new LynxMachine('lynx128', null);
    expect(m.services.disks.drives[1].writeProtected).toBe(false);
    m.services.disks.setWriteProtect('b', true);
    expect(m.services.disks.drives[1].writeProtected).toBe(true);
    expect(m.services.disks.drives[0].writeProtected).toBe(false);
    m.destroy();
  });
});

describe('Lynx drive panel feed', () => {
  it('reports two drives and no microdrives on a disk model', () => {
    const m = new LynxMachine('lynx128', null);
    const out = createFrameIndicators();
    m.services.probe.sample(out);
    expect(out.driveLed[0]).toBe(0);
    expect(out.driveLed[1]).toBe(0);
    expect(out.driveLed[2]).toBe(-1);
    expect(out.driveLed[3]).toBe(-1);
    expect(out.mdvCount).toBe(0);
    expect(out.floppySlot).toBe(0);        // the selected drive
    expect(out.floppyMotor).toBe(false);
    m.destroy();
  });

  it('leaves the panel absent on the 48K', () => {
    const m = new LynxMachine('lynx48', null);
    const out = createFrameIndicators();
    m.services.probe.sample(out);
    expect(out.driveLed[0]).toBe(-1);
    expect(out.floppySlot).toBe(-1);
    m.destroy();
  });

  it('follows the selected drive and motor for the sound feed', () => {
    const m = new LynxMachine('lynx128', null);
    m.fdc.currentDrive = 1;
    m.fdc.motorOn = true;
    const out = createFrameIndicators();
    m.services.probe.sample(out);
    expect(out.floppySlot).toBe(1);
    expect(out.floppyMotor).toBe(true);
    m.destroy();
  });

  it('exposes the DOS ROM as a memory region', () => {
    const m = new LynxMachine('lynx128', null);
    const rom = m.resolveMemoryRegion('rom-dos');
    expect(rom).not.toBeNull();
    expect(rom!.data.length).toBe(0x2000);
    expect(rom!.baseAddr).toBe(0xe000);
    expect(m.resolveMemoryRegion('nope')).toBeNull();
    m.destroy();
  });

  it('has no DOS ROM region on the 48K', () => {
    const m = new LynxMachine('lynx48', null);
    expect(m.resolveMemoryRegion('rom-dos')).toBeNull();
    m.destroy();
  });
});
