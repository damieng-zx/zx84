/**
 * SAM Coupé disk interface — two WD1772 controllers.
 *
 * Port decode (from SimCoupe's `Base/SAMIO.cpp` dispatch and `Base/Drive.cpp`):
 *
 *   0xE0-0xE7  drive 1        0xF0-0xF7  drive 2
 *   port & 3   register: 0 status/command, 1 track, 2 sector, 3 data
 *   (port >> 2) & 1   head
 *
 * The head is selected by which address is used rather than by a control
 * register, and the two drives are independent controllers.
 */

import { describe, expect, it } from 'vitest';
import { SamDiskInterface } from '@/machines/sam/peripherals/sam-disk.ts';
import { blankMgtDisk, serializeMgt } from '@/media/floppy/mgt-image.ts';

describe('SAM disk port decode', () => {
  it('claims 0xE0-0xE7 for drive 1 and 0xF0-0xF7 for drive 2', () => {
    for (let p = 0xE0; p <= 0xE7; p++) expect(SamDiskInterface.driveFor(p)).toBe(0);
    for (let p = 0xF0; p <= 0xF7; p++) expect(SamDiskInterface.driveFor(p)).toBe(1);
  });

  it('leaves the ASIC register range alone', () => {
    // 0xF8-0xFF are the CLUT, status, paging, MIDI, border and SAA ports —
    // a greedier mask here would swallow the whole machine.
    for (let p = 0xF8; p <= 0xFF; p++) expect(SamDiskInterface.driveFor(p)).toBe(-1);
    for (let p = 0xE8; p <= 0xEF; p++) expect(SamDiskInterface.driveFor(p)).toBe(-1);
    expect(SamDiskInterface.driveFor(0x1F)).toBe(-1);
    expect(SamDiskInterface.driveFor(0x00)).toBe(-1);
  });

  it('honours the full 16-bit port, decoding only the low byte', () => {
    expect(SamDiskInterface.driveFor(0x12E0)).toBe(0);
    expect(SamDiskInterface.driveFor(0xFFF3)).toBe(1);
  });

  it('routes the low two address bits to the four WD1772 registers', () => {
    const d = new SamDiskInterface();
    d.write(0xE1, 0x2A);            // track register
    d.write(0xE2, 0x07);            // sector register
    expect(d.read(0xE1)).toBe(0x2A);
    expect(d.read(0xE2)).toBe(0x07);
  });

  it('keeps the two drives independent', () => {
    const d = new SamDiskInterface();
    d.write(0xE1, 0x11);            // drive 1 track
    d.write(0xF1, 0x22);            // drive 2 track
    expect(d.read(0xE1)).toBe(0x11);
    expect(d.read(0xF1)).toBe(0x22);
  });

  it('selects the head from address bit 2', () => {
    const d = new SamDiskInterface();
    d.read(0xE0);                   // 0xE0-0xE3 -> side 0
    expect(d.fdc[0].side).toBe(0);
    d.read(0xE4);                   // 0xE4-0xE7 -> side 1
    expect(d.fdc[0].side).toBe(1);
    d.read(0xE1);
    expect(d.fdc[0].side).toBe(0);
  });

  it('reads open bus from a port that is not a drive', () => {
    const d = new SamDiskInterface();
    expect(d.read(0x00F9)).toBe(0xFF);
  });
});

