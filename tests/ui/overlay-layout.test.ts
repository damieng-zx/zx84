import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOverlayLayout } from '@/ui/components/overlay-layout.ts';

describe('overlay font and layout scheduling', () => {
  let frames: Map<number, FrameRequestCallback>;
  let fontLoads: { resolve: () => void; reject: () => void }[];
  let fontLoad: ReturnType<typeof vi.fn>;
  let element: HTMLPreElement;
  let width: number;
  let height: number;

  beforeEach(() => {
    frames = new Map();
    fontLoads = [];
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++id, cb); return id; });
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame));
    fontLoad = vi.fn(() => new Promise<void>((resolve, reject) => {
      fontLoads.push({ resolve, reject: () => reject(new Error('offline')) });
    }));
    vi.stubGlobal('document', { fonts: { load: fontLoad } });
    width = 100; height = 50;
    element = {
      style: { transform: '', visibility: '' },
      get scrollWidth() { return width; },
      get scrollHeight() { return height; },
    } as unknown as HTMLPreElement;
  });
  afterEach(() => vi.unstubAllGlobals());

  function paint() {
    const callbacks = [...frames.values()]; frames.clear();
    for (const cb of callbacks) cb(0);
  }

  it('remeasures automatically after a delayed font loads on a static screen', async () => {
    const layout = createOverlayLayout();
    layout.update(element, '16px Example Mono', 600, 300);
    expect(fontLoad).toHaveBeenCalledWith('16px Example Mono');
    expect(frames.size).toBe(0);
    width = 200; height = 100; // loaded font has different metrics
    fontLoads[0].resolve(); await Promise.resolve(); paint();
    expect(element.style.transform).toBe('scale(3,3)');
    expect(element.style.visibility).toBe('');
  });

  it('uses the latest grid and target geometry while waiting for the font', async () => {
    const layout = createOverlayLayout();
    layout.update(element, '16px Example Mono', 600, 300);
    layout.update(element, '16px Example Mono', 800, 400);
    width = 400; height = 100;
    fontLoads[0].resolve(); await Promise.resolve(); paint();
    expect(element.style.transform).toBe('scale(2,4)');
    expect(fontLoad).toHaveBeenCalledTimes(1);
  });

  it('ignores an old font completion after toggling off and on', async () => {
    const layout = createOverlayLayout();
    layout.update(element, '16px Old Mono', 600, 300);
    layout.cancel();
    layout.update(element, '16px New Mono', 800, 400);
    fontLoads[0].resolve(); await Promise.resolve();
    expect(frames.size).toBe(0);
    fontLoads[1].resolve(); await Promise.resolve(); paint();
    expect(element.style.transform).toBe('scale(8,8)');
  });

  it('cancels a queued measurement when disabled', async () => {
    const layout = createOverlayLayout();
    layout.update(element, '16px Example Mono', 600, 300);
    fontLoads[0].resolve(); await Promise.resolve();
    layout.cancel(); paint();
    expect(element.style.transform).toBe('');
  });

  it('coalesces updates without starving measurement on a changing screen', async () => {
    const layout = createOverlayLayout();
    layout.update(element, '16px Example Mono', 600, 300);
    fontLoads[0].resolve(); await Promise.resolve();
    layout.update(element, '16px Example Mono', 800, 400);
    expect(frames.size).toBe(1);
    paint();
    width = 200; height = 200;
    layout.update(element, '16px Example Mono', 800, 400);
    paint();
    expect(element.style.transform).toBe('scale(4,2)');
  });

  it('measures fallback metrics if downloading the font fails', async () => {
    const layout = createOverlayLayout();
    layout.update(element, '16px Example Mono', 600, 300);
    fontLoads[0].reject(); await Promise.resolve(); paint();
    expect(element.style.transform).toBe('scale(6,6)');
    expect(element.style.visibility).toBe('');
  });
});
