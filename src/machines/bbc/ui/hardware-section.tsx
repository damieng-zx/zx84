/**
 * BBC-specific Hardware-pane options.
 *
 * This contribution may narrow to its own machine folder; the generic Hardware
 * pane remains machine-blind and loads it through the UI manifest.
 */

import { For } from 'solid-js';
import * as settings from '@/store/settings.ts';
import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import type { BbcDiskSystem } from '@/machines/bbc/models.ts';

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

export function BbcHardwareSection() {
  return (
    <div class="slider-row">
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
