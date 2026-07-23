import { describe, expect, it } from 'vitest';
import { MtxMachine } from '@/machines/mtx/mtx-machine.ts';
import {
  MTX_TYPE07_SIZE,
  parseMtxMfloppy,
} from '@/media/floppy/mtx-mfloppy.ts';

function machine(): MtxMachine {
  const m = new MtxMachine('mtx512', null);
  m.reset();
  return m;
}

describe('Memotech FDX/SDX disk expansion', () => {
  it('maps the controller registers and drive latch at ports 10h-14h', () => {
    const m = machine();
    const raw = new Uint8Array(MTX_TYPE07_SIZE);
    raw[0] = 0xA5;
    m.loadDisk(parseMtxMfloppy(raw), 0);

    // Drive 0, side 0, motor on and ready, double density.
    m.cpu.portOut(0x14, 0x1C);
    expect(m.cpu.portIn(0x14)).toBe(0x28);

    m.cpu.portOut(0x11, 0);
    m.cpu.portOut(0x12, 1);
    m.cpu.portOut(0x10, 0x80);
    expect(m.cpu.portIn(0x14)).toBe(0xA8);
    expect(m.cpu.portIn(0x13)).toBe(0xA5);

    for (let i = 1; i < 256; i++) m.cpu.portIn(0x13);
    expect(m.cpu.portIn(0x14)).toBe(0x68);
  });

  it('uses control bits 0 and 1 to select the second drive and side', () => {
    const m = machine();

    m.cpu.portOut(0x14, 0x1F);

    expect(m.fdc.currentDrive).toBe(1);
    expect(m.fdc.side).toBe(1);
    expect(m.fdx.motorOn).toBe(true);
    expect(m.fdx.doubleDensity).toBe(true);
  });

  it('routes .mfloppy media to both historical FDX drive slots', async () => {
    const m = machine();
    const image = new Uint8Array(MTX_TYPE07_SIZE);

    const result = await m.services.media.mount(image, 'system.mfloppy', 'unit:1');

    expect(result).toMatchObject({ ok: true, target: 'b' });
    expect(m.services.disks.drives[1]).toMatchObject({
      id: 'b',
      label: 'Drive C:',
      loaded: true,
      mediaName: 'system.mfloppy',
    });
    expect(m.services.disks.save('b')).toMatchObject({
      name: 'system.mfloppy',
    });
  });

  it('accepts the explicit Type 07 extension used by MEMU', async () => {
    const m = machine();

    const result = await m.services.media.mount(
      new Uint8Array(MTX_TYPE07_SIZE),
      'blank.mfloppy-07',
    );

    expect(result).toMatchObject({ ok: true, target: 'a' });
  });
});
