/**
 * Atari disk-service tests: both drives, sector I/O, write protection,
 * persistence and the SIO status block.
 */

import { describe, it, expect } from 'vitest';
import { AtariDiskService } from '@/machines/atari/services/disks.ts';
import { ATR_HEADER_SIZE, ATR_MAGIC, parseAtr } from '@/media/floppy/atr.ts';

function makeAtr(sectorSize: 128 | 256 = 128, sectors = 720): Uint8Array {
  const payload = sectorSize === 128 ? sectors * 128 : 3 * 128 + (sectors - 3) * 256;
  const atr = new Uint8Array(ATR_HEADER_SIZE + payload);
  atr[0] = ATR_MAGIC & 0xff;
  atr[1] = ATR_MAGIC >> 8;
  const paragraphs = payload >> 4;
  atr[2] = paragraphs & 0xff;
  atr[3] = (paragraphs >> 8) & 0xff;
  atr[4] = sectorSize === 128 ? 128 : 0;
  atr[5] = sectorSize === 128 ? 0 : 1;
  for (let n = 1; n <= sectors; n++) {
    const off = sectorSize === 128
      ? ATR_HEADER_SIZE + (n - 1) * 128
      : (n <= 3 ? ATR_HEADER_SIZE + (n - 1) * 128
        : ATR_HEADER_SIZE + 3 * 128 + (n - 4) * 256);
    const len = sectorSize === 128 || n <= 3 ? 128 : 256;
    atr.fill(n & 0xff, off, off + len);
  }
  return atr;
}

describe('atari disk service', () => {
  it('inserts an ATR, reads it and reports the geometry', () => {
    const svc = new AtariDiskService();
    svc.insert('a', makeAtr(), 'game.atr');
    expect(svc.drives[0]).toMatchObject({ id: 'a', label: 'D1:', loaded: true, mediaName: 'game.atr' });
    expect(svc.drives[1].loaded).toBe(false);
    const sector = svc.readSector(0x31, 19)!;
    expect(sector.length).toBe(128);
    expect(sector[0]).toBe(19);
    expect(svc.image('a')?.numTracks).toBe(40);
  });

  it('writes sectors, sets the dirty flag and can be saved back to ATR', () => {
    const svc = new AtariDiskService();
    svc.insert('a', makeAtr(), 'game.atr');
    expect(svc.writeSector(0x31, 5, new Uint8Array(128).fill(0x99))).toBe(true);
    expect(svc.readSector(0x31, 5)![127]).toBe(0x99);
    const saved = svc.save('a')!;
    expect(saved.name).toBe('game.atr');
    expect(parseAtr(saved.data)!.readSector(5)![0]).toBe(0x99);
  });

  it('refuses writes to a protected disk', () => {
    const svc = new AtariDiskService();
    svc.insert('a', makeAtr(), 'game.atr');
    svc.setWriteProtect('a', true);
    expect(svc.writeSector(0x31, 1, new Uint8Array(128).fill(0x11))).toBe(false);
    expect(svc.readSector(0x31, 1)![0]).toBe(1);
    // Status byte 0 bit 3 is write protect; byte 1 is the inverted controller
    // status, whose bit 6 goes low for a protected disk.
    expect(svc.statusBytes(0x31)[0] & 0x08).toBe(0x08);
    expect(svc.statusBytes(0x31)[1]).toBe(0xbf);
  });

  it('returns the 810 timeout byte in the status block', () => {
    const svc = new AtariDiskService();
    expect(svc.statusBytes(0x31)[2]).toBe(0xe0); // a property of the drive, disk or not
    svc.insert('b', makeAtr(128, 720), 'd2.atr');
    expect(svc.statusBytes(0x32)[2]).toBe(0xe0);
    expect(svc.driveForDevice(0x32)?.id).toBe('b');
    expect(svc.driveForDevice(0x33)).toBeNull();
  });

  it('accepts a DskImage carried across a model rebuild', () => {
    const source = new AtariDiskService();
    source.insert('a', makeAtr(), 'game.atr');
    const image = source.image('a')!;
    const target = new AtariDiskService();
    target.insert('a', image, 'game.atr');
    expect(target.readSector(0x31, 1)![0]).toBe(1);
    expect(target.readSector(0x31, 19)![0]).toBe(19);
  });

  it('ejects and reports an empty drive', () => {
    const svc = new AtariDiskService();
    svc.insert('a', makeAtr(), 'game.atr');
    svc.eject('a');
    expect(svc.drives[0].loaded).toBe(false);
    expect(svc.readSector(0x31, 1)).toBeNull();
    expect(svc.save('a')).toBeNull();
    expect(svc.image('a')).toBeNull();
    // Controller status inverted: bit 7 low = not ready (no disk).
    expect(svc.statusBytes(0x31)[1]).toBe(0x7f);
  });
});

