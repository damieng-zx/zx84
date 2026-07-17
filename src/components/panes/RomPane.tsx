import { Show, type JSX } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import {
  currentModel, systemRomLabel, systemRomSize, cartridgeName,
  system48RomLabel, system48RomSize, system128RomLabel, system128RomSize,
  setSystemRom, resetSystemRom, setSystemRomPage, resetSystemRomPage,
  loadFile, ejectCartridge,
} from '@/emulator.ts';
import { isMsxModel, isInterface2Capable, isDualRomModel } from '@/models.ts';
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
        <span class="media-slot-text" classList={{ placeholder: !props.text }} title={props.text}>
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
 * the 16K/48K Spectrum (ZX Interface 2 cartridge slot), and the 128K/+2
 * (two independent 16K ROM page slots).
 */
export function RomPane(): JSX.Element {
  async function loadSystemRom(): Promise<void> {
    const results = await openFile({ id: 'zx84-system-rom', extensions: ['.rom', '.bin'] });
    if (!results) return;
    await setSystemRom(results[0].data, `${results[0].name} (custom)`);
  }

  async function loadSystemRomPage(page: 0 | 1): Promise<void> {
    const results = await openFile({ id: `zx84-system-rom-page${page}`, extensions: ['.rom', '.bin'] });
    if (!results) return;
    await setSystemRomPage(page, results[0].data, results[0].name);
  }

  async function insertCartridge(): Promise<void> {
    const results = await openFile({ id: 'zx84-cartridge', extensions: ['.rom', '.zip'] });
    if (!results) return;
    await loadFile(results[0].data, results[0].name);   // routes .rom → cartridge
  }

  // The system ROM is always present; a user-loaded image carries a "(custom)"
  // label, so ejecting it (→ default) is only offered then.
  const isCustomRom = (): boolean => /\(custom\)/i.test(systemRomLabel());
  const systemText = (): string => {
    const label = systemRomLabel();
    if (!label) return '';
    const size = fmtSize(systemRomSize());
    return size ? `${label} · ${size}` : label;
  };

  // Dual-ROM (128K/+2) page slots: the label is always populated (a named
  // default like "Sinclair 48K BASIC", or a "(custom)"-suffixed user upload),
  // so — like the single System ROM slot above — only a "(custom)" label
  // offers an eject (there's no separate "unset" state to distinguish).
  const isCustomPage = (label: string): boolean => /\(custom\)/i.test(label);
  const pageText = (label: string, size: number): string => {
    if (!label) return '';
    const fmt = fmtSize(size);
    return fmt ? `${label} · ${fmt}` : label;
  };
  const system48Text = (): string => pageText(system48RomLabel(), system48RomSize());
  const system128Text = (): string => pageText(system128RomLabel(), system128RomSize());

  const showCartridgeSlot = (): boolean => isMsxModel(currentModel()) || isInterface2Capable(currentModel());

  return (
    <Pane
      id="rom-panel"
      label="ROM / Carts"
      visible={showCartridgeSlot() || isDualRomModel(currentModel())}
    >
      <Show
        when={isDualRomModel(currentModel())}
        fallback={
          <Slot
            label="System ROM"
            text={systemText()}
            placeholder="(default)"
            ejectable={isCustomRom()}
            ejectTitle="Revert to the default system ROM"
            onLoad={loadSystemRom}
            onEject={() => resetSystemRom()}
          />
        }
      >
        <Slot
          label="System 48K ROM"
          text={system48Text()}
          placeholder="(default)"
          ejectable={isCustomPage(system48RomLabel())}
          ejectTitle="Revert to the default 48K ROM"
          onLoad={() => loadSystemRomPage(1)}
          onEject={() => resetSystemRomPage(1)}
        />
        <Slot
          label="System 128K ROM"
          text={system128Text()}
          placeholder="(default)"
          ejectable={isCustomPage(system128RomLabel())}
          ejectTitle="Revert to the default 128K ROM"
          onLoad={() => loadSystemRomPage(0)}
          onEject={() => resetSystemRomPage(0)}
        />
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
