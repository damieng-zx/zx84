import { Show } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';

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
  format?: (v: number) => JSX.Element;
  endLabels?: [string, string];
  stops?: readonly number[];
  valueText?: (v: number) => string;
  class?: string;
}) {
  const listId = `${props.id}-stops`;
  return (
    <div class={`slider-row${props.class ? ` ${props.class}` : ''}`}>
      <span class="slider-label">{props.label}</span>
      <Show when={props.endLabels}>
        <span class="slider-end-label">{props.endLabels![0]}</span>
      </Show>
      <input
        type="range" id={`${props.id}-slider`}
        min={props.min} max={props.max} step={props.step ?? 1}
        list={props.stops ? listId : undefined}
        value={props.value()}
        aria-valuetext={props.valueText?.(props.value())}
        onInput={(e) => props.onInput(Number((e.target as HTMLInputElement).value))}
      />
      <Show when={props.stops}>
        <datalist id={listId}>
          {props.stops!.map(value => <option value={value} />)}
        </datalist>
      </Show>
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
