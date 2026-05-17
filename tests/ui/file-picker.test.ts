/**
 * file-picker.ts — openFile() with two paths:
 *   1. Native File System Access API (showOpenFilePicker on window)
 *   2. Fallback <input type="file"> in older browsers
 *
 * Both paths are exercised here against stub DOM/window globals.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Stub DOM (just what file-picker uses) ────────────────────────────────

class StubInput {
  tagName = 'input';
  type = '';
  multiple = false;
  accept = '';
  style: Record<string, string> = {};
  files: any[] | null = null;
  parent: StubBody | null = null;
  clicked = false;
  private listeners: Record<string, ((e: any) => void)[]> = {};
  addEventListener(type: string, fn: (e: any) => void): void {
    (this.listeners[type] ||= []).push(fn);
  }
  click(): void { this.clicked = true; }
  dispatch(type: string, ev: any = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
}

class StubBody {
  children: StubInput[] = [];
  appendChild(c: StubInput): StubInput { c.parent = this; this.children.push(c); return c; }
  removeChild(c: StubInput): StubInput {
    this.children = this.children.filter(x => x !== c);
    c.parent = null;
    return c;
  }
}

class StubDocument {
  body = new StubBody();
  lastInput: StubInput | null = null;
  createElement(tag: string): StubInput {
    expect(tag).toBe('input');
    const i = new StubInput();
    this.lastInput = i;
    return i;
  }
}

// A File-like object with an arrayBuffer() method.
function makeFile(name: string, bytes: number[]): any {
  const buf = new Uint8Array(bytes).buffer;
  return { name, async arrayBuffer() { return buf; } };
}

let doc: StubDocument;

beforeEach(() => {
  doc = new StubDocument();
  (globalThis as any).document = doc;
  // Default: no window, so the fallback path is taken unless a test installs one.
  (globalThis as any).window = {};
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).window;
  vi.useRealTimers();
});

async function freshImport() { return await import('@/ui/file-picker.ts'); }

// ── Native showOpenFilePicker path ────────────────────────────────────────

describe('file-picker — native showOpenFilePicker', () => {
  it('returns the chosen files with name and bytes', async () => {
    const file = makeFile('GAME.SNA', [1, 2, 3, 4]);
    const handle = { async getFile() { return file; } };
    const picker = vi.fn(async () => [handle]);
    (globalThis as any).window = { showOpenFilePicker: picker };

    const m = await freshImport();
    const result = await m.openFile({ id: 'snapshots', extensions: ['.sna'] });

    expect(result).not.toBeNull();
    expect(result![0].name).toBe('GAME.SNA');
    expect(Array.from(result![0].data)).toEqual([1, 2, 3, 4]);

    // Picker was invoked with the requested id + extensions wired through.
    const args = picker.mock.calls[0][0];
    expect(args.id).toBe('snapshots');
    expect(args.multiple).toBe(false);
    expect(args.types[0].accept['*/*']).toEqual(['.sna']);
  });

  it('passes multiple=true through to the picker and returns all selections', async () => {
    const fileA = makeFile('A.TAP', [0xAA]);
    const fileB = makeFile('B.TAP', [0xBB]);
    const picker = vi.fn(async () => [
      { async getFile() { return fileA; } },
      { async getFile() { return fileB; } },
    ]);
    (globalThis as any).window = { showOpenFilePicker: picker };

    const m = await freshImport();
    const result = await m.openFile({ id: 'tapes', extensions: ['.tap', '.tzx'], multiple: true });

    expect(result!.map(r => r.name)).toEqual(['A.TAP', 'B.TAP']);
    expect(picker.mock.calls[0][0].multiple).toBe(true);
  });

  it('returns null when the user dismisses the native picker (AbortError thrown)', async () => {
    (globalThis as any).window = {
      showOpenFilePicker: async () => { throw new DOMException?.('aborted', 'AbortError') ?? new Error('abort'); },
    };
    const m = await freshImport();
    expect(await m.openFile({ id: 'x', extensions: ['.tap'] })).toBeNull();
  });
});

