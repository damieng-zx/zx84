import { Show } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { machineUi } from '@/components/machine-ui.ts';
import { machineKind } from '@/state/machine-caps.ts';

export function SysVarPane() {
  // The system-variables view is machine-specific (the Spectrum contributes one;
  // machines without a sysvars concept render an empty pane).
  return (
    <Pane id="sysvar-panel" label="System Variables" mono>
      <Show when={machineUi(machineKind()).SysVars} keyed>
        {(SysVars) => <SysVars />}
      </Show>
    </Pane>
  );
}
