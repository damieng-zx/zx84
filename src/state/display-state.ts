/**
 * Device-pixel ratio, shared by everything that has to size itself in CSS
 * pixels against the emulator display.
 *
 * The display-scale setting counts *physical* pixels — one emulator pixel maps
 * to exactly `scale` of them, which is what keeps the picture pixel-perfect —
 * so the renderers divide by the DPR when they set the canvas's CSS box. Any
 * chrome that wants to line up with the screen (the on-screen keyboards, the
 * TEXT overlay) has to divide by the same figure, or it comes out `dpr` times
 * too large: correct on a 1× Windows display, twice the size on a Retina Mac.
 */

import { createRoot, createSignal, onCleanup } from 'solid-js';

const current = () => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);

const _devicePixelRatio = /*@once*/ createRoot(() => {
  const signal = createSignal(current());
  if (typeof window !== 'undefined') {
    // A media query is the only way to be told about a DPR change (browser
    // zoom, or the window moving to a display of a different density), and it
    // only matches the ratio it was created with, so re-arm after each one.
    let cancelled = false;
    const watch = () => {
      if (cancelled) return;
      const query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      query.addEventListener('change', () => {
        signal[1](current());
        watch();
      }, { once: true });
    };
    watch();
    onCleanup(() => { cancelled = true; });
  }
  return signal;
});

export const devicePixelRatio = _devicePixelRatio[0];

/**
 * The display scale expressed in CSS pixels. `scale` counts physical pixels —
 * one emulator pixel maps to exactly that many, which is what keeps the
 * picture pixel-perfect — and the renderers divide by the DPR when they size
 * the canvas's CSS box, so anything sizing itself against the screen has to
 * divide by the same figure. `dpr` is a parameter only so tests can pin the
 * invariant without a real display behind them.
 */
export function cssDisplayScale(scale: number, dpr = devicePixelRatio()): number {
  return scale / dpr;
}
