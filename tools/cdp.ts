/**
 * Minimal Chrome DevTools Protocol client for headless page capture.
 *
 * No Puppeteer/Playwright dependency: Node ships a global WebSocket, so a
 * page-level CDP session is a few dozen lines of JSON-RPC. Used by
 * tools/machine-images.ts to photograph the on-screen keyboards the app draws.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Page {
  /** Evaluate an expression in the page and return its JSON value. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Pixel rectangle of `selector`, in CSS pixels, or null when absent. */
  rect(selector: string): Promise<Rect | null>;
  /** Screenshot a CSS-pixel rectangle, at `scale` device pixels per CSS pixel. */
  capture(rect: Rect, scale?: number): Promise<Uint8Array>;
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  /** Poll `expression` until it returns truthy, or throw after `timeoutMs`. */
  waitFor(expression: string, timeoutMs?: number, label?: string): Promise<void>;
  setViewport(width: number, height: number, deviceScaleFactor?: number): Promise<void>;
  close(): Promise<void>;
}

interface RpcResult {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/** Locate an installed Chromium-family browser. */
export function findBrowser(): string {
  const candidates = [
    process.env.ZX84_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe` : undefined,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('No Chromium-family browser found; set ZX84_BROWSER to one.');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function launch(): Promise<Page> {
  const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'zx84-cdp-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc: ChildProcess = spawn(findBrowser(), [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });

  const base = `http://127.0.0.1:${port}`;
  let version: { webSocketDebuggerUrl?: string } | null = null;
  for (let i = 0; i < 150 && !version; i++) {
    try {
      const r = await fetch(`${base}/json/version`);
      if (r.ok) version = await r.json() as { webSocketDebuggerUrl?: string };
    } catch { /* not up yet */ }
    if (!version) await sleep(100);
  }
  if (!version?.webSocketDebuggerUrl) {
    proc.kill();
    throw new Error('Headless browser did not expose a debugging endpoint.');
  }

  const created = await fetch(`${base}/json/new?about:blank`, { method: 'PUT' });
  const target = await created.json() as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: RpcResult) => void; reject: (e: Error) => void }>();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data)) as RpcResult;
    if (msg.id === undefined) return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message ?? 'CDP error'));
    else slot.resolve(msg);
  });

  const send = (method: string, params: Record<string, unknown> = {}): Promise<RpcResult> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const result = r.result as {
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed');
    }
    return result.result?.value as T;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  return {
    evaluate,
    async rect(selector) {
      return evaluate<Rect | null>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`);
    },
    async capture(clip, scale = 1) {
      const r = await send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { ...clip, scale },
      });
      const data = (r.result as { data?: string }).data;
      if (!data) throw new Error('Screenshot returned no data');
      return new Uint8Array(Buffer.from(data, 'base64'));
    },
    async navigate(url) {
      await send('Page.navigate', { url });
    },
    async reload() {
      await send('Page.reload', { ignoreCache: false });
    },
    async waitFor(expression, timeoutMs = 30_000, label = expression) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          if (await evaluate<boolean>(`(() => { try { return !!(${expression}); } catch { return false; } })()`)) return;
        } catch { /* page may be mid-navigation */ }
        await sleep(100);
      }
      throw new Error(`Timed out waiting for ${label}`);
    },
    async setViewport(width, height, deviceScaleFactor = 1) {
      await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor, mobile: false,
      });
    },
    async close() {
      try { ws.close(); } catch { /* */ }
      proc.kill();
      await sleep(200);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}
