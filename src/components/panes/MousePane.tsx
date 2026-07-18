import { createSignal, onCleanup, Show } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { setMouseMode, updateMousePosition, setMouseButton, type MouseMode } from '@/shell/media.ts';
import { machineCaps } from '@/state/machine-caps.ts';

export function MousePane() {
  const [captured, setCaptured] = createSignal<MouseMode>(null);
  const [hint, setHint] = createSignal('');
  let activeMode: MouseMode = null;

  function onMouseMove(e: MouseEvent) {
    if (!activeMode) return;
    const dy = activeMode === 'kempston' ? -e.movementY : e.movementY;
    updateMousePosition(e.movementX, dy, activeMode);
  }

  function onMouseDown(e: MouseEvent) {
    if (activeMode) setMouseButton(e.button, true, activeMode);
  }

  function onMouseUp(e: MouseEvent) {
    if (activeMode) setMouseButton(e.button, false, activeMode);
  }

  function activate(mode: MouseMode) {
    activeMode = mode;
    setCaptured(mode);
    setMouseMode(mode);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
  }

  function deactivate() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mouseup', onMouseUp);
    activeMode = null;
    setMouseMode(null);
    setCaptured(null);
  }

  function onPointerLockChange() {
    if (!document.pointerLockElement) deactivate();
  }

  document.addEventListener('pointerlockchange', onPointerLockChange);
  onCleanup(() => {
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    deactivate();
  });

  function capture(mode: MouseMode) {
    const canvas = document.getElementById('screen') as HTMLCanvasElement | null;
    if (!canvas) return;
    const result = canvas.requestPointerLock() as unknown as Promise<void> | void;
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).then(() => { setHint(''); activate(mode); }).catch(() => {
        setHint('Click again — browser needs a moment after ESC');
      });
    } else {
      // Fallback for browsers where requestPointerLock doesn't return a promise
      activate(mode);
    }
  }

  return (
    <Pane id="mouse-panel" label="Mouse" visible={machineCaps().mouse}>
      <div class="mouse-pane">
        <Show
          when={captured()}
          fallback={<>
            <div class="mouse-controls">
              <button class="mouse-capture-btn" onClick={() => capture('kempston')}>
                Kempston
              </button>
              <button class="mouse-capture-btn" onClick={() => capture('amx')}>
                AMX
              </button>
            </div>
            <Show when={hint()}>
              <div class="mouse-hint">{hint()}</div>
            </Show>
          </>}
        >
          <div class="mouse-captured">
            {captured() === 'kempston' ? 'Kempston' : 'AMX'} mouse captured<br />
            press <b>ESC</b> to release
          </div>
        </Show>
      </div>
    </Pane>
  );
}
