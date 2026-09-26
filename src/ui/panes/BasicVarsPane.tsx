import { For, Show, Switch, Match } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { basicVars } from '@/state/debug-state.ts';
import type { BasicVariable } from '@/basic/types.ts';

/** The right-hand cell of a variable row: `= <value>`, with the kind-specific
 *  detail. All fields are interpolated as text, so Solid escapes them — a
 *  crafted name/value cannot inject markup. */
function VarValue(props: { v: BasicVariable }) {
  return (
    <>
      {'= '}
      <Switch>
        <Match when={props.v.kind === 'string'}>
          <span class="var-value">{'"'}{props.v.value}{'"'}</span>
        </Match>
        {/* A parser that can read the elements puts them in `detail`; one that
            only knows the shape leaves it out and the marker stands in. */}
        <Match when={props.v.kind === 'array'}>
          <span class="var-detail">{props.v.detail || '[array]'}</span>
        </Match>
        <Match when={props.v.kind === 'for-next'}>
          <span class="var-value">{props.v.value}</span>{'  '}
          <span class="var-detail">{props.v.detail}</span>
        </Match>
        <Match when={props.v.kind === 'number'}>
          <span class="var-value">{props.v.value}</span>
        </Match>
      </Switch>
    </>
  );
}

/**
 * BASIC variables pane — one aligned row per variable: the name in a
 * fixed-width column so every `=` lines up, then the value. Laid out like the
 * register panels (a name column plus a value column) rather than the ragged
 * `name = value` text the parsers used to feed straight into a <pre>.
 */
export function BasicVarsPane() {
  return (
    <Pane id="basic-vars-panel" label="BASIC Variables" mono>
      <div id="basic-vars-output">
        <Show when={basicVars().length > 0} fallback={<span style={{ color: '#666' }}>(no variables)</span>}>
          <For each={basicVars()}>
            {(v) => (
              <div class="basic-var-row">
                <span class="var-name">{v.name}</span>
                <span class="var-cell"><VarValue v={v} /></span>
              </div>
            )}
          </For>
        </Show>
      </div>
    </Pane>
  );
}
