import { For, Show, type JSX } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import {
  setSystemRom, resetSystemRom, setSystemRomPage, resetSystemRomPage,
} from '@/shell/rom.ts';
import { loadFile, ejectCartridge } from '@/shell/media.ts';
import { romSlots, cartridgeName } from '@/state/machine-state.ts';
import { machineCaps } from '@/state/machine-caps.ts';
import type { RomPage } from '@/managers/rom-manager.ts';
import { openFile } from '@/ui/file-picker.ts';

/** Format a byte count as a compact KB/byte string. */
function fmtSize(n: number): string {
  if (n <= 0) return '';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} KB`;
}

function EjectIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
      <path d="M8 2L2 10h12L8 2zM2 12v2h12v-2H2z" />
    </svg>
  );
}

/**
 * A standard media slot, matching the Tape/Disk look: a labelled box showing the
 * current contents (or an italic placeholder when empty), clickable to load, with
 * an eject button when there is something to remove.
 */
function Slot(props: {
  label: string;
  text: string;
  placeholder: string;
  ejectable: boolean;
  ejectTitle: string;
  onLoad: () => void;
  onEject: () => void;
}): JSX.Element {
  return (
    <div class="rom-slot-row">
      <span class="rom-slot-label">{props.label}</span>
      <div class="media-slot clickable" onClick={props.onLoad} title={`Load ${props.label}`}>
        <span class="media-slot-text" title={props.text}>
          {props.text || props.placeholder}
        </span>
        <Show when={props.ejectable}>
          <button
            class="tape-eject"
            title={props.ejectTitle}
            onClick={(e) => { e.stopPropagation(); props.onEject(); }}
          >
            <EjectIcon />
          </button>
        </Show>
      </div>
    </div>
  );
}

/**
 * ROM / Carts pane — manage the machine's system ROM sockets and, on machines
 * with a cartridge slot, a mounted ROM cartridge. The socket list comes from the
 * machine's RomService.systemSlots (one entry per socket: single-ROM models have
 * 1; 128K/+2 have 2; +2A/+3 have 4). Shown for every machine that has a system
 * ROM socket, a multi-page ROM, or a cartridge slot.
 */
export function RomPane(): JSX.Element {
  const slots = romSlots;

  async function loadSlot(index: number, multi: boolean): Promise<void> {
    const id = `zx84-system-rom${multi ? `-page${index}` : ''}`;
    const results = await openFile({ id, extensions: ['.rom', '.bin'] });
    if (!results) return;
    if (multi) await setSystemRomPage(index as RomPage, results[0].data, results[0].name);
    else await setSystemRom(results[0].data, results[0].name);
  }

  async function ejectSlot(index: number, multi: boolean): Promise<void> {
    if (multi) await resetSystemRomPage(index as RomPage);
    else await resetSystemRom();
  }

  async function insertCartridge(): Promise<void> {
    const results = await openFile({ id: 'zx84-cartridge', extensions: ['.rom', '.cpr', '.zip'] });
    if (!results) return;
    await loadFile(results[0].data, results[0].name);   // routes .rom/.cpr → cartridge
  }

  const showCartridgeSlot = (): boolean => machineCaps().cartridge;
  // On the Plus range the cartridge IS the boot source — no separate on-board
  // ROM to upload, so the system-ROM socket is suppressed to avoid showing two
  // competing cartridge entries.
  const showSystemRomSlot = (): boolean => machineCaps().systemRomSlot !== false;

  // The fixed socket name: slot.title (multi-page machines) or the descriptor's
  // systemRomLabel (single-ROM machines).
  const slotTitle = (s: { title?: string }): string =>
    s.title ?? machineCaps().systemRomLabel;

  const slotText = (s: { label: string; size: number }): string => {
    if (!s.label) return '';
    const size = fmtSize(s.size);
    return size ? `${s.label} · ${size}` : s.label;
  };

  return (
    <Pane
      id="rom-panel"
      label="ROM / Carts"
      visible={showCartridgeSlot() || slots().length > 0}
    >
      <div class="rom-grid">
        <Show when={showSystemRomSlot()}>
          <For each={slots()}>
            {(s) => {
              const multi = slots().length > 1;
              const title = slotTitle(s);
              return (
                <Slot
                  label={title}
                  text={slotText(s)}
                  placeholder="(default)"
                  ejectable={s.overridden}
                  ejectTitle={`Revert to the default ${title}`}
                  onLoad={() => loadSlot(s.index, multi)}
                  onEject={() => ejectSlot(s.index, multi)}
                />
              );
            }}
          </For>
        </Show>
        <Show when={showCartridgeSlot()}>
          <Slot
            label="Cartridge"
            text={cartridgeName()}
            placeholder="No cartridge"
            ejectable={!!cartridgeName()}
            ejectTitle="Eject cartridge"
            onLoad={insertCartridge}
            onEject={ejectCartridge}
          />
        </Show>
      </div>
    </Pane>
  );
}
