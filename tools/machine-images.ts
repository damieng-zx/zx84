/**
 * machine-images.ts — capture every machine's boot screen for its docs sheet.
 *
 *   npx tsx tools/machine-images.ts screen [model|sheet...]
 *   npx tsx tools/machine-images.ts keyboard [model|sheet...]
 *
 * Screens come from the machine's own frame buffer, exactly as the video
 * hardware drew it — the same picture the MCP `screenshot` tool writes, so no
 * browser is needed. Keyboards are the on-screen faces the browser renders and
 * are captured headless through tools/cdp.ts, which needs the dev server
 * (`npx vite --port 5199`) and a Chromium-family browser.
 *
 * Pictures land in docs/images/machines/; tools/add-machine-images.ts then
 * puts them into the sheets.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { initMachine, state } from '../mcp/state.ts';
import { encodePNG } from '../mcp/png.ts';

const OUT = path.join(import.meta.dirname, '..', 'docs', 'images', 'machines');

export interface Shot {
  /** Machine sheet the image belongs to (docs/machines/<sheet>.md). */
  readonly sheet: string;
  /** Model id to boot. */
  readonly model: string;
  readonly label: string;
  /** Frames to settle on before the capture. */
  readonly frames?: number;
}

export const SHOTS: readonly Shot[] = [
  { sheet: 'zx-spectrum', model: 'zx48k', label: 'ZX Spectrum 48K' },
  { sheet: 'sinclair-clones', model: 'pentagon128', label: 'Pentagon 128' },
  { sheet: 'zx80-zx81', model: 'zx81', label: 'Sinclair ZX81' },
  { sheet: 'timex-computer-2048', model: 'tc2048', label: 'Timex Computer 2048' },
  { sheet: 'timex-sinclair-2068', model: 'ts2068', label: 'Timex Sinclair 2068' },
  { sheet: 'amstrad-cpc', model: 'cpc6128', label: 'Amstrad CPC 6128' },
  { sheet: 'amstrad-pcw', model: 'pcw8256', label: 'Amstrad PCW 8256' },
  { sheet: 'tatung-einstein', model: 'einstein-tc01', label: 'Tatung Einstein TC-01' },
  { sheet: 'msx', model: 'hx-10', label: 'Toshiba HX-10' },
  { sheet: 'memotech-mtx', model: 'mtx512', label: 'Memotech MTX512' },
  { sheet: 'camputers-lynx', model: 'lynx48', label: 'Camputers Lynx 48K' },
  { sheet: 'jupiter-ace', model: 'jupiter-ace', label: 'Jupiter Ace' },
  { sheet: 'enterprise', model: 'ep128', label: 'Enterprise 128', frames: 800 },
  { sheet: 'acorn-system', model: 'acorn-system5', label: 'Acorn System 5' },
  { sheet: 'acorn-atom', model: 'atom', label: 'Acorn Atom' },
  { sheet: 'bbc-micro', model: 'bbc-b', label: 'BBC Micro Model B' },
  { sheet: 'acorn-electron', model: 'electron', label: 'Acorn Electron' },
  { sheet: 'apple-i', model: 'apple1', label: 'Apple I' },
  { sheet: 'apple-ii', model: 'apple2e', label: 'Apple //e' },
  { sheet: 'atari-8bit', model: 'atari800xl', label: 'Atari 800XL' },
  { sheet: 'commodore-64', model: 'c64', label: 'Commodore 64' },
  { sheet: 'commodore-128', model: 'c128', label: 'Commodore 128' },
  { sheet: 'commodore-vic-20', model: 'vic20', label: 'Commodore VIC-20' },
];

function shotsFor(args: readonly string[]): readonly Shot[] {
  if (args.length === 0) return SHOTS;
  return SHOTS.filter((s) => args.includes(s.model) || args.includes(s.sheet));
}

/** Boot `model`, settle it, and return the frame as a PNG. */
export async function screenPng(model: string, frames: number): Promise<{ png: Uint8Array; width: number; height: number }> {
  await initMachine(model as never);
  state.spec.runUntil(frames);
  const width = state.spec.frameWidth;
  const height = state.spec.frameHeight;
  const png = encodePNG(state.spec.pixels, width, height);
  state.spec.destroy();
  return { png, width, height };
}

async function captureScreens(args: readonly string[]): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  for (const shot of shotsFor(args)) {
    const frames = shot.frames ?? 150;
    try {
      const { png, width, height } = await screenPng(shot.model, frames);
      const file = path.join(OUT, `${shot.sheet}.png`);
      fs.writeFileSync(file, png);
      console.log(`${shot.sheet}.png  ${shot.model}  ${width}x${height}  ${png.length} bytes`);
    } catch (error) {
      console.error(`${shot.sheet}: ${shot.model} FAILED — ${(error as Error).message}`);
    }
  }
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'screen') {
  await captureScreens(rest);
} else if (command === 'keyboard') {
  const { captureKeyboards } = await import('./machine-keyboards.ts');
  await captureKeyboards(shotsFor(rest), OUT);
} else {
  console.error('usage: machine-images.ts screen|keyboard [model...]');
  process.exitCode = 1;
}
