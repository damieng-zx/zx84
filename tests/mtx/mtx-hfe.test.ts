import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MtxMachine } from '@/machines/mtx/mtx-machine.ts';
import { MTX_TYPE03_SIZE, parseMtxMfloppy } from '@/media/floppy/mtx-mfloppy.ts';
import { attachHfeBitstream, parseHFE, serializeHFE } from '@/media/floppy/hfe.ts';

// Known payloads on both heads; the HFE codec itself has separate format tests.
const raw = new Uint8Array(MTX_TYPE03_SIZE);
raw.fill(0xa5, 0, 256);
raw.fill(0x3c, 16 * 256, 17 * 256);
const source = parseMtxMfloppy(raw);
attachHfeBitstream(source);
const hfe = serializeHFE(source);

describe('Memotech HFE media integration', () => {
  let m: MtxMachine;
  beforeEach(() => { m = new MtxMachine('mtx512', null); m.reset(); });
  afterEach(() => m.destroy());

  it('advertises HFE to the generic file pickers', () => {
    expect(m.services.media.accepts()).toContainEqual({ ext: '.hfe', target: 'a' });
  });

  it.each([['unit:0', 'a', 0], ['unit:1', 'b', 1]] as const)(
    'reads and writes HFE through the controller on %s', async (target, id, unit) => {
      expect(await m.services.media.mount(hfe, 'system.HFE', target)).toMatchObject({ ok: true, target: id });
      expect(m.services.disks.image(unit === 0 ? 'b' : 'a')).toBeNull();
      // Drive select, head 1, motor on and ready, double density.
      m.cpu.portOut(0x14, 0x1e | unit);
      m.cpu.portOut(0x11, 0);
      m.cpu.portOut(0x12, 1);
      m.cpu.portOut(0x10, 0x80);
      const sector = Uint8Array.from({ length: 256 }, () => m.cpu.portIn(0x13));
      expect(sector).toEqual(new Uint8Array(256).fill(0x3c));

      m.cpu.portOut(0x10, 0xa0); // Write Sector, same head and sector.
      for (let i = 0; i < 256; i++) m.cpu.portOut(0x13, 0x6c);
      const saved = m.services.disks.save(id)!;
      expect(saved.name).toBe('system.hfe');
      expect(new TextDecoder().decode(saved.data.subarray(0, 8))).toBe('HXCPICFE');
      const reloaded = parseHFE(saved.data);
      expect(reloaded.tracks[0][1]!.sectors[0].data).toEqual(new Uint8Array(256).fill(0x6c));
      expect(reloaded.tracks[0][0]!.sectors[0].data).toEqual(new Uint8Array(256).fill(0xa5));
    },
  );

  it('does not replace a mounted disk when HFE input is malformed', async () => {
    await m.services.media.mount(raw, 'original.mfloppy-03');
    const original = m.services.disks.image('a');
    const result = await m.services.media.mount(new Uint8Array(10), 'broken.hfe');
    expect(result).toMatchObject({ ok: false, message: 'HFE error: HFE file too small' });
    expect(m.services.disks.image('a')).toBe(original);
  });

  it('reports unsupported HFE v3 without mounting it', async () => {
    const v3 = new Uint8Array(512);
    v3.set(new TextEncoder().encode('HXCHFEV3'));
    const result = await m.services.media.mount(v3, 'v3.hfe');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('HFE v3 images are not yet supported');
    expect(m.services.disks.image('a')).toBeNull();
  });

  it('rejects HFE when the floppy hardware is disabled', async () => {
    m.setFloppyEnabled(false);
    expect(await m.services.media.mount(hfe, 'system.hfe')).toMatchObject({
      ok: false, message: 'Enable the FDX floppy subsystem first',
    });
    expect(m.fdc.getDiskImage(0)).toBeNull();
  });

  it('returns to MFLOPPY saving when an HFE disk is replaced', async () => {
    await m.services.media.mount(hfe, 'system.hfe');
    m.services.disks.eject('a');
    await m.services.media.mount(raw, 'replacement.mfloppy-03');
    const saved = m.services.disks.save('a')!;
    expect(saved.name).toBe('replacement.mfloppy-03');
    expect(saved.data).toEqual(raw);
  });
});
