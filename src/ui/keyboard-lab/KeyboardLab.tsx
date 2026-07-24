import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from 'solid-js';
import { keyboardLabPresetLoaders } from '../machine-ui.ts';
import {
  alignKeys,
  cloneDocument,
  distributeKeys,
  documentAsJson,
  documentAsTypeScript,
  keysIntersectingBox,
  parseKeyboardLabDocument,
  shapeClip,
  snapValue,
  type AlignMode,
} from './operations.ts';
import type {
  KeyboardLabDocument,
  KeyboardLabKey,
  KeyboardLabShape,
} from './types.ts';
import './keyboard-lab.css';

const EMPTY_DOCUMENT: KeyboardLabDocument = {
  version: 1,
  id: 'new-keyboard',
  name: 'New keyboard',
  theme: 'neutral',
  scene: { width: 800, height: 300 },
  keys: [],
};

type ResizeEdge = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

interface DragState {
  readonly mode: 'move' | 'resize';
  readonly edge?: ResizeEdge;
  readonly startX: number;
  readonly startY: number;
  readonly before: KeyboardLabDocument;
  readonly ids: readonly string[];
  dirty: boolean;
}

interface MarqueeState {
  readonly startX: number;
  readonly startY: number;
  readonly sceneLeft: number;
  readonly sceneTop: number;
  readonly baseIds: readonly string[];
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

function downloadText(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

function numberFromInput(event: Event, fallback: number): number {
  const value = Number((event.currentTarget as HTMLInputElement).value);
  return Number.isFinite(value) ? value : fallback;
}

export function KeyboardLab() {
  const [layout, setLayout] = createSignal(cloneDocument(EMPTY_DOCUMENT));
  const [presets, setPresets] = createSignal<readonly KeyboardLabDocument[]>([]);
  const [selectedIds, setSelectedIds] = createSignal<readonly string[]>([]);
  const [zoom, setZoom] = createSignal(0.75);
  const [grid, setGrid] = createSignal(1);
  const [snap, setSnap] = createSignal(true);
  const [referenceUrl, setReferenceUrl] = createSignal<string>();
  const [status, setStatus] = createSignal('Loading built-in keyboards…');
  const [history, setHistory] = createSignal<readonly KeyboardLabDocument[]>([]);
  const [future, setFuture] = createSignal<readonly KeyboardLabDocument[]>([]);
  const [marquee, setMarquee] = createSignal<MarqueeState>();
  let drag: DragState | undefined;
  let referenceInput!: HTMLInputElement;
  let importInput!: HTMLInputElement;

  const selectedSet = createMemo(() => new Set(selectedIds()));
  const selectedKeys = createMemo(() =>
    layout().keys.filter((key) => selectedSet().has(key.id)));
  const selectedKey = createMemo(() =>
    selectedKeys().length === 1 ? selectedKeys()[0] : undefined);

  function announce(message: string): void {
    setStatus(message);
  }

  function setDocument(next: KeyboardLabDocument, remember = true): void {
    if (remember) {
      setHistory((items) => [...items.slice(-49), cloneDocument(layout())]);
      setFuture([]);
    }
    setLayout(cloneDocument(next));
  }

  function undo(): void {
    const items = history();
    const previous = items.at(-1);
    if (!previous) return;
    setFuture((entries) => [cloneDocument(layout()), ...entries.slice(0, 49)]);
    setHistory(items.slice(0, -1));
    setLayout(cloneDocument(previous));
    setSelectedIds([]);
    announce('Undid last change');
  }

  function redo(): void {
    const items = future();
    const next = items[0];
    if (!next) return;
    setHistory((entries) => [...entries.slice(-49), cloneDocument(layout())]);
    setFuture(items.slice(1));
    setLayout(cloneDocument(next));
    setSelectedIds([]);
    announce('Redid change');
  }

  function updateKeys(
    transform: (keys: readonly KeyboardLabKey[]) => readonly KeyboardLabKey[],
    message?: string,
  ): void {
    setDocument({ ...layout(), keys: transform(layout().keys) });
    if (message) announce(message);
  }

  function updateKey(id: string, transform: (key: KeyboardLabKey) => KeyboardLabKey): void {
    updateKeys((keys) => keys.map((key) => key.id === id ? transform(key) : key));
  }

  function choosePreset(id: string): void {
    const preset = presets().find((item) => item.id === id);
    if (!preset) return;
    setDocument(preset);
    setSelectedIds([]);
    setHistory([]);
    setFuture([]);
    setReferenceUrl(undefined);
    announce(`Loaded ${preset.name}`);
  }

  function selectKey(event: PointerEvent, id: string): readonly string[] {
    const current = selectedIds();
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      const next = current.includes(id)
        ? current.filter((selected) => selected !== id)
        : [...current, id];
      setSelectedIds(next);
      return next;
    }
    if (current.includes(id)) return current;
    setSelectedIds([id]);
    return [id];
  }

  function startMove(event: PointerEvent, id: string): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const ids = selectKey(event, id);
    if (!ids.includes(id)) return;
    drag = {
      mode: 'move',
      startX: event.clientX,
      startY: event.clientY,
      before: cloneDocument(layout()),
      ids,
      dirty: false,
    };
  }

