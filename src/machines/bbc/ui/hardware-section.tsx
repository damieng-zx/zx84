/**
 * BBC-specific Hardware-pane options.
 *
 * This contribution may narrow to its own machine folder; the generic Hardware
 * pane remains machine-blind and loads it through the UI manifest.
 */

import { For, Show, createSignal } from 'solid-js';
import * as settings from '@/store/settings.ts';
import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import { downloadFile } from '@/shell/download.ts';
import { BBC_SWR_GROUPS, type BbcDiskSystem } from '@/machines/bbc/models.ts';
import { activeBbc } from './active.ts';

const DISK_OPTIONS: readonly { value: BbcDiskSystem; label: string; title: string }[] = [
  { value: 'none', label: 'None', title: 'No disc interface fitted' },
  {
    value: 'acorn',
    label: 'Acorn DFS (8271)',
    title: 'Original Acorn DFS with the Intel 8271 controller (single density)',
  },
  {
    value: '1770',
    label: 'Acorn 1770 DFS',
    title: 'Later Acorn DFS with the WD1770 controller',
  },
];

function DiskSystemRow() {
  return (
    <div class="slider-row bbc-disk-row">
      <span
        class="slider-label"
        title={'Which floppy disc interface is fitted — the original Intel 8271 Acorn DFS, '
          + 'the later WD1770 upgrade, or none. The interface ROM is loaded at build time, '
          + 'so the machine rebuilds when this changes.'}
      >
        Disk system
      </span>
      <select
        value={settings.bbcDiskSystem()}
        onChange={(event) => {
          const value = (event.target as HTMLSelectElement).value as BbcDiskSystem;
          settings.setBbcDiskSystem(value);
          settings.persistSetting('bbc-disk-system', value);
          // The interface ROM is fitted at build time, so rebuild to add/remove it.
          void switchModel(currentModel());
        }}
      >
        <For each={DISK_OPTIONS}>
          {option => <option value={option.value} title={option.title}>{option.label}</option>}
        </For>
      </select>
    </div>
  );
}

/** The fitted sideways-RAM sockets as a bit mask (bit n = socket n). */
const swrMask = (): number => Number(settings.bbcSwr()) || 0;

function SidewaysRamRows() {
  const toggle = (mask: number, on: boolean): void => {
    const next = on ? swrMask() | mask : swrMask() & ~mask;
    settings.setBbcSwr(String(next));
    settings.persistSetting('bbc-swr', String(next));
    // The RAM is fitted at build time (stored ROM images are loaded into it
    // then), so rebuild.
    void switchModel(currentModel());
  };
  return (
    <For each={BBC_SWR_GROUPS}>
      {group => (
        <div class="multiface-row">
          <label
            class="mf-check"
            title={`Fit sideways RAM in ROM sockets ${group.label}: the MOS sees four 16K banks it can write `
              + 'to once they are selected (utility ROMs such as *SRLOAD write them). Load a ROM image into a '
              + 'bank from the ROM pane. The contents survive BREAK but not a rebuild.'}
          >
            <input
              type="checkbox"
              checked={(swrMask() & group.mask) === group.mask}
              onChange={(event) => toggle(group.mask, (event.target as HTMLInputElement).checked)}
            />
            Sideways RAM, banks {group.label}
          </label>
        </div>
      )}
    </For>
  );
}

function SerialAndPrinterRows() {
  const [text, setText] = createSignal('');
  const [sent, setSent] = createSignal(0);
  const [printed, setPrinted] = createSignal(0);
  const refresh = (): void => {
    const m = activeBbc();
    setSent(m?.rs423.sent.length ?? 0);
    setPrinted(m?.printer.length ?? 0);
  };
  const send = (): void => {
    const m = activeBbc();
    if (!m) return;
    // Lines end CR for the BBC; the terminal's own newline is turned into one.
    const bytes = Array.from(text().replace(/\r?\n/g, '\r'), c => c.charCodeAt(0) & 0xFF);
    m.rs423.send(bytes);
    setText('');
    refresh();
  };
  return (
    <>
      <div class="slider-row">
        <span
          class="slider-label"
          title={'Text to send to the BBC down the RS423 port as 8N1 at the baud rate the ACIA is set up '
            + 'for. Select RS423 with *FX2,1 (input) and read it with *FX7/*FX8 as usual.'}
        >
          RS423 in
        </span>
        <input
          type="text"
          value={text()}
          placeholder="text to send"
          onInput={(event) => setText((event.target as HTMLInputElement).value)}
          onKeyDown={(event) => { if (event.key === 'Enter') send(); }}
        />
        <button type="button" onClick={send}>Send</button>
      </div>
      <div class="slider-row">
        <span class="slider-label" title="What the BBC has sent out of the RS423 port (*FX3,1 / *FX5,2)">
          RS423 out
        </span>
        <span>{sent()} bytes</span>
        <button type="button" onClick={refresh}>Refresh</button>
        <button
          type="button"
          disabled={sent() === 0}
          onClick={() => {
            const m = activeBbc();
            if (m) downloadFile(m.rs423.sent.slice(), 'bbc-rs423.txt');
          }}
        >
          Download
        </button>
        <button
          type="button"
          disabled={sent() === 0}
          onClick={() => { activeBbc()?.rs423.clearSent(); refresh(); }}
        >
          Clear
        </button>
      </div>
      <div class="slider-row">
        <span
          class="slider-label"
          title="What the BBC has printed on the parallel printer (*FX5,1, VDU 2). Download it from the Save menu."
        >
          Printer
        </span>
        <span>{printed()} bytes</span>
        <button type="button" onClick={refresh}>Refresh</button>
        <button
          type="button"
          disabled={printed() === 0}
          onClick={() => { activeBbc()?.printer.clear(); refresh(); }}
        >
          Clear
        </button>
      </div>
    </>
  );
}

export function BbcHardwareSection() {
  return (
    <>
      <DiskSystemRow />
      <SidewaysRamRows />
      <Show when={currentModel() !== 'bbc-a'}>
        <SerialAndPrinterRows />
      </Show>
    </>
  );
}
