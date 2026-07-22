import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import * as settings from '@/store/settings.ts';

export function Zx8xHardwareSection() {
  return (
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
  );
}
