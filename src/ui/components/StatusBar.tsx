/**
 * Status text + activity LEDs.
 *
 * Machine-blind: the LED set comes from the STATUS_LEDS catalog filtered by the
 * active machine's declared `statusLeds` list, so the bar only ever shows
 * indicators the current hardware actually has.
 */

import { For, Show } from 'solid-js';
import { machineCaps } from '@/state/machine-caps.ts';
import { STATUS_LEDS, STATUS_LED_GROUPS, type StatusLed } from '@/ui/components/status-leds.ts';

function Led(props: { led: StatusLed }) {
  const tip = () => {
    const t = props.led.tip;
    return typeof t === 'function' ? t(machineCaps()) : t;
  };
  return (
    <div
      id={`led-${props.led.id}`}
      class={`led${props.led.signal() ? ' on' : ''}`}
      data-kind={props.led.id}
      onClick={props.led.onClick}
      style={props.led.onClick ? 'cursor:pointer' : undefined}
      title={tip()}
    >
      {props.led.label}
    </div>
  );
}

export function StatusBar() {
  const inGroup = (group: number) =>
    STATUS_LEDS.filter((l) => l.group === group && machineCaps().statusLeds.includes(l.id));
  return (
    <div id="status-bar" class="status-controls">
      <div id="activity">
        <For each={STATUS_LED_GROUPS}>
          {(group) => (
            <Show when={inGroup(group).length > 0}>
              <div class="led-group">
                <For each={inGroup(group)}>{(led) => <Led led={led} />}</For>
              </div>
            </Show>
          )}
        </For>
      </div>
    </div>
  );
}
