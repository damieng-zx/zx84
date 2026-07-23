import { For, Show } from 'solid-js';
import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import * as settings from '@/store/settings.ts';

type HrgMode = 'udg' | 'udg128' | 'wrx' | 'memotech' | 'quicksilva';

const HRG_OPTIONS: readonly { mode: HrgMode; label: string; title: string }[] = [
  { mode: 'udg', label: 'UDG RAM ($3000)', title: '64-character user-defined graphics RAM mapped at $3000' },
  { mode: 'udg128', label: 'UDG-128 ($3000)', title: '128-character UDG board using the CHR$ 128 scheme at $3000' },
  { mode: 'wrx', label: 'WRX hi-res', title: 'WRX and HRG-ms refresh-readable bitmap RAM at $2000-$3FFF' },
  { mode: 'memotech', label: 'Memotech HRG', title: 'Memotech 248x192 high-resolution graphics board' },
  { mode: 'quicksilva', label: 'QuickSilva HRG', title: 'QuickSilva 256x192 high-resolution graphics board' },
];

const enabled = (mode: HrgMode): boolean => ({
  udg: settings.zx81UdgRam,
  udg128: settings.zx81Udg128Ram,
  wrx: settings.zx81WrxHires,
  memotech: settings.zx81MemotechHrg,
  quicksilva: settings.zx81QuickSilvaHrg,
})[mode]();

function setHrg(mode: HrgMode, value: boolean): void {
  const options = {
    udg: [settings.setZx81UdgRam, 'zx81-udg-ram'],
    udg128: [settings.setZx81Udg128Ram, 'zx81-udg128-ram'],
    wrx: [settings.setZx81WrxHires, 'zx81-wrx-hires'],
    memotech: [settings.setZx81MemotechHrg, 'zx81-memotech-hrg'],
    quicksilva: [settings.setZx81QuickSilvaHrg, 'zx81-quicksilva-hrg'],
  } as const;
  for (const candidate of HRG_OPTIONS) {
    const [set, key] = options[candidate.mode];
    const selected = value && candidate.mode === mode;
    set(selected);
    settings.persistSetting(key, selected ? 'on' : 'off');
  }
  void switchModel(currentModel());
}

export function Zx8xHardwareSection() {
  return (
    <>
      <div class="multiface-row">
        <label class="mf-check" title="Use 16KB RAM">
          <input
            type="checkbox"
            checked={settings.zx8x16kRam()}
            onChange={(event) => {
              const value = (event.target as HTMLInputElement).checked;
              settings.setZx8x16kRam(value);
              settings.persistSetting('zx8x-16k-ram', value ? 'on' : 'off');
              void switchModel(currentModel());
            }}
          />
          16KB RAM
        </label>
      </div>
      <Show when={currentModel() === 'zx81'}>
        <For each={HRG_OPTIONS}>{option => (
          <div class="multiface-row">
            <label class="mf-check" title={option.title}>
              <input
                type="checkbox"
                checked={enabled(option.mode)}
                onChange={event => setHrg(option.mode, event.currentTarget.checked)}
              />
              {option.label}
            </label>
          </div>
        )}</For>
      </Show>
    </>
  );
}
