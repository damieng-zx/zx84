import { describe, expect, it } from 'vitest';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import { SamMachine } from '@/machines/sam/sam-machine.ts';
import { blankMgtDisk, serializeMgt } from '@/media/floppy/mgt-image.ts';
import { blankTrdDisk, serializeTrd } from '@/media/floppy/trd-image.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';

const dsk = () => serializeDSK(blankMgtDisk(40, 1));
const cases = [
  { name: '+3', create: () => new Spectrum('+3', null), bytes: dsk, ext: 'dsk' },
  { name: 'CPC', create: () => new CpcMachine('cpc6128', null), bytes: dsk, ext: 'dsk' },
  { name: 'Einstein', create: () => new EinsteinMachine('einstein-tc01', null), bytes: dsk, ext: 'dsk' },
  { name: 'SAM', create: () => new SamMachine('sam512', null), bytes: dsk, ext: 'dsk' },
  {
    name: '+D', ext: 'mgt', bytes: () => serializeMgt(blankMgtDisk(80, 2), 'mgt'),
    create: () => { const s = new Spectrum('48k', null); s.mgtPlusD.enabled = true; return s; },
  },
  {
    name: 'Beta Disk', ext: 'trd', bytes: () => serializeTrd(blankTrdDisk(80, 2)),
    create: () => { const s = new Spectrum('48k', null); s.betaDisk.enabled = true; return s; },
  },
];

describe.each(cases)('$name disk mounts preserve execution state', ({ create, bytes, ext }) => {
  it.each([false, true])('preserves running=%s after a successful mount and a rejected image', async (running) => {
    const m = create();
    if (running) await m.start();
    else m.stop();
    const state = m as unknown as { running: boolean };
    try {
      const mounted = await m.services.media.mount(bytes(), `valid.${ext}`);
      expect(mounted.ok).toBe(true);
      expect(state.running).toBe(running);
      const rejected = await m.services.media.mount(new Uint8Array(4), `broken.${ext}`);
      expect(rejected.ok).toBe(false);
      expect(state.running).toBe(running);
    } finally {
      m.destroy();
    }
  });
});
