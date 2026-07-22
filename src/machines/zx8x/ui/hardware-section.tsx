import { Show } from 'solid-js';
import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import * as settings from '@/store/settings.ts';

export function Zx8xHardwareSection() {
  const setUdg = (enabled: boolean): void => {
    settings.setZx81UdgRam(enabled);
    settings.persistSetting('zx81-udg-ram', enabled ? 'on' : 'off');
    if (enabled) {
      settings.setZx81WrxHires(false);
      settings.persistSetting('zx81-wrx-hires', 'off');
    }
    void switchModel(currentModel());
  };

  const setWrx = (enabled: boolean): void => {
    settings.setZx81WrxHires(enabled);
    settings.persistSetting('zx81-wrx-hires', enabled ? 'on' : 'off');
    if (enabled) {
      settings.setZx81UdgRam(false);
      settings.persistSetting('zx81-udg-ram', 'off');
    }
    void switchModel(currentModel());
  };

  return (
    <>
      <div class="multiface-row">
        <label class="mf-check" title="Use 16KB RAM">
          <input
            type="checkbox"
            checked={settings.zx8x16kRam()}
            onChange={(event) => {
              const enabled = (event.target as HTMLInputElement).checked;
              settings.setZx8x16kRam(enabled);
              settings.persistSetting('zx8x-16k-ram', enabled ? 'on' : 'off');
              void switchModel(currentModel());
            }}
          />
          16KB RAM
        </label>
      </div>
      <Show when={currentModel() === 'zx81'}>
        <div class="multiface-row">
          <label class="mf-check" title="Character-generator RAM mapped at $3000 for UDG software">
            <input
              type="checkbox"
              checked={settings.zx81UdgRam()}
              onChange={(event) => setUdg((event.target as HTMLInputElement).checked)}
            />
            UDG RAM ($3000)
          </label>
        </div>
        <div class="multiface-row">
          <label class="mf-check" title="WRX bitmap hi-res with refresh-readable static RAM at $2000-$3FFF">
            <input
              type="checkbox"
              checked={settings.zx81WrxHires()}
              onChange={(event) => setWrx((event.target as HTMLInputElement).checked)}
            />
            WRX hi-res
          </label>
        </div>
      </Show>
    </>
  );
}
