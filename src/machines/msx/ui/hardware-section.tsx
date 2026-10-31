/**
 * MSX-specific Hardware-pane options: the floppy disk interface, and the
 * mapper of the cartridge in slot 1 (shown while one is inserted).
 *
 * Contributed to the generic Hardware pane through the UI manifest
 * (`src/ui/machine-ui.ts`). A machine `ui/` file — one of the few MSX files
 * allowed to import solid-js and the shell/settings/state layers.
 */

import { For, Show, createSignal } from 'solid-js';
import { loadAuxRom } from '@/shell/rom.ts';
import { resetMachine } from '@/shell/lifecycle.ts';
import { cartridgeName, msxDiskRomFailed } from '@/state/machine-state.ts';
import * as settings from '@/store/settings.ts';
import { msxDiskAuxRom } from '@/machines/msx/aux-roms.ts';
import { activeMsx } from '@/machines/msx/ui/active.ts';
import { MSX_MAPPERS, guessMegaRomMapper, isMegaRom, isMsxMapper } from '@/machines/msx/msx-cartridge.ts';

/** The cartridge mapper override: re-inserts the cartridge with the chosen
 *  board and power-cycles. "Automatic" goes back to the guessed one. */
function MsxMapperRow() {
  // Bumped after a change, since the mapper lives on the machine, not in a signal.
  const [version, setVersion] = createSignal(0);
  const current = (): string => {
    version();
    cartridgeName();
    return activeMsx()?.memory.cartridgeMapper ?? 'plain';
  };
  const guessed = (): string => {
    version();
    cartridgeName();
    const rom = activeMsx()?.memory.cartridgeRom;
    if (!rom) return 'plain';
    return isMegaRom(rom) ? guessMegaRomMapper(rom) : 'plain';
  };
  return (
    <div class="slider-row">
      <span
        class="slider-label"
        title={'The bank-switching board of the cartridge in slot 1. It is guessed from the ROM; '
          + 'boards with battery-backed SRAM cannot be told from the code, so pick them here. '
          + 'Changing it power-cycles the machine.'}
      >
        Cartridge mapper
      </span>
      <select
        value={current()}
        onChange={(event) => {
          const value = (event.target as HTMLSelectElement).value;
          const m = activeMsx();
          if (!m || !isMsxMapper(value)) return;
          m.setCartridgeMapper(value);
          setVersion(version() + 1);
          resetMachine();
        }}
      >
        <For each={MSX_MAPPERS}>
          {option => (
            <option value={option.id}>
              {option.id === guessed() ? `${option.label} — detected` : option.label}
            </option>
          )}
        </For>
      </select>
    </div>
  );
}

export function MsxHardwareSection() {
  return (
    <>
    <div class="multiface-row">
      <label
        class={`mf-check${msxDiskRomFailed() ? ' rom-failed' : ''}`}
        title={msxDiskRomFailed() || 'Floppy disk interface (WD2793 + Disk BASIC ROM in slot 3) — drives A:/B:'}
      >
        <input
          type="checkbox"
          checked={settings.msxFloppy()}
          onChange={(event) => {
            const on = (event.target as HTMLInputElement).checked;
            settings.setMsxFloppy(on);
            settings.persistSetting('msx-floppy', on ? 'on' : 'off');
            const m = activeMsx();
            if (!m) return;
            m.setFloppyEnabled(on);
            // The BIOS finds the Disk BASIC ROM in its power-on slot scan, so
            // the card only takes effect after a reset (and once its ROM is in).
            if (on && !m.diskIf.romLoaded) {
              void loadAuxRom(msxDiskAuxRom(m)).then(() => resetMachine());
            } else {
              resetMachine();
            }
          }}
        />
        Floppy (disk interface)
      </label>
    </div>
    <Show when={cartridgeName()}>
      <MsxMapperRow />
    </Show>
    </>
  );
}
