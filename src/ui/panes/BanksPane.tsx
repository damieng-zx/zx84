import { For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { memoryMap } from '@/state/debug-state.ts';
import { machineCaps } from '@/state/machine-caps.ts';

/** Suffix markers for a slot, e.g. `  ◀screen` / `  ◀rom`. */
function flagSuffix(flags?: readonly ('screen' | 'active')[]): string {
  if (!flags?.length) return '';
  return flags.map(f => (f === 'screen' ? '  ◀screen' : '  ◀rom')).join('');
}

export function BanksPane() {
  // Shown for machines with paged memory (128K-class Spectrum, CPC, MTX, MSX);
  // the flat 16K/48K models and the VDP-only machines have none.
  return (
    <Pane id="banks-panel" label="Memory Layout" mono visible={machineCaps().memoryLayout}>
      <pre id="banks-output">
        <Show when={memoryMap()} fallback={<span style={{ color: '#666' }}>(no memory layout)</span>}>
          {(snap) => {
            const twoCol = (): boolean => snap().columns != null;
            return (
              <>
                <Show when={snap().columns}>
                  {(cols) => (
                    <>
                      <span class="reg-name">{'           '}{cols()[0].padEnd(9)}{cols()[1] ?? ''}</span>
                      {'\n'}
                    </>
                  )}
                </Show>
                <For each={snap().slots}>
                  {(s) => (
                    <>
                      <Show
                        when={twoCol()}
                        fallback={<><span class="reg-name">{s.range}</span> {s.read}{flagSuffix(s.flags)}{'\n'}</>}
                      >
                        <span class="reg-name">{s.range}</span>{'  '}{s.read.padEnd(9)}→ {s.write ?? ''}{flagSuffix(s.flags)}{'\n'}
                      </Show>
                    </>
                  )}
                </For>
                <Show when={snap().registers.length > 0}>
                  {'\n'}
                  <For each={snap().registers}>
                    {(r) => (<><span class="reg-name">{r.name}</span> {r.value}{'\n'}</>)}
                  </For>
                </Show>
              </>
            );
          }}
        </Show>
      </pre>
    </Pane>
  );
}