  function startResize(event: PointerEvent, edge: ResizeEdge): void {
    event.preventDefault();
    event.stopPropagation();
    const key = selectedKey();
    if (!key) return;
    drag = {
      mode: 'resize',
      edge,
      startX: event.clientX,
      startY: event.clientY,
      before: cloneDocument(layout()),
      ids: [key.id],
      dirty: false,
    };
  }

  function startMarquee(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (!event.ctrlKey && !event.metaKey) {
      setSelectedIds([]);
      return;
    }
    event.preventDefault();
    const scene = event.currentTarget as HTMLElement;
    const bounds = scene.getBoundingClientRect();
    const startX = Math.max(0, Math.min(
      layout().scene.width,
      (event.clientX - bounds.left) / zoom(),
    ));
    const startY = Math.max(0, Math.min(
      layout().scene.height,
      (event.clientY - bounds.top) / zoom(),
    ));
    setMarquee({
      startX,
      startY,
      sceneLeft: bounds.left,
      sceneTop: bounds.top,
      baseIds: [...selectedIds()],
      box: { x: startX, y: startY, width: 0, height: 0 },
    });
  }

  function onPointerMove(event: PointerEvent): void {
    const activeMarquee = marquee();
    if (activeMarquee) {
      const currentX = Math.max(0, Math.min(
        layout().scene.width,
        (event.clientX - activeMarquee.sceneLeft) / zoom(),
      ));
      const currentY = Math.max(0, Math.min(
        layout().scene.height,
        (event.clientY - activeMarquee.sceneTop) / zoom(),
      ));
      const box = {
        x: Math.min(activeMarquee.startX, currentX),
        y: Math.min(activeMarquee.startY, currentY),
        width: Math.abs(currentX - activeMarquee.startX),
        height: Math.abs(currentY - activeMarquee.startY),
      };
      const ids = new Set(activeMarquee.baseIds);
      for (const id of keysIntersectingBox(layout().keys, box)) ids.add(id);
      setSelectedIds([...ids]);
      setMarquee({ ...activeMarquee, box });
      return;
    }
    if (!drag) return;
    const deltaX = (event.clientX - drag.startX) / zoom();
    const deltaY = (event.clientY - drag.startY) / zoom();
    const useSnap = snap() && !event.altKey;
    const selected = new Set(drag.ids);
    const nextKeys = drag.before.keys.map((key) => {
      if (!selected.has(key.id)) return key;
      if (drag?.mode === 'move') {
        const x = key.box.x + deltaX;
        const y = key.box.y + deltaY;
        return {
          ...key,
          box: {
            ...key.box,
            x: useSnap ? snapValue(x, grid()) : x,
            y: useSnap ? snapValue(y, grid()) : y,
          },
        };
      }

      const edge = drag?.edge ?? 'se';
      let x = key.box.x;
      let y = key.box.y;
      let width = key.box.width;
      let height = key.box.height;
      if (edge.includes('e')) width = Math.max(4, key.box.width + deltaX);
      if (edge.includes('s')) height = Math.max(4, key.box.height + deltaY);
      if (edge.includes('w')) {
        x = Math.min(key.box.x + key.box.width - 4, key.box.x + deltaX);
        width = key.box.width + key.box.x - x;
      }
      if (edge.includes('n')) {
        y = Math.min(key.box.y + key.box.height - 4, key.box.y + deltaY);
        height = key.box.height + key.box.y - y;
      }
      return {
        ...key,
        box: {
          x: useSnap ? snapValue(x, grid()) : x,
          y: useSnap ? snapValue(y, grid()) : y,
          width: useSnap ? Math.max(4, snapValue(width, grid())) : width,
          height: useSnap ? Math.max(4, snapValue(height, grid())) : height,
        },
      };
    });
    drag.dirty = Math.abs(deltaX) > 0.01 || Math.abs(deltaY) > 0.01;
    setLayout({ ...drag.before, keys: nextKeys });
  }

