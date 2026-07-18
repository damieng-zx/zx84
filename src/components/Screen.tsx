/**
 * Canvas wrapper for the emulator display + transcribe overlay.
 */

import { createEffect, createSignal, onMount, onCleanup } from 'solid-js';
import { Toast } from '@/components/Toast.tsx';
import { machine } from '@/shell/context.ts';
import { setCanvas } from '@/shell/lifecycle.ts';
import { transcribeMode, transcribeHtml, transcribeGrid } from '@/state/activity-state.ts';
import { machineDescriptor } from '@/state/machine-caps.ts';
import { renderer, scale, borderSize, ocrFont, ocrLineHeight, ocrTracking, ocrOffsetX, ocrOffsetY, ocrScaleX, ocrScaleY } from '@/store/settings.ts';

// Base font size for the overlay before auto-scaling. The overlay is always
// scaled to fit the active display area, so this absolute value only affects
// measurement precision, not the final rendered size.
const OCR_BASE_FONT_PX = 16;

export function Screen() {
  let canvasRef!: HTMLCanvasElement;
  let overlayRef!: HTMLPreElement;
  let natSize = { w: 0, h: 0 };

  // Track devicePixelRatio changes (browser zoom, OS scaling)
  const [dpr, setDpr] = createSignal(window.devicePixelRatio || 1);
  onMount(() => {
    let cancel = false;
    const watchDpr = () => {
      if (cancel) return;
      const mql = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mql.addEventListener('change', () => {
        setDpr(window.devicePixelRatio || 1);
        watchDpr();
      }, { once: true });
    };
    watchDpr();
    onCleanup(() => { cancel = true; });
  });

  // Re-apply scale when DPR changes
  createEffect(() => {
    dpr(); // track
    if (machine?.display) machine.display.setScale(scale());
  });

  // When renderer changes, create a fresh canvas element.
  createEffect(() => {
    renderer(); // track
    if (!canvasRef) return;
    const fresh = document.createElement('canvas');
    fresh.id = canvasRef.id;
    fresh.className = canvasRef.className;
    canvasRef.replaceWith(fresh);
    canvasRef = fresh;
    setCanvas(fresh);
  });


  // When font settings or the transcribe grid change, force re-measure
  // (the grid changes the natural width — e.g. 32 vs 51 chars wide).
  createEffect(() => {
    ocrFont(); ocrLineHeight(); ocrTracking(); ocrScaleX(); ocrScaleY();
    transcribeGrid();
    document.fonts.ready.then(() => {
      natSize = { w: 0, h: 0 };
    });
  });

  // Position the overlay and scale it to cover the active display area (256×192
  // on the Spectrum, 640×200 on the CPC).
  createEffect(() => {
    const mode = transcribeMode();
    ocrFont(); // Track font changes to trigger re-measure
    if (mode === 'off') {
      natSize = { w: 0, h: 0 };
      return;
    }
    if (!machine || !overlayRef || !canvasRef) return;

    const html = transcribeHtml();
    const scl = scale();
    const curDpr = dpr(); // track DPR changes
    const bs = borderSize(); // track border changes
    const ov = overlayRef;
    // The canvas backing buffer is `scale` device pixels per source pixel and
    // its CSS box is that ÷ DPR (see canvas/webgl renderer applyScale), so the
    // active area measures `scale / dpr` CSS pixels per source pixel. The overlay
    // is positioned in CSS pixels, so it must use that same factor to stay
    // aligned with the canvas at fractional DPRs.
    const effectiveScale = scl / curDpr;

    // Overlay geometry is machine-agnostic: the descriptor gives the active
    // area's size, its full-border offset, and the horizontal pixel aspect. The
    // border-size setting crops the displayed viewport uniformly (None=0,
    // Small=½, Normal=full border); a buffer point (bx,by) lands at
    // ((bx-viewX)·scale·pax, (by-viewY)·scale) in CSS.
    const geom = machineDescriptor().screen;
    const frac = bs === 2 ? 1 : bs === 1 ? 0.5 : 0;
    const viewX = Math.round(geom.borderLeft * (1 - frac));
    const viewY = Math.round(geom.borderTop * (1 - frac));
    const pax = geom.pixelAspectX;
    const originX = (geom.borderLeft - viewX) * effectiveScale * pax;
    const originY = (geom.borderTop - viewY) * effectiveScale;
    const targetW = geom.activeWidth * effectiveScale * pax;
    const targetH = geom.activeHeight * effectiveScale;

    // Apply font settings
    ov.style.fontFamily = ocrFont();
    ov.style.fontSize = OCR_BASE_FONT_PX + 'px';
    ov.style.lineHeight = (ocrLineHeight() / 100).toFixed(2);
    ov.style.letterSpacing = (ocrTracking() / 10).toFixed(1) + 'px';

    // Position with user-adjustable offset
    ov.style.left = (originX + ocrOffsetX()) + 'px';
    ov.style.top = (originY + ocrOffsetY()) + 'px';
    ov.innerHTML = html;

    // When font changes, force re-measure
    if (!natSize.w) {
      // Wait a tick to ensure font is rendered before measuring
      requestAnimationFrame(() => {
        if (!html || html.length < 32) return;
        ov.style.transform = 'none';
        natSize.w = ov.scrollWidth || 1;
        natSize.h = ov.scrollHeight || 1;
        const sx = (targetW / natSize.w) * (ocrScaleX() / 100);
        const sy = (targetH / natSize.h) * (ocrScaleY() / 100);
        ov.style.transform = `scale(${sx},${sy})`;
      });
    } else if (natSize.w) {
      const sx = (targetW / natSize.w) * (ocrScaleX() / 100);
      const sy = (targetH / natSize.h) * (ocrScaleY() / 100);
      ov.style.transform = `scale(${sx},${sy})`;
    }
  });

  return (
    <div id="screen-wrap">
      <canvas id="screen" ref={canvasRef} />
      <pre
        id="transcribe-overlay"
        ref={overlayRef}
        class={transcribeMode() !== 'off' ? 'active' : ''}
      />
      <Toast />
    </div>
  );
}