// ── Fallback <input type="file"> path ─────────────────────────────────────

describe('file-picker — fallback <input>', () => {
  it('configures and clicks the input element', async () => {
    const m = await freshImport();
    const promise = m.openFile({ id: 'x', extensions: ['.sna', '.z80'], multiple: true });
    const input = doc.lastInput!;
    expect(input.type).toBe('file');
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe('.sna,.z80');
    expect(input.clicked).toBe(true);
    expect(input.parent).toBe(doc.body);

    // Now cancel to settle the promise.
    input.dispatch('cancel');
    await promise;
  });

  it('returns file contents on change event', async () => {
    const m = await freshImport();
    const promise = m.openFile({ id: 'x', extensions: ['.tap'] });
    const input = doc.lastInput!;
    input.files = [makeFile('one.tap', [10, 20, 30])];
    input.dispatch('change');
    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].name).toBe('one.tap');
    expect(Array.from(result![0].data)).toEqual([10, 20, 30]);
  });

  it('returns null when change fires with empty file list', async () => {
    const m = await freshImport();
    const promise = m.openFile({ id: 'x', extensions: ['.tap'] });
    const input = doc.lastInput!;
    input.files = [];
    input.dispatch('change');
    expect(await promise).toBeNull();
  });

  it('returns null on cancel event', async () => {
    const m = await freshImport();
    const promise = m.openFile({ id: 'x', extensions: ['.tap'] });
    doc.lastInput!.dispatch('cancel');
    expect(await promise).toBeNull();
  });

  it('removes the input from the DOM after settling', async () => {
    const m = await freshImport();
    const promise = m.openFile({ id: 'x', extensions: ['.tap'] });
    const input = doc.lastInput!;
    expect(doc.body.children).toContain(input);
    input.dispatch('cancel');
    await promise;
    expect(doc.body.children).not.toContain(input);
  });

  it('only resolves once — late events after settle are ignored', async () => {
    const m = await freshImport();
    const promise = m.openFile({ id: 'x', extensions: ['.tap'] });
    const input = doc.lastInput!;
    input.files = [makeFile('first.tap', [1])];
    input.dispatch('change');
    const result = await promise;
    expect(result!.length).toBe(1);
    expect(result![0].name).toBe('first.tap');

    // Once removed, further events must not throw, must not double-remove,
    // and must not somehow re-resolve the (already-settled) promise.
    input.files = [makeFile('second.tap', [2])];
    expect(() => input.dispatch('change')).not.toThrow();
    expect(() => input.dispatch('cancel')).not.toThrow();
    // body should still have zero children — no re-append, no leftover.
    expect(doc.body.children.length).toBe(0);
  });

  it('resolves to null (and tears down) when arrayBuffer() throws', async () => {
    const m = await freshImport();
    const promise = m.openFile({ id: 'x', extensions: ['.tap'] });
    const input = doc.lastInput!;
    input.files = [{
      name: 'broken.tap',
      async arrayBuffer() { throw new Error('read failed'); },
    }];
    input.dispatch('change');
    expect(await promise).toBeNull();
    // Input must be removed — otherwise it stays glued to <body> for 120s.
    expect(doc.body.children).not.toContain(input);
  });

  it('eventually times out to null if nothing happens', async () => {
    vi.useFakeTimers();
    const m = await freshImport();
    const promise = m.openFile({ id: 'x', extensions: ['.tap'] });

    await vi.advanceTimersByTimeAsync(119_999);
    // Race the promise against a sentinel — if it resolved early, we'd see 'sentinel' lose.
    const sentinel = Symbol('not yet');
    const early = await Promise.race([promise, Promise.resolve(sentinel)]);
    expect(early).toBe(sentinel);

    await vi.advanceTimersByTimeAsync(2);
    expect(await promise).toBeNull();
  });
});
