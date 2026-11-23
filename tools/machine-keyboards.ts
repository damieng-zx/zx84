/**
 * machine-keyboards.ts — photograph each machine's on-screen keyboard.
 *
 * The faces are Solid components drawn by the browser, so they are captured
 * headless through CDP (tools/cdp.ts) against the dev server:
 *
 *   npx tsx tools/machine-images.ts keyboard [model...]
 *
 * Each shot hides the rest of the app and pins the face's scale directly (the
 * same `--keyboard-scene-px` variable the zoomed pane sets), so the picture is
 * the machine's case and keys at a known size and nothing else. Machines with
 * no keyboard contribution (the Enterprise) report that and are skipped.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { launch, type Page } from './cdp.ts';
import type { Shot } from './machine-images.ts';

const BASE = process.env.ZX84_DEV_URL ?? 'http://localhost:5199';
/** Output width in CSS pixels; the face is scaled to fill it. */
const TARGET_WIDTH = 860;

/**
 * Strip the app down to the keyboard: no sidebars, screen or status bar, no
 * pane chrome, and the face at an explicit scale. The scale is applied after
 * the design size is known, so it is spliced in by the caller.
 */
const CHROME = `
  #sidebar, #right-sidebar, #screen-wrap, #status-bar, #diag,
  .tooltip, .toast, .drag-overlay { display: none !important; }
  html, body, #app, #main { background: transparent !important; margin: 0 !important;
    padding: 0 !important; overflow: hidden !important; }
  #main { display: block !important; width: max-content !important; }
  #keyboard-panel { background: transparent !important; border: 0 !important;
    box-shadow: none !important; width: max-content !important; height: auto !important;
    position: static !important; resize: none !important; }
  #keyboard-panel > .section-label { display: none !important; }
  #keyboard-panel > .pane-content { padding: 0 !important; overflow: visible !important; }
  #keyboard-panel .pane-content-inner { overflow: visible !important; }
  #keyboard-panel .keyboard-scene-frame { container-type: normal !important; }
`;

function chromeCss(scalePx: number): string {
  return `${CHROME}
  #keyboard-panel .keyboard-scene { --keyboard-scene-px: ${scalePx}px !important; }
  `;
}

/** Apply the stripped layout, keeping the style node idempotent. */
async function style(page: Page, css: string): Promise<void> {
  await page.evaluate(`(() => {
    let el = document.getElementById('zx84-shot');
    if (!el) { el = document.createElement('style'); el.id = 'zx84-shot'; document.head.appendChild(el); }
    el.textContent = ${JSON.stringify(css)};
  })()`);
}

/**
 * Wait for the app's keyboard face. Machines without one never render the pane,
 * so this resolves false on timeout rather than erroring.
 */
async function awaitFace(page: Page, timeoutMs = 20_000): Promise<boolean> {
  try {
    await page.waitFor(`document.querySelector('#keyboard-panel .keyboard-scene')`, timeoutMs, 'a keyboard face');
    return true;
  } catch {
    return false;
  }
}

/** The face's design size in its own units. */
async function faceSize(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate<{ width: number; height: number }>(`(() => {
    const el = document.querySelector('#keyboard-panel .keyboard-scene');
    if (!el) return { width: 0, height: 0 };
    const cs = getComputedStyle(el);
    return {
      width: Number(cs.getPropertyValue('--keyboard-scene-width')),
      height: Number(cs.getPropertyValue('--keyboard-scene-height')),
    };
  })()`);
}

export async function captureKeyboards(shots: readonly Shot[], outDir: string): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  // Fail loudly rather than per-machine: a stopped dev server would otherwise
  // look like 23 machines without keyboards.
  const probe = await fetch(`${BASE}/`).catch(() => null);
  if (!probe?.ok) {
    throw new Error(`No dev server at ${BASE} — start it with "npx vite --port 5199" first (set ZX84_DEV_URL to override).`);
  }
  const page = await launch();
  try {
    for (const shot of shots) {
      const url = `${BASE}/?model=${encodeURIComponent(shot.model)}`;
      const file = path.join(outDir, `${shot.sheet}-keyboard.png`);
      let lastError = '';
      let done = false;
      for (let attempt = 0; attempt < 3 && !done; attempt++) {
        try {
          // Pass 1: boot the model and read the face's design size.
          await page.setViewport(1600, 1000, 1);
          await page.navigate(url);
          await page.waitFor(`document.querySelector('#screen')`, 60_000, 'the app');
          if (!(await awaitFace(page))) {
            console.log(`${shot.sheet}: no on-screen keyboard for ${shot.model}`);
            done = true;
            break;
          }
          const design = await faceSize(page);
          if (!design.width || !design.height) throw new Error('the face reported no design size');

          // Pass 2: a viewport exactly the face's size at the chosen scale, and
          // the face pinned to that scale rather than to the pane's fit.
          const scalePx = TARGET_WIDTH / design.width;
          const width = Math.ceil(design.width * scalePx);
          const height = Math.ceil(design.height * scalePx);
          await page.setViewport(width, height, 1);
          await style(page, chromeCss(scalePx));
          // The face is complete once its lazy chunk and fonts are in.
          await page.evaluate(`new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250))); })`);

          const box = await page.rect('#keyboard-panel');
          if (!box || box.width < 10) throw new Error('no keyboard pane box');
          // Capture at 1:1 — the viewport was already sized to TARGET_WIDTH, so
          // the file is exactly that wide and a docs column never has to
          // downscale it (resampling is what blurs the key legends).
          const png = await page.capture({
            x: Math.floor(box.x), y: Math.floor(box.y),
            width: Math.ceil(box.width), height: Math.ceil(box.height),
          }, 1);
          fs.writeFileSync(file, png);
          console.log(`${shot.sheet}-keyboard.png  ${shot.model}  ${Math.round(box.width)}x${Math.round(box.height)}  ${png.length} bytes`);
          done = true;
        } catch (error) {
          lastError = (error as Error).message;
        }
      }
      if (!done) console.error(`${shot.sheet}: ${shot.model} keyboard FAILED — ${lastError}`);
    }
  } finally {
    await page.close();
  }
}
