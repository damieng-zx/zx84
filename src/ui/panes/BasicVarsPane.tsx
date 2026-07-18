import { For, Show, Switch, Match } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { basicVars } from '@/state/debug-state.ts';
import type { BasicVariable } from '@/basic/types.ts';

/** Render one variable row. All fields are interpolated as text, so Solid
 *  escapes them — a crafted name/value cannot inject markup. */
function VarRow(props: { v: BasicVariable }) {
  return (
    <>
      <span class="var-name">{props.v.name}</span>
      <Switch>
        <Match when={props.v.kind === 'string'}>{' = "'}{props.v.value}{'"'}</Match>
        <Match when={props.v.kind === 'array'}>{' '}<span style={{ color: '#888' }}>[array]</span></Match>
        <Match when={props.v.kind === 'for-next'}>
          {' = '}{props.v.value}{' '}<span style={{ color: '#888' }}>{props.v.detail}</span>
        </Match>
        <Match when={props.v.kind === 'number'}>{' = '}{props.v.value}</Match>
      </Switch>
      {'\n'}
    </>
  );
}

export function BasicVarsPane() {
  return (
    <Pane id="basic-vars-panel" label="BASIC Variables" mono>
      <pre id="basic-vars-output">
        <Show when={basicVars().length > 0} fallback={<span style={{ color: '#666' }}>(no variables)</span>}>
          <For each={basicVars()}>{(v) => <VarRow v={v} />}</For>
        </Show>
      </pre>
    </Pane>
  );
}
