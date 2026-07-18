import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { basicListing } from '@/state/debug-state.ts';

export function BasicPane() {
  return (
    <Pane id="basic-panel" label="BASIC Listing" mono>
      <pre id="basic-output">
        <Show when={basicListing().length > 0} fallback={<span style={{ color: '#666' }}>(no BASIC program)</span>}>
          <For each={basicListing()}>{(line) => (
            <>
              <span class="basic-line-num">{line.lineNumber.toString().padStart(4, ' ')}</span>
              {' '}{line.text}{'\n'}
            </>
          )}</For>
        </Show>
      </pre>
    </Pane>
  );
}