describe('SAM disk media', () => {
  it('reports the WD1772 motor-on convention in status bit 7', () => {
    // The 1770/1772 puts MOTOR ON where the 1793 puts NOT READY. A drive with
    // no disk and no command running must not look busy.
    const d = new SamDiskInterface();
    expect(d.motorOn(0)).toBe(false);
    expect(d.read(0xE0) & 0x01).toBe(0);   // BUSY clear
  });

  it('accepts an 800K image in either drive', () => {
    const d = new SamDiskInterface();
    expect(d.image(0)).toBeNull();
    d.insert(0, blankMgtDisk(80, 2));
    expect(d.image(0)).not.toBeNull();
    expect(d.image(1)).toBeNull();

    d.insert(1, blankMgtDisk(80, 2));
    expect(d.image(1)).not.toBeNull();
  });

  it('ejects again', () => {
    const d = new SamDiskInterface();
    d.insert(0, blankMgtDisk(80, 2));
    d.eject(0);
    expect(d.image(0)).toBeNull();
  });

  it('carries a per-drive write-protect flag', () => {
    const d = new SamDiskInterface();
    expect(d.writeProtected(0)).toBe(false);
    d.setWriteProtect(0, true);
    expect(d.writeProtected(0)).toBe(true);
    expect(d.writeProtected(1)).toBe(false);
  });

  it('presents the SAM 800K geometry: 80 cylinders, 2 heads, 10 sectors of 512', () => {
    const img = blankMgtDisk(80, 2);
    expect(img.numTracks).toBe(80);
    expect(img.numSides).toBe(2);
    const t0 = img.tracks[0][0]!;
    expect(t0.sectors).toHaveLength(10);
    // Sector IDs run 1..10 and the size code N=2 means 512 bytes.
    expect(t0.sectors.map(s => s.r)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(t0.sectors.every(s => s.n === 2 && s.data.length === 512)).toBe(true);
    // ...which is exactly 800K.
    expect(serializeMgt(img, 'mgt').length).toBe(819200);
  });

  it('clears both controllers on reset', () => {
    const d = new SamDiskInterface();
    d.write(0xE1, 0x33);
    d.write(0xF1, 0x44);
    d.reset();
    expect(d.read(0xE1)).toBe(0);
    expect(d.read(0xF1)).toBe(0);
  });
});

describe('SAM drive panel feed', () => {
  it('reports both drives, and only both', async () => {
    const { SamMachine } = await import('@/machines/sam/sam-machine.ts');
    const { createFrameIndicators } = await import('@/machines/machine.ts');
    const m = new SamMachine('sam512', null);
    const out = createFrameIndicators();
    m.services.probe.sample(out);

    // Slots 0/1 are the internal drives; 2/3 must read as absent (-1) so the
    // pane shows two rows, not four.
    expect(out.driveLed[0]).toBe(0);
    expect(out.driveLed[1]).toBe(0);
    expect(out.driveLed[2]).toBe(-1);
    expect(out.driveLed[3]).toBe(-1);
    // The SAM has no microdrives.
    expect(out.mdvCount).toBe(0);
    // Its drives are 3.5", which selects the drive-sound profile.
    expect(out.floppyProfile).toBe(1);
    expect(out.floppySlot).toBe(-1);      // nothing spinning yet
    m.destroy();
  });

  it('lights the drive LED and feeds drive sound while the motor runs', async () => {
    const { SamMachine } = await import('@/machines/sam/sam-machine.ts');
    const { createFrameIndicators } = await import('@/machines/machine.ts');
    const m = new SamMachine('sam512', null);
    m.disk.insert(0, blankMgtDisk(80, 2));
    // A RESTORE spins the motor up.
    m.disk.write(0xE0, 0x09);

    const out = createFrameIndicators();
    m.services.probe.sample(out);
    expect(m.disk.motorOn(0)).toBe(true);
    expect(out.driveLed[0]).toBeGreaterThan(0);
    expect(out.floppySlot).toBe(0);
    expect(out.floppyMotor).toBe(true);
    m.destroy();
  });

  it('exposes the drive images to the post-format refresh', async () => {
    const { SamMachine } = await import('@/machines/sam/sam-machine.ts');
    const m = new SamMachine('sam512', null);
    m.disk.insert(1, blankMgtDisk(80, 2));
    expect(m.services.probe.diskImageForSlot(0)).toBeNull();
    expect(m.services.probe.diskImageForSlot(1)).not.toBeNull();
    expect(m.services.probe.diskImageForSlot(2)).toBeNull();
    m.destroy();
  });
});