  function onPointerUp(): void {
    const activeMarquee = marquee();
    if (activeMarquee) {
      setMarquee(undefined);
      const count = selectedIds().length;
      announce(count
        ? `Selected ${count} key${count === 1 ? '' : 's'}`
        : 'No keys in selection');
      return;
    }
    if (!drag) return;
    if (drag.dirty) {
      setHistory((items) => [...items.slice(-49), drag!.before]);
      setFuture([]);
      announce(drag.mode === 'move' ? 'Moved keys' : 'Resized key');
    }
    drag = undefined;
  }

  function nudge(dx: number, dy: number): void {
    if (!selectedIds().length) return;
    const ids = selectedSet();
    updateKeys((keys) => keys.map((key) => ids.has(key.id)
      ? { ...key, box: { ...key.box, x: key.box.x + dx, y: key.box.y + dy } }
      : key));
    announce(`Nudged ${selectedIds().length} key${selectedIds().length === 1 ? '' : 's'}`);
  }

  function addKey(): void {
    const existing = new Set(layout().keys.map((key) => key.id));
    let number = layout().keys.length + 1;
    while (existing.has(`key-${number}`)) number++;
    const id = `key-${number}`;
    updateKeys((keys) => [...keys, {
      id,
      box: { x: 20, y: 20, width: 38, height: 34 },
      legends: { main: 'KEY' },
      tone: 'cream',
      region: 'main',
      shape: 'rectangle',
    }], 'Added key');
    setSelectedIds([id]);
  }

  function duplicateSelection(): void {
    if (!selectedIds().length) return;
    const existing = new Set(layout().keys.map((key) => key.id));
    const duplicates: KeyboardLabKey[] = [];
    for (const key of selectedKeys()) {
      let suffix = 2;
      while (existing.has(`${key.id}-${suffix}`)) suffix++;
      const id = `${key.id}-${suffix}`;
      existing.add(id);
      duplicates.push({
        ...key,
        id,
        box: { ...key.box, x: key.box.x + 8, y: key.box.y + 8 },
        legends: { ...key.legends },
      });
    }
    updateKeys((keys) => [...keys, ...duplicates], 'Duplicated selection');
    setSelectedIds(duplicates.map((key) => key.id));
  }

  function deleteSelection(): void {
    if (!selectedIds().length) return;
    const ids = selectedSet();
    updateKeys((keys) => keys.filter((key) => !ids.has(key.id)), 'Deleted selection');
    setSelectedIds([]);
  }

  function align(mode: AlignMode): void {
    if (selectedIds().length < 2) return;
    updateKeys((keys) => alignKeys(keys, selectedSet(), mode), `Aligned ${mode}`);
  }

