/**
 * MTX-specific Hardware-pane options.
 *
 * This contribution may narrow to its own machine folder; the generic Hardware
 * pane remains machine-blind and loads it through the UI manifest.
 */

import { machine } from '@/shell/context.ts';
import { resetMachine, switchModel } from '@/shell/lifecycle.ts';
import { applyBootDisk } from '@/shell/media.ts';
import * as settings from '@/store/settings.ts';
import type { MtxMachine } from '../mtx-machine.ts';

function activeMtx(): MtxMachine | null {
  return machine?.kind === 'mtx' ? machine as unknown as MtxMachine : null;
}

export function MtxHardwareSection() {
  return (
    <>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Fit the 512 KiB SDX/FDX RAM expansion (576 KiB total on an MTX512)"
        >
          <input
            type="checkbox"
            checked={settings.mtx512kRam()}
            onChange={(event) => {
              const enabled = (event.target as HTMLInputElement).checked;
              settings.setMtx512kRam(enabled);
              settings.persistSetting('mtx-512k-ram', enabled ? 'on' : 'off');
              activeMtx()?.set512kRamEnabled(enabled);
              resetMachine();
            }}
          />
          512 KiB RAM expansion
        </label>
      </div>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Configure an MTX512 with the FDX 80-column display for CP/M"
        >
          <input
            type="checkbox"
            checked={settings.mtxCpm()}
            onChange={(event) => {
              const enabled = (event.target as HTMLInputElement).checked;
              settings.setMtxCpm(enabled);
              settings.persistSetting('mtx-cpm', enabled ? 'on' : 'off');
              const mtx = activeMtx();
              if (enabled && mtx?.model === 'mtx500') {
                void switchModel('mtx512');
                return;
              }
              mtx?.setCpmSystemEnabled(enabled);
              void applyBootDisk().then(resetMachine);
            }}
          />
          CP/M system
        </label>
      </div>
      <div class="multiface-row">
        <label
        class="mf-check"
        title="Fit the FDX 6845-based 80×24 colour display and show its monitor"
      >
        <input
          type="checkbox"
          checked={settings.mtxCpm() || settings.mtx80Column()}
          disabled={settings.mtxCpm()}
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
    </>
  );
}
