/**
 * BBC-specific Hardware-pane options.
 *
 * This contribution may narrow to its own machine folder; the generic Hardware
 * pane remains machine-blind and loads it through the UI manifest.
 */

import * as settings from '@/store/settings.ts';
import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';

export function BbcHardwareSection() {
  return (
    <div class="multiface-row">
      <label
        class="mf-check"
        title="Fit the Acorn 1770 DFS disc interface — the DFS ROM and drives A:/B:"
      >
        <input
          type="checkbox"
          checked={settings.bbcDfs()}
          onChange={(event) => {
            const enabled = (event.target as HTMLInputElement).checked;
            settings.setBbcDfs(enabled);
            settings.persistSetting('bbc-dfs-enabled', enabled ? 'on' : 'off');
            // The DFS ROM is fitted at build time, so rebuild to add/remove it.
            void switchModel(currentModel());
          }}
        />
        Acorn 1770 DFS
      </label>
    </div>
  );
}
