import { Pane } from '@/ui/components/Pane.tsx';
import { RawHtml } from '@/ui/components/RawHtml.tsx';
import { basicVarsHtml } from '@/state/debug-state.ts';

export function BasicVarsPane() {
  return (
    <Pane id="basic-vars-panel" label="BASIC Variables" mono>
      <RawHtml id="basic-vars-output" html={basicVarsHtml} />
    </Pane>
  );
}
