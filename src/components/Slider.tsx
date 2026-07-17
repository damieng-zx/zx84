import { Show } from 'solid-js';
import type { Accessor } from 'solid-js';

// Standard labelled range-input row used across the settings panes
// (Display, Sound, Text). Callers own the side effects (signal update,
// persistSetting, any machine.display/audio apply) via onInput — this
// component only owns markup and the numeric parse.
export function SliderRow(props: {
  label: string;
  id: string;
  min: number;
  max: number;
  step?: number;
  value: Accessor<number>;
  onInput: (v: number) => void;
  format?: (v: number) => string;
  endLabels?: [string, string];
}) {
  return (
    <div class="slider-row">
      <span class="slider-label">{props.label}</span>
      <Show when={props.endLabels}>
        <span class="slider-end-label">{props.endLabels![0]}</span>
      </Show>
      <input
        type="range" id={`${props.id}-slider`}
        min={props.min} max={props.max} step={props.step ?? 1}
        value={props.value()}
        onInput={(e) => props.onInput(Number((e.target as HTMLInputElement).value))}
      />
      <Show
        when={props.endLabels}
        fallback={
          <span class="slider-value" id={`${props.id}-value`}>
            {props.format ? props.format(props.value()) : props.value()}
          </span>
        }
      >
        <span class="slider-end-label">{props.endLabels![1]}</span>
      </Show>
    </div>
  );
}
