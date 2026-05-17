/**
 * activity-state — LED + transcription signals.
 *
 * This module is fifteen thin createSignal wrappers with no logic, so
 * there's nothing to functionally test. What IS worth pinning is the
 * initial values: every LED must default to off, transcribe mode must
 * default to 'off', and the transcribe grid must be the exact string
 * '32x24' (consumers parse it).
 *
 * If a future edit flips a default — most likely by accident during
 * a copy/paste — this test catches it.
 */

import { describe, it, expect } from 'vitest';
import * as activity from '@/state/activity-state.ts';

describe('activity-state — defaults', () => {
  it('every boolean LED starts off', () => {
    const ledGetters: Record<string, () => boolean> = {
      ledKbd: activity.ledKbd,
      ledKemp: activity.ledKemp,
      ledMouse: activity.ledMouse,
      ledEar: activity.ledEar,
      ledLoad: activity.ledLoad,
      ledTapeTurbo: activity.ledTapeTurbo,
      ledDsk: activity.ledDsk,
      ledBeep: activity.ledBeep,
      ledAy: activity.ledAy,
      ledRainbow: activity.ledRainbow,
      ledText: activity.ledText,
    };
    for (const [name, get] of Object.entries(ledGetters)) {
      expect(get(), `${name} should default to false`).toBe(false);
    }
  });

  it('transcribe defaults are off / empty / 32x24', () => {
    expect(activity.transcribeMode()).toBe('off');
    expect(activity.transcribeText()).toBe('');
    expect(activity.transcribeHtml()).toBe('');
    // Exact literal — consumers split on 'x'. Don't let this drift.
    expect(activity.transcribeGrid()).toBe('32x24');
  });

  it('every exported signal pair is wired (setter actually drives getter)', () => {
    // Spot-check one of each shape — boolean LED, mode enum, string, grid.
    // If a setter were accidentally bound to the wrong signal, this catches it.
    activity.setLedKbd(true);
    expect(activity.ledKbd()).toBe(true);
    activity.setLedKbd(false);

    activity.setTranscribeMode('text');
    expect(activity.transcribeMode()).toBe('text');
    activity.setTranscribeMode('off');

    activity.setTranscribeText('hello');
    expect(activity.transcribeText()).toBe('hello');
    activity.setTranscribeText('');

    activity.setTranscribeGrid('51x24');
    expect(activity.transcribeGrid()).toBe('51x24');
    activity.setTranscribeGrid('32x24');
  });

  it('transcribeGrid accepts every OcrGridName the producer can emit', () => {
    // The signal is typed OcrGridName, not string. If someone widens it back
    // to string (losing the literal union), a consumer doing a string compare
    // like '32X24' would silently mismatch. Pin the producer-consumer contract.
    for (const g of ['32x24', '51x24', '64x24'] as const) {
      activity.setTranscribeGrid(g);
      expect(activity.transcribeGrid()).toBe(g);
    }
    activity.setTranscribeGrid('32x24');
  });
});
