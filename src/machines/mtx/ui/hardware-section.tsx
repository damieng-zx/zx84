/**
 * MTX-specific Hardware-pane options.
 *
 * This contribution may narrow to its own machine folder; the generic Hardware
 * pane remains machine-blind and loads it through the UI manifest.
 */

import { machine } from '@/shell/context.ts';
import * as settings from '@/store/settings.ts';
import type { MtxMachine } from '../mtx-machine.ts';

function activeMtx(): MtxMachine | null {
  return machine?.kind === 'mtx' ? machine as unknown as MtxMachine : null;
}

export function MtxHardwareSection() {
  return (
    <div class="multiface-row">
      <label
        class="mf-check"
        title="Fit the FDX 6845-based 80×24 colour display and show its monitor"
      >
        <input
          type="checkbox"
          checked={settings.mtx80Column()}
          onChange={(event) => {
            const enabled = (event.target as HTMLInputElement).checked;
            settings.setMtx80Column(enabled);
            settings.persistSetting('mtx-80-column', enabled ? 'on' : 'off');
            activeMtx()?.set80ColumnEnabled(enabled);
          }}
        />
        FDX 80-column display
      </label>
    </div>
  );
}
