import { Pane } from '@/ui/components/Pane.tsx';
import { RawHtml } from '@/ui/components/RawHtml.tsx';
import { basicHtml } from '@/state/debug-state.ts';

export function BasicPane() {
  return (
    <Pane id="basic-panel" label="BASIC Listing" mono>
      <RawHtml id="basic-output" html={basicHtml} />
    </Pane>
  );
}
