/**
 * Mounting a tape must not change whether the machine is running.
 *
 * The sibling of disk-pause.test.ts, for the cassette path. Parsing and
 * mountBlocks are synchronous, so no machine needs stopping to swap a tape —
 * and the failure path matters most: the shell returns early on !ok without
 * unpausing, so a mount that restarts the machine there leaves a deliberately
 * paused machine running behind the user's back.
 */

import { describe, expect, it } from 'vitest';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { SamMachine } from '@/machines/sam/sam-machine.ts';
import { JupiterAceMachine } from '@/machines/jupiter-ace/ace-machine.ts';

/** One Spectrum-style .tap block: [len16][flag, payload, checksum]. */
const spectrumTap = () => new Uint8Array([0x03, 0x00, 0xFF, 0x01, 0xFE]);
/** One Ace .tap chunk: [len16][bytes] — the Ace stores no flag byte. */
const aceTap = () => new Uint8Array([0x02, 0x00, 0x01, 0x02]);

const cases = [
  { name: 'Spectrum', create: () => new Spectrum('48k', null), bytes: spectrumTap },
  { name: 'CPC', create: () => new CpcMachine('cpc6128', null), bytes: spectrumTap },
  { name: 'SAM', create: () => new SamMachine('sam512', null), bytes: spectrumTap },
  { name: 'Jupiter Ace', create: () => new JupiterAceMachine('jupiter-ace', null), bytes: aceTap },
];

describe.each(cases)('$name tape mounts preserve execution state', ({ create, bytes }) => {
  it.each([false, true])('preserves running=%s across a good tape and a rejected one', async (running) => {
    const m = create();
    if (running) await m.start();
    else m.stop();
    const state = m as unknown as { running: boolean };
    try {
      const mounted = await m.services.media.mount(bytes(), 'valid.tap');
      expect(mounted.ok).toBe(true);
      expect(state.running, 'a successful mount must not change running').toBe(running);

      // A .tzx that is not one: the parser throws. Garbage in a .tap would
      // not do — that parser yields no blocks rather than failing.
      const rejected = await m.services.media.mount(new Uint8Array(4), 'broken.tzx');
      expect(rejected.ok).toBe(false);
      expect(state.running, 'a rejected tape must not change running').toBe(running);
    } finally {
      m.destroy();
    }
  });
});