describe('atari drive list', () => {
  const names = (svc: AtariDiskService) => svc.drives.map(d => `${d.label}${d.mediaName}`);

  it('starts with two SIO2PC drives', () => {
    const svc = new AtariDiskService();
    expect(svc.driveModels).toEqual(['sio2pc', 'sio2pc']);
    expect(svc.states.map(s => s.device)).toEqual([0x31, 0x32]);
  });

  it('adds a drive below the current one with the same model, moving the rest down', () => {
    const svc = new AtariDiskService(['1050', '810']);
    svc.insert('a', makeAtr(), 'one.atr');
    svc.insert('b', makeAtr(), 'two.atr');
    expect(svc.addDrive(0)).toBe(true);
    expect(svc.driveModels).toEqual(['1050', '1050', '810']);
    expect(names(svc)).toEqual(['D1:one.atr', 'D2:', 'D3:two.atr']);
    expect(svc.states.map(s => s.id)).toEqual(['a', 'b', 'c']);
    // The disk that moved down answers at its new device number.
    expect(svc.readSector(0x33, 1)).not.toBeNull();
    expect(svc.driveForDevice(0x32)!.disk).toBeNull();
  });

  it('removes a drive with its disk, moving the rest up', () => {
    const svc = new AtariDiskService(['1050', '810', 'xf551']);
    svc.insert('a', makeAtr(), 'one.atr');
    svc.insert('b', makeAtr(), 'two.atr');
    svc.insert('c', makeAtr(), 'three.atr');
    expect(svc.removeDrive(1)).toBe(true);
    expect(svc.driveModels).toEqual(['1050', 'xf551']);
    expect(names(svc)).toEqual(['D1:one.atr', 'D2:three.atr']);
    expect(svc.driveForDevice(0x33)).toBeNull();
  });

  it('keeps at least one drive and at most four', () => {
    const svc = new AtariDiskService(['810']);
    expect(svc.removeDrive(0)).toBe(false);
    expect(svc.addDrive(0)).toBe(true);
    expect(svc.addDrive(1)).toBe(true);
    expect(svc.addDrive(2)).toBe(true);
    expect(svc.addDrive(3)).toBe(false);
    expect(svc.driveModels).toEqual(['810', '810', '810', '810']);
  });

  it('leaves write protect on the drive position as the drives move', () => {
    const svc = new AtariDiskService(['810', '810']);
    svc.setWriteProtect('b', true);
    svc.addDrive(0);
    expect(svc.states.map(s => s.writeProtected)).toEqual([false, true, false]);
  });

  it('configure keeps disks in the drives that stay, and changes nothing when nothing differs', () => {
    const svc = new AtariDiskService(['810', '810']);
    svc.insert('a', makeAtr(), 'one.atr');
    svc.configure(['810', '810']);
    expect(names(svc)).toEqual(['D1:one.atr', 'D2:']);
    svc.configure(['1050', '810', 'xf551']);
    expect(svc.driveModels).toEqual(['1050', '810', 'xf551']);
    expect(names(svc)[0]).toBe('D1:one.atr');
    svc.configure(['xf551']);
    expect(svc.drives).toHaveLength(1);
    expect(svc.drives[0].mediaName).toBe('one.atr');
  });

  it('judges each disk by its own drive', () => {
    const svc = new AtariDiskService(['810', '1050']);
    svc.insert('a', makeAtr(128, 1040), 'ed.atr');
    svc.insert('b', makeAtr(128, 1040), 'ed.atr');
    expect(svc.canRead(0x31)).toBe(false);
    expect(svc.canRead(0x32)).toBe(true);
    expect(svc.readSector(0x31, 1)).toBeNull();
    expect(svc.readSector(0x32, 1)).not.toBeNull();
    expect(svc.statusBytes(0x32)[0] & 0x80).toBe(0x80);
  });
});
