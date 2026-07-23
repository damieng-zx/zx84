/**
 * Status-bar activity LED catalog.
 *
 * Every LED is defined here once — label, column group, on/off signal and
 * tooltip. Each machine's descriptor lists which ids it exposes
 * (`MachineUiCapabilities.statusLeds`); StatusBar renders this catalog filtered
 * by that list, so a machine can never surface an indicator for hardware it
 * lacks (no AY/DISK on a ZX80/81, no BEEP on a CPC, …). Adding a new LED is a
 * single entry here plus listing its id on the machines that have it.
 *
 * Groups map to the four status-bar columns: 1 input · 2 tape/disk ·
 * 3 screen/text · 4 sound. The DOM id (`led-<id>`) and `data-kind` are derived
 * from the id, matching the previous hand-written markup.
 */

import { machine } from '@/shell/context.ts';
import { toggleTranscribeMode } from '@/shell/media.ts';
import {
  ledKbd, ledKemp, ledMouse, ledEar, ledLoad,
  ledDsk, ledText, ledRainbow, ledBeep, ledAy,
} from '@/state/activity-state.ts';
import type { MachineUiCapabilities, StatusLedId } from '@/machines/machine.ts';

export interface StatusLed {
  readonly id: StatusLedId;
  readonly label: string;
  /** Column group: 1 input · 2 tape/disk · 3 screen/text · 4 sound. */
  readonly group: 1 | 2 | 3 | 4;
  /** Reactive on/off signal (from activity-state). */
  readonly signal: () => boolean;
  /** Tooltip — static, or derived from the active machine's capabilities. */
  readonly tip: string | ((caps: MachineUiCapabilities) => string);
  /** Optional click handler (TEXT toggles the transcribe overlay). */
  readonly onClick?: () => void;
}

export const STATUS_LEDS: readonly StatusLed[] = [
  // Group 1 — input devices
  {
    id: 'kbd', label: 'KEY', group: 1, signal: ledKbd,
    tip: (caps) => caps.keyboardBus === 'ppi'
      ? 'Scanning the keyboard matrix (PPI → AY port A)'
      : 'Reading the keyboard via the ULA port',
  },
  { id: 'kemp', label: 'KEMPSTON', group: 1, signal: ledKemp, tip: 'Reading the Kempston joystick port' },
  { id: 'mouse', label: 'MOUSE', group: 1, signal: ledMouse, tip: 'Reading the mouse ports' },
  // Group 2 — tape and disk
  { id: 'ear', label: 'EAR', group: 2, signal: ledEar, tip: 'Sampling the EAR port (tape playback)' },
  { id: 'load', label: 'TAPE', group: 2, signal: ledLoad, tip: 'Tape-load routine is active' },
  { id: 'dsk', label: 'DISK', group: 2, signal: ledDsk, tip: 'Floppy disk controller is being accessed' },
  // Group 3 — screen effects and transcription
  {
    id: 'text', label: 'TEXT', group: 3, signal: ledText,
    tip: 'Pixel-based screen OCR — click to toggle overlay',
    onClick: () => { if (machine) toggleTranscribeMode('text'); },
  },
  {
    id: 'rainbow', label: 'RAINBOW', group: 3, signal: ledRainbow,
    tip: 'Attribute area is being rewritten mid-frame (rainbow/colour-cycling effect)',
  },
  // Group 4 — sound
  { id: 'beep', label: 'BEEP', group: 4, signal: ledBeep, tip: 'Beeper bit is toggling (producing sound)' },
  { id: 'ay', label: 'AY-3-8912', group: 4, signal: ledAy, tip: 'Writing to the AY sound chip registers' },
];

/** Column groups in render order. */
export const STATUS_LED_GROUPS = [1, 2, 3, 4] as const;
