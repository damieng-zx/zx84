/**
 * zip-picker.ts — modal filename chooser built from raw DOM nodes.
 *
 * Tests run in node, so we install a minimal DOM stub: just enough
 * createElement / event-target plumbing for the picker to attach,
 * fire its handlers, and clean itself up.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { showFilePicker } from '@/ui/zip-picker.ts';

// ── Minimal DOM stub ──────────────────────────────────────────────────────

interface StubListener { type: string; fn: (e: any) => void; }

class StubElement {
  tagName: string;
  children: StubElement[] = [];
  parent: StubElement | null = null;
  style: Record<string, string> = {};
  textContent = '';
  private listeners: StubListener[] = [];

  constructor(tag: string) { this.tagName = tag.toLowerCase(); }

  appendChild(child: StubElement): StubElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove(): void {
    if (this.parent) {
      this.parent.children = this.parent.children.filter(c => c !== this);
      this.parent = null;
    }
  }
  addEventListener(type: string, fn: (e: any) => void): void {
    this.listeners.push({ type, fn });
  }
  removeEventListener(type: string, fn: (e: any) => void): void {
    this.listeners = this.listeners.filter(l => !(l.type === type && l.fn === fn));
  }
  dispatch(type: string, event: any): void {
    for (const l of this.listeners) if (l.type === type) l.fn(event);
  }
  // Recursively find a child whose textContent matches.
  findByText(text: string): StubElement | null {
    if (this.textContent === text && this.children.length === 0) return this;
    for (const c of this.children) {
      const hit = c.findByText(text);
      if (hit) return hit;
    }
    return null;
  }
}

class StubDocument {
  body = new StubElement('body');
  private docListeners: StubListener[] = [];
  createElement(tag: string): StubElement { return new StubElement(tag); }
  addEventListener(type: string, fn: (e: any) => void): void {
    this.docListeners.push({ type, fn });
  }
  removeEventListener(type: string, fn: (e: any) => void): void {
    this.docListeners = this.docListeners.filter(l => !(l.type === type && l.fn === fn));
  }
  dispatchKey(key: string): { defaultPrevented: boolean } {
    const ev = { key, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; } };
    for (const l of [...this.docListeners]) if (l.type === 'keydown') l.fn(ev);
    return ev;
  }
  get keydownListenerCount(): number {
    return this.docListeners.filter(l => l.type === 'keydown').length;
  }
}

let doc: StubDocument;

beforeEach(() => {
  doc = new StubDocument();
  (globalThis as any).document = doc;
});

afterEach(() => {
  delete (globalThis as any).document;
});

// Helpers to dig into the overlay/panel structure.
function overlay(): StubElement {
  expect(doc.body.children.length).toBe(1);
  return doc.body.children[0];
}
function panel(): StubElement { return overlay().children[0]; }
function listItems(): StubElement[] {
  // panel children: [title, list, cancelBtn]; list children are the file items.
  return panel().children[1].children;
}
function cancelButton(): StubElement {
  const ps = panel().children;
  return ps[ps.length - 1];
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('zip-picker — selection', () => {
  it('resolves with the clicked filename', async () => {
    const promise = showFilePicker(['game.tap', 'readme.txt', 'loader.bas']);

    const items = listItems();
    expect(items.map(i => i.textContent)).toEqual(['game.tap', 'readme.txt', 'loader.bas']);
    items[1].dispatch('click', {});
    expect(await promise).toBe('readme.txt');
  });

  it('handles an empty filename list (renders no items, still cancellable)', async () => {
    const promise = showFilePicker([]);
    expect(listItems()).toHaveLength(0);
    cancelButton().dispatch('click', {});
    expect(await promise).toBeNull();
  });
});

describe('zip-picker — cancellation', () => {
  it('returns null on cancel button click', async () => {
    const promise = showFilePicker(['a', 'b']);
    cancelButton().dispatch('click', {});
    expect(await promise).toBeNull();
  });

  it('returns null on Escape', async () => {
    const promise = showFilePicker(['a']);
    const ev = doc.dispatchKey('Escape');
    expect(await promise).toBeNull();
    // Escape should be consumed so it doesn't trigger app-level shortcuts.
    expect(ev.defaultPrevented).toBe(true);
  });

  it('ignores other keys (no spurious resolution)', async () => {
    const promise = showFilePicker(['a']);
    let settled = false;
    promise.then(() => { settled = true; });
    doc.dispatchKey('Enter');
    doc.dispatchKey(' ');
    // Microtask drain.
    await Promise.resolve();
    expect(settled).toBe(false);
    cancelButton().dispatch('click', {});
    await promise;
  });

  it('returns null when the overlay backdrop is clicked', async () => {
    const promise = showFilePicker(['a']);
    const ov = overlay();
    ov.dispatch('click', { target: ov });
    expect(await promise).toBeNull();
  });

  it('does NOT resolve when an inner element is clicked (event bubbles up with target=child)', async () => {
    const promise = showFilePicker(['a']);
    const ov = overlay();
    // Simulate a click that bubbled from the panel — target !== overlay.
    ov.dispatch('click', { target: panel() });
    let settled = false;
    promise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    cancelButton().dispatch('click', {});
    await promise;
  });
});

describe('zip-picker — hover styles', () => {
  it('highlights a list item on mouseenter and restores on mouseleave', () => {
    showFilePicker(['a', 'b']);
    const item = listItems()[0];
    item.dispatch('mouseenter', {});
    expect(item.style.background).toBe('#3a3a5e');
    item.dispatch('mouseleave', {});
    expect(item.style.background).toBe('#2a2a3e');
    cancelButton().dispatch('click', {});
  });

  it('highlights the cancel button on mouseenter and restores on mouseleave', () => {
    showFilePicker(['a']);
    const btn = cancelButton();
    btn.dispatch('mouseenter', {});
    expect(btn.style.background).toBe('#3a3a5e');
    btn.dispatch('mouseleave', {});
    expect(btn.style.background).toBe('#2a2a3e');
    btn.dispatch('click', {});
  });
});

describe('zip-picker — cleanup', () => {
  it('removes the overlay and keydown listener after resolution', async () => {
    const promise = showFilePicker(['a']);
    expect(doc.body.children.length).toBe(1);
    expect(doc.keydownListenerCount).toBe(1);
    listItems()[0].dispatch('click', {});
    await promise;
    expect(doc.body.children.length).toBe(0);
    expect(doc.keydownListenerCount).toBe(0);
  });

  it('only resolves once even if multiple cancel paths fire', async () => {
    const promise = showFilePicker(['a', 'b']);
    // Save a reference before cleanup detaches everything.
    const cancel = cancelButton();
    listItems()[0].dispatch('click', {});
    // Overlay is detached; keydown listener is gone. But the cancel button still
    // has its listener — dispatching on the saved ref exercises finish() with
    // resolved=true and hits the early-return guard.
    cancel.dispatch('click', {});
    expect(await promise).toBe('a');
  });
});
