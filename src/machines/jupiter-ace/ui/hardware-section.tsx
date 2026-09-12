/**
 * Jupiter Ace hardware options — the official RAM packs.
 *
 * The stock Ace has 3KB of RAM; Jupiter Cantab's 16K pack maps 0x4000-0x7FFF
 * (19K total, RAMTOP 32768) and the 48K pack maps 0x4000-0xFFFF (51K total).
 * The FORTH ROM probes whatever is fitted at boot and sets RAMTOP itself, so
 * a change only needs a machine rebuild — no peripheral ROMs involved.
 * The 48K pack is the default.
 */

import { For } from 'solid-js';
import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import * as settings from '@/store/settings.ts';

type RamPack = 'none' | '16k' | '48k';

const PACK_OPTIONS: readonly { value: RamPack; label: string; title: string }[] = [
  { value: 'none', label: 'Stock 3K', title: 'No RAM pack — 3KB total (1K main + 1K video + 1K char)' },
  { value: '16k', label: '16K RAM pack (19K total)', title: 'Official 16K RAM pack: 0x4000-0x7FFF, 19K total' },
  { value: '48k', label: '48K RAM pack (51K total)', title: 'Official 48K RAM pack: 0x4000-0xFFFF, 51K total' },
];

export function AceHardwareSection() {
  return (
    <div class="slider-row ace-ram-row">
      <span
        class="slider-label"
        title={'Official Jupiter Cantab RAM pack fitted behind the onboard 3K. '
          + 'The FORTH ROM probes the pack at boot and sets RAMTOP itself.'}
      >
        RAM
      </span>
      <select
        value={settings.aceRamPack()}
        onChange={(event) => {
          const value = (event.target as HTMLSelectElement).value as RamPack;
          settings.setAceRamPack(value);
          settings.persistSetting('ace-ram-pack', value);
          void switchModel(currentModel());
        }}
      >
        <For each={PACK_OPTIONS}>
          {option => <option value={option.value} title={option.title}>{option.label}</option>}
        </For>
      </select>
    </div>
  );
}
