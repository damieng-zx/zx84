import { For, Show, type JSX } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import {
  setSystemRom, resetSystemRom, setSystemRomPage, resetSystemRomPage,
} from '@/shell/rom.ts';
import { loadFile, ejectCartridge } from '@/shell/media.ts';
import {
  currentModel, systemRomLabel, systemRomSize, systemRomIsCustom, cartridgeName,
  systemRomPageLabels, systemRomPageSizes, systemRomPageOverridden,
} from '@/state/machine-state.ts';
import type { MachineModel } from '@/models.ts';
import { machineCaps } from '@/state/machine-caps.ts';
import type { RomPage } from '@/managers/rom-manager.ts';
import { openFile } from '@/ui/file-picker.ts';

/**
 * ROM page slot titles, in display order, paired with the underlying page
 * index (display order need not match page-byte order).
 * Page indices/order for +2A/+3 follow the real 1FFD/7FFD ROM-select bits
 * (see romPageSlotCount in models.ts).
 */
interface RomPageSlot { title: string; ejectTitle: string; page: RomPage; }

const PLUS2_128K_SLOTS: RomPageSlot[] = [
  { title: '128K ROM', ejectTitle: 'Revert to the default 128K ROM', page: 0 },
  { title: '48K ROM', ejectTitle: 'Revert to the default 48K ROM', page: 1 },
];

const PLUS3_SLOTS: RomPageSlot[] = [
  { title: '128K Editor ROM', ejectTitle: 'Revert to the default 128K Editor ROM', page: 0 },
  { title: '128K Syntax Checker ROM', ejectTitle: 'Revert to the default 128K Syntax Checker ROM', page: 1 },
  { title: '+3DOS ROM', ejectTitle: 'Revert to the default +3DOS ROM', page: 2 },
  { title: '48K BASIC ROM', ejectTitle: 'Revert to the default 48K BASIC ROM', page: 3 },
];

const ROM_PAGE_SLOTS: Partial<Record<MachineModel, RomPageSlot[]>> = {
  '128k': PLUS2_128K_SLOTS,
  '+2': PLUS2_128K_SLOTS,
  '+2A': PLUS3_SLOTS,
  '+3': PLUS3_SLOTS,
};

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
 * ROM / Carts pane — manage the machine's system ROM (BIOS) and, on machines
 * with a cartridge slot, a mounted ROM cartridge. Shown for the MSX (HX-10),
 * the 16K/48K Spectrum (ZX Interface 2 cartridge slot), and the 128K/+2/+2A/+3
 * (independent 16K ROM page slots — 2 pages for 128K/+2, 4 for +2A/+3).
 */
export function RomPane(): JSX.Element {
  async function loadSystemRom(): Promise<void> {
    const results = await openFile({ id: 'zx84-system-rom', extensions: ['.rom', '.bin'] });
    if (!results) return;
    await setSystemRom(results[0].data, results[0].name);
  }

  async function loadSystemRomPage(page: RomPage): Promise<void> {
    const results = await openFile({ id: `zx84-system-rom-page${page}`, extensions: ['.rom', '.bin'] });
    if (!results) return;
    await setSystemRomPage(page, results[0].data, results[0].name);
  }

  async function insertCartridge(): Promise<void> {
    const results = await openFile({ id: 'zx84-cartridge', extensions: ['.rom', '.zip'] });
    if (!results) return;
    await loadFile(results[0].data, results[0].name);   // routes .rom → cartridge
  }

  // The system ROM is always present; a user-loaded image is only ejectable
  // (→ default) when it's actually a custom upload.
  const systemText = (): string => {
    const label = systemRomLabel();
    if (!label) return '';
    const size = fmtSize(systemRomSize());
    return size ? `${label} · ${size}` : label;
  };

  // Multi-page (128K/+2/+2A/+3) slots: the label is always populated (a named
  // default like "Sinclair 48K BASIC", or the uploaded filename), so eject
  // visibility is driven by the explicit overridden flag, not the label text.
  const pageText = (page: RomPage): string => {
    const label = systemRomPageLabels()[page];
    if (!label) return '';
    const size = fmtSize(systemRomPageSizes()[page] ?? 0);
    return size ? `${label} · ${size}` : label;
  };

  const showCartridgeSlot = (): boolean => machineCaps().cartridge;
  const pageSlots = (): RomPageSlot[] => ROM_PAGE_SLOTS[currentModel()] ?? [];
  // MSX keeps "System ROM" (its BIOS); the 16K/48K Spectrum just says "ROM".
  const systemSlotLabel = (): string => machineCaps().systemRomLabel;

  return (
    <Pane
      id="rom-panel"
      label="ROM / Carts"
      visible={showCartridgeSlot() || machineCaps().romPages > 0}
    >
      <Show
        when={pageSlots().length > 0}
        fallback={
          <Slot
            label={systemSlotLabel()}
            text={systemText()}
            placeholder="(default)"
            ejectable={systemRomIsCustom()}
            ejectTitle="Revert to the default system ROM"
            onLoad={loadSystemRom}
            onEject={() => resetSystemRom()}
          />
        }
      >
        <For each={pageSlots()}>
          {(slot) => (
            <Slot
              label={slot.title}
              text={pageText(slot.page)}
              placeholder="(default)"
              ejectable={systemRomPageOverridden()[slot.page] ?? false}
              ejectTitle={slot.ejectTitle}
              onLoad={() => loadSystemRomPage(slot.page)}
              onEject={() => resetSystemRomPage(slot.page)}
            />
          )}
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
    </Pane>
  );
}