  function distribute(axis: 'horizontal' | 'vertical'): void {
    if (selectedIds().length < 3) return;
    updateKeys(
      (keys) => distributeKeys(keys, selectedSet(), axis),
      `Distributed ${axis === 'horizontal' ? 'horizontally' : 'vertically'}`,
    );
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (isTypingTarget(event.target)) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
      return;
    }
    if (command && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      duplicateSelection();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteSelection();
      return;
    }
    const amount = event.shiftKey ? 10 : 1;
    const directions: Record<string, readonly [number, number]> = {
      ArrowLeft: [-amount, 0],
      ArrowRight: [amount, 0],
      ArrowUp: [0, -amount],
      ArrowDown: [0, amount],
    };
    const direction = directions[event.key];
    if (direction) {
      event.preventDefault();
      nudge(...direction);
    }
  }

  function setKeyNumber(
    property: 'x' | 'y' | 'width' | 'height',
    event: Event,
  ): void {
    const key = selectedKey();
    if (!key) return;
    const value = numberFromInput(event, key.box[property]);
    updateKey(key.id, (item) => ({
      ...item,
      box: {
        ...item.box,
        [property]: property === 'width' || property === 'height'
          ? Math.max(4, value)
          : value,
      },
    }));
  }

  function setLegend(property: 'main' | 'shift' | 'aux', event: Event): void {
    const key = selectedKey();
    if (!key) return;
    const value = (event.currentTarget as HTMLInputElement).value;
    updateKey(key.id, (item) => ({
      ...item,
      legends: { ...item.legends, [property]: value || undefined },
    }));
  }

  function setKeyText(property: 'tone' | 'region' | 'clipPath', event: Event): void {
    const key = selectedKey();
    if (!key) return;
    const value = (event.currentTarget as HTMLInputElement).value;
    updateKey(key.id, (item) => ({ ...item, [property]: value || undefined }));
  }

  function setShape(event: Event): void {
    const key = selectedKey();
    if (!key) return;
    const shape = (event.currentTarget as HTMLSelectElement).value as KeyboardLabShape;
    updateKey(key.id, (item) => ({
      ...item,
      shape,
      clipPath: shape === 'custom' ? item.clipPath : shapeClip(shape),
    }));
  }

  function setCell(index: 0 | 1, event: Event): void {
    const key = selectedKey();
    if (!key) return;
    const current = key.cell ?? [0, 0];
    const value = numberFromInput(event, current[index]);
    updateKey(key.id, (item) => ({
      ...item,
      cell: index === 0 ? [value, current[1]] : [current[0], value],
    }));
  }

  async function copy(content: string, label: string): Promise<void> {
    await navigator.clipboard.writeText(content);
    announce(`${label} copied`);
  }

  function onImport(event: Event): void {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      const imported = parseKeyboardLabDocument(JSON.parse(text));
      setDocument(imported);
      setHistory([]);
      setFuture([]);
      setSelectedIds([]);
      setReferenceUrl(undefined);
      announce(`Imported ${imported.name}`);
    }).catch((error: unknown) => {
      announce(error instanceof Error ? error.message : 'Could not import layout');
    });
    (event.currentTarget as HTMLInputElement).value = '';
  }

  function onReference(event: Event): void {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(
          layout().scene.width / image.naturalWidth,
          layout().scene.height / image.naturalHeight,
        );
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        setReferenceUrl(url);
        setDocument({
          ...layout(),
          reference: {
            name: file.name,
            x: (layout().scene.width - width) / 2,
            y: (layout().scene.height - height) / 2,
            width,
            height,
            rotation: 0,
            opacity: 0.5,
          },
        });
        announce(`Loaded reference ${file.name}`);
      };
      image.src = url;
    };
    reader.readAsDataURL(file);
    (event.currentTarget as HTMLInputElement).value = '';
  }

  function setReferenceNumber(
    property: 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity',
    event: Event,
  ): void {
    const reference = layout().reference;
    if (!reference) return;
    const value = numberFromInput(event, reference[property]);
    setDocument({
      ...layout(),
      reference: { ...reference, [property]: value },
    });
  }

  function removeReference(): void {
    if (!layout().reference) return;
    const { reference: _, ...withoutReference } = layout();
    setDocument(withoutReference);
    setReferenceUrl(undefined);
    announce('Removed reference image');
  }

  onMount(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKeyDown);
    void Promise.all(keyboardLabPresetLoaders.map((loader) => loader.load()))
      .then((groups) => {
        const loaded = groups.flat();
        setPresets(loaded);
        const first = loaded.find((item) => item.id === 'toshiba-hx10') ?? loaded[0];
        if (first) {
          setLayout(cloneDocument(first));
          announce(`Loaded ${first.name}`);
        } else {
          announce('Ready');
        }
      })
      .catch((error: unknown) => {
        announce(error instanceof Error ? error.message : 'Could not load keyboard presets');
      });
  });

  onCleanup(() => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <main class="keyboard-lab">
      <header class="lab-header">
        <div>
          <div class="lab-eyebrow">ZX84 DEVELOPMENT TOOL</div>
          <h1>Keyboard Lab</h1>
        </div>
        <div class="lab-header-actions">
          <span class="lab-status" aria-live="polite">{status()}</span>
          <a class="lab-button lab-button--quiet" href="/">Back to emulator</a>
        </div>
      </header>

      <nav class="lab-toolbar" aria-label="Keyboard editing tools">
        <button class="lab-button lab-button--primary" onClick={addKey}>+ Key</button>
        <button class="lab-button" disabled={!selectedIds().length} onClick={duplicateSelection}>
          Duplicate
        </button>
        <button class="lab-button" disabled={!selectedIds().length} onClick={deleteSelection}>
          Delete
        </button>
        <span class="lab-divider" />
        <button class="lab-icon-button" title="Undo" disabled={!history().length} onClick={undo}>↶</button>
        <button class="lab-icon-button" title="Redo" disabled={!future().length} onClick={redo}>↷</button>
        <span class="lab-divider" />
        <span class="lab-tool-label">Align</span>
        <For each={[
          ['left', 'L'],
          ['center', 'C'],
          ['right', 'R'],
          ['top', 'T'],
          ['middle', 'M'],
          ['bottom', 'B'],
        ] as const}>
          {([mode, label]) => (
            <button
              class="lab-icon-button"
              title={`Align ${mode}`}
              disabled={selectedIds().length < 2}
              onClick={() => align(mode)}
            >{label}</button>
          )}
        </For>
        <button
          class="lab-icon-button"
          title="Distribute horizontally"
          disabled={selectedIds().length < 3}
          onClick={() => distribute('horizontal')}
        >⇥</button>
        <button
          class="lab-icon-button"
          title="Distribute vertically"
          disabled={selectedIds().length < 3}
          onClick={() => distribute('vertical')}
        >↕</button>
        <span class="lab-toolbar-spacer" />
        <label class="lab-inline-control">
          Grid
          <input
            type="number"
            min="0.25"
            step="0.25"
            value={grid()}
            onInput={(event) => setGrid(Math.max(0.25, numberFromInput(event, 1)))}
          />
        </label>
        <label class="lab-checkbox">
          <input type="checkbox" checked={snap()} onChange={(event) => setSnap(event.currentTarget.checked)} />
          Snap
        </label>
        <label class="lab-inline-control">
          Zoom
          <select value={zoom()} onChange={(event) => setZoom(Number(event.currentTarget.value))}>
            <option value="0.5">50%</option>
            <option value="0.55">55% pane</option>
            <option value="0.75">75%</option>
            <option value="1">100%</option>
            <option value="1.25">125%</option>
          </select>
        </label>
      </nav>

      <div class="lab-workspace">
        <aside class="lab-sidebar lab-sidebar--left">
          <section class="lab-panel">
            <h2>Keyboard</h2>
            <label class="lab-field">
              Preset
              <select value={layout().id} onChange={(event) => choosePreset(event.currentTarget.value)}>
                <For each={presets()}>{(preset) =>
                  <option value={preset.id}>{preset.name}</option>}
                </For>
                <Show when={!presets().some((preset) => preset.id === layout().id)}>
                  <option value={layout().id}>{layout().name}</option>
                </Show>
              </select>
            </label>
            <label class="lab-field">
              Name
              <input
                value={layout().name}
                onInput={(event) => setDocument({ ...layout(), name: event.currentTarget.value })}
              />
            </label>
            <div class="lab-field-grid">
              <label class="lab-field">
                Width
                <input
                  type="number"
                  min="40"
                  value={layout().scene.width}
                  onInput={(event) => setDocument({
                    ...layout(),
                    scene: { ...layout().scene, width: numberFromInput(event, layout().scene.width) },
                  })}
                />
              </label>
              <label class="lab-field">
                Height
                <input
                  type="number"
                  min="40"
                  value={layout().scene.height}
                  onInput={(event) => setDocument({
                    ...layout(),
                    scene: { ...layout().scene, height: numberFromInput(event, layout().scene.height) },
                  })}
                />
              </label>
            </div>
            <div class="lab-button-row">
              <button class="lab-button" onClick={() => importInput.click()}>Import JSON</button>
              <button
                class="lab-button"
                onClick={() => downloadText(
                  `${layout().id}.keyboard.json`,
                  documentAsJson(layout()),
                  'application/json',
                )}
              >Download</button>
            </div>
            <input ref={importInput} class="lab-hidden-input" type="file" accept=".json,application/json" onChange={onImport} />
          </section>

          <section class="lab-panel">
            <div class="lab-panel-title-row">
              <h2>Reference image</h2>
              <Show when={layout().reference}>
                <button class="lab-text-button lab-text-button--danger" onClick={removeReference}>Remove</button>
              </Show>
            </div>
            <button class="lab-drop-button" onClick={() => referenceInput.click()}>
              <span>＋</span>
              {layout().reference?.name ?? 'Choose keyboard photo'}
            </button>
            <input ref={referenceInput} class="lab-hidden-input" type="file" accept="image/*" onChange={onReference} />
            <Show when={layout().reference}>
              {(reference) => (
                <>
                  <label class="lab-field">
                    Opacity
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={reference().opacity}
                      onInput={(event) => setReferenceNumber('opacity', event)}
                    />
                  </label>
                  <div class="lab-field-grid">
                    <For each={['x', 'y', 'width', 'height', 'rotation'] as const}>
                      {(property) => (
                        <label class="lab-field">
                          {property === 'rotation' ? 'Rotate' : property.toUpperCase()}
                          <input
                            type="number"
                            value={reference()[property]}
                            onInput={(event) => setReferenceNumber(property, event)}
                          />
                        </label>
                      )}
                    </For>
                  </div>
                </>
              )}
            </Show>
          </section>

          <section class="lab-panel lab-help">
            <h2>Shortcuts</h2>
            <p><kbd>Drag</kbd> move · <kbd>Alt</kbd> ignore snap</p>
            <p><kbd>↑ ↓ ← →</kbd> nudge · <kbd>Shift</kbd> ×10</p>
            <p><kbd>Ctrl click</kbd> add/remove a key</p>
            <p><kbd>Ctrl drag</kbd> box-select keys</p>
            <p><kbd>Ctrl D</kbd> duplicate · <kbd>Del</kbd> remove</p>
          </section>
        </aside>

        <section class="lab-canvas-area" onPointerDown={() => setSelectedIds([])}>
          <div class="lab-canvas-meta">
            <span>{layout().scene.width} × {layout().scene.height}</span>
            <span>{layout().keys.length} keys</span>
            <span>{Math.round(zoom() * 100)}%</span>
          </div>
          <div
            class="lab-scene-wrap"
            style={{
              width: `${layout().scene.width * zoom()}px`,
              height: `${layout().scene.height * zoom()}px`,
            }}
          >
            <div
              class={`lab-scene lab-scene--${layout().theme ?? 'neutral'}`}
              style={{
                width: `${layout().scene.width}px`,
                height: `${layout().scene.height}px`,
                transform: `scale(${zoom()})`,
                '--lab-grid': `${grid()}px`,
              }}
              onPointerDown={startMarquee}
            >
              <Show when={layout().reference && referenceUrl()}>
                <img
                  class="lab-reference"
                  src={referenceUrl()}
                  alt=""
                  draggable={false}
                  style={{
                    left: `${layout().reference!.x}px`,
                    top: `${layout().reference!.y}px`,
                    width: `${layout().reference!.width}px`,
                    height: `${layout().reference!.height}px`,
                    opacity: layout().reference!.opacity,
                    transform: `rotate(${layout().reference!.rotation}deg)`,
                  }}
                />
              </Show>
              <For each={layout().keys}>
                {(key) => (
                  <div
                    classList={{
                      'lab-key': true,
                      [`lab-key--${key.tone ?? 'cream'}`]: true,
                      [`lab-key--shape-${key.shape}`]: !!key.shape,
                      'lab-key--selected': selectedSet().has(key.id),
                    }}
                    data-key-id={key.id}
                    style={{
                      left: `${key.box.x}px`,
                      top: `${key.box.y}px`,
                      width: `${key.box.width}px`,
                      height: `${key.box.height}px`,
                      'clip-path': key.clipPath ?? (key.shape ? shapeClip(key.shape) : undefined),
                    }}
                    onPointerDown={(event) => startMove(event, key.id)}
                  >
                    <span class="lab-key-shift">{key.legends.shift}</span>
                    <span class="lab-key-main">{key.legends.main}</span>
                    <span class="lab-key-aux">{key.legends.aux}</span>
                    <Show when={selectedIds().length === 1 && selectedSet().has(key.id)}>
                      <For each={['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const}>
                        {(edge) => (
                          <span
                            class={`lab-resize lab-resize--${edge}`}
                            onPointerDown={(event) => startResize(event, edge)}
                          />
                        )}
                      </For>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={marquee()}>
                {(selection) => (
                  <div
                    class="lab-marquee"
                    style={{
                      left: `${selection().box.x}px`,
                      top: `${selection().box.y}px`,
                      width: `${selection().box.width}px`,
                      height: `${selection().box.height}px`,
                    }}
                  />
                )}
              </Show>
            </div>
          </div>
        </section>

        <aside class="lab-sidebar lab-sidebar--right">
          <section class="lab-panel">
            <div class="lab-panel-title-row">
              <h2>Inspector</h2>
              <span class="lab-selection-count">
                {selectedIds().length ? `${selectedIds().length} selected` : 'No selection'}
              </span>
            </div>
            <Show
              when={selectedKey()}
              fallback={<p class="lab-empty">Select one key to edit its geometry, legends and wiring.</p>}
            >
              {(key) => (
                <>
                  <label class="lab-field">
                    Key ID
                    <input value={key().id} disabled />
                  </label>
                  <div class="lab-field-grid lab-field-grid--four">
                    <For each={['x', 'y', 'width', 'height'] as const}>
                      {(property) => (
                        <label class="lab-field">
                          {property === 'width' ? 'W' : property === 'height' ? 'H' : property.toUpperCase()}
                          <input
                            type="number"
                            value={key().box[property]}
                            onInput={(event) => setKeyNumber(property, event)}
                          />
                        </label>
                      )}
                    </For>
                  </div>
                  <h3>Legends</h3>
                  <label class="lab-field">
                    Main
                    <input value={key().legends.main} onInput={(event) => setLegend('main', event)} />
                  </label>
                  <div class="lab-field-grid">
                    <label class="lab-field">
                      Shift / upper
                      <input value={key().legends.shift ?? ''} onInput={(event) => setLegend('shift', event)} />
                    </label>
                    <label class="lab-field">
                      Aux / lower
                      <input value={key().legends.aux ?? ''} onInput={(event) => setLegend('aux', event)} />
                    </label>
                  </div>
                  <h3>Appearance</h3>
                  <label class="lab-field">
                    Shape
                    <select value={key().shape ?? 'rectangle'} onChange={setShape}>
                      <For each={[
                        'rectangle',
                        'return',
                        'wedge-up',
                        'wedge-down',
                        'wedge-left',
                        'wedge-right',
                        'custom',
                      ] as const}>{(shape) => <option value={shape}>{shape}</option>}</For>
                    </select>
                  </label>
                  <div class="lab-field-grid">
                    <label class="lab-field">
                      Tone
                      <input value={key().tone ?? ''} onInput={(event) => setKeyText('tone', event)} />
                    </label>
                    <label class="lab-field">
                      Region
                      <input value={key().region ?? ''} onInput={(event) => setKeyText('region', event)} />
                    </label>
                  </div>
                  <label class="lab-field">
                    CSS clip path
                    <input value={key().clipPath ?? ''} onInput={(event) => setKeyText('clipPath', event)} />
                  </label>
                  <h3>Matrix</h3>
                  <div class="lab-field-grid">
                    <label class="lab-field">
                      Row
                      <input type="number" value={key().cell?.[0] ?? ''} onInput={(event) => setCell(0, event)} />
                    </label>
                    <label class="lab-field">
                      Bit
                      <input type="number" value={key().cell?.[1] ?? ''} onInput={(event) => setCell(1, event)} />
                    </label>
                  </div>
                </>
              )}
            </Show>
          </section>

          <section class="lab-panel">
            <h2>Export</h2>
            <p class="lab-note">Nothing is written to the project until you export and apply the result.</p>
            <button
              class="lab-button lab-button--wide"
              onClick={() => void copy(documentAsJson(layout()), 'JSON')}
            >Copy layout JSON</button>
            <button
              class="lab-button lab-button--wide"
              onClick={() => void copy(documentAsTypeScript(layout()), 'TypeScript')}
            >Copy TypeScript geometry</button>
          </section>
        </aside>
      </div>
    </main>
  );
}
