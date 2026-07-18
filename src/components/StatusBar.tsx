/**
 * Status text + activity LEDs.
 */

import { Show } from 'solid-js';
import {
  ledKbd, ledKemp, ledEar, ledLoad, ledText,
  ledBeep, ledAy, ledDsk, ledRainbow, ledMouse, toggleTranscribeMode, machine,
} from '@/emulator.ts';
import { machineCaps } from '@/state/machine-caps.ts';

function Led(props: {
  id: string; kind: string; label: string; tip: string; on: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      id={props.id}
      class={`led${props.on ? ' on' : ''}`}
      data-kind={props.kind}
      onClick={props.onClick}
      style={props.onClick ? 'cursor:pointer' : undefined}
      title={props.tip}
    >
      {props.label}
    </div>
  );
}

export function StatusBar() {
  return (
    <div id="status-bar" class="status-controls">
      <div id="activity">
        <div class="led-group">
          {/* Group 1: Input devices */}
          <Led id="led-kbd" kind="kbd" label="KEY" on={ledKbd()}
            tip={machineCaps().keyboardBus === 'ppi' ? 'Scanning the keyboard matrix (PPI → AY port A)' : 'Reading the keyboard via the ULA port'} />
          <Show when={machineCaps().kempston}>
            <Led id="led-kemp" kind="kemp" label="KEMPSTON" on={ledKemp()}
              tip="Reading the Kempston joystick port" />
          </Show>
          <Led id="led-mouse" kind="mouse" label="MOUSE" on={ledMouse()}
            tip="Reading the Kempston mouse ports" />
        </div>
        <div class="led-group">
          {/* Group 2: Tape and disk */}
          <Show when={machineCaps().tapeEar}>
            <Led id="led-ear" kind="ear" label="EAR" on={ledEar()}
              tip="Sampling the EAR port (tape playback)" />
          </Show>
          <Led id="led-load" kind="load" label="TAPE" on={ledLoad()}
            tip="ROM tape-load routine is active (LD-BYTES at 0556h)" />
          <Led id="led-dsk" kind="dsk" label="DISK" on={ledDsk()}
            tip="Floppy disk controller is being accessed" />
        </div>
        <div class="led-group">
          {/* Group 3: Screen effects and transcription */}
          <Led id="led-text" kind="text" label="TEXT" on={ledText()}
            tip="Pixel-based screen OCR — click to toggle overlay"
            onClick={() => machine && toggleTranscribeMode('text')} />
          <Show when={machineCaps().rainbow}>
            <Led id="led-rainbow" kind="rainbow" label="RAINBOW" on={ledRainbow()}
              tip="Attribute area is being rewritten mid-frame (rainbow/colour-cycling effect)" />
          </Show>
        </div>
        <div class="led-group">
          {/* Group 4: Sound */}
          <Show when={machineCaps().beeper}>
            <Led id="led-beep" kind="beep" label="BEEP" on={ledBeep()}
              tip="Beeper bit is toggling (producing sound)" />
          </Show>
          <Led id="led-ay" kind="ay" label="AY-3-8912" on={ledAy()}
            tip="Writing to the AY sound chip registers" />
        </div>
      </div>
    </div>
  );
}
