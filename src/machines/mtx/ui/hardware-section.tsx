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
          title="Fit the 512 KiB SDX/FDX RAM expansion"
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
          512KB RAM
        </label>
      </div>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Fit the FDX/SDX floppy subsystem — drives B:/C: and the FDX Disk BASIC ROM (CP/M requires it)"
        >
          <input
            type="checkbox"
            checked={settings.mtxFloppy() || settings.mtxCpm()}
            disabled={settings.mtxCpm()}
            onChange={(event) => {
              const enabled = (event.target as HTMLInputElement).checked;
              settings.setMtxFloppy(enabled);
              settings.persistSetting('mtx-floppy', enabled ? 'on' : 'off');
              activeMtx()?.setFloppyEnabled(enabled);
              resetMachine();
            }}
          />
          Floppy (FDX)
        </label>
      </div>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Configure an MTX512 or RS128 with the FDX 80-column display for CP/M"
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
          CP/M
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
        80-columns
        </label>
      </div>
    </>
  );
}
