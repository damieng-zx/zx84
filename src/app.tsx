/**
 * Root layout: sidebars, main screen, tooltip.
 */

import { onMount, onCleanup, createEffect, createSignal, Show, type JSX } from 'solid-js';
import { Sidebar } from '@/components/Sidebar.tsx';
import { Screen } from '@/components/Screen.tsx';
import { StatusBar } from '@/components/StatusBar.tsx';
import { Tooltip } from '@/components/Tooltip.tsx';
import { AppMenu } from '@/components/AppMenu.tsx';

import { HardwarePane } from '@/components/panes/HardwarePane.tsx';
import { LoadSavePane } from '@/components/panes/LoadSavePane.tsx';
import { JoystickPane } from '@/components/panes/JoystickPane.tsx';
import { MousePane } from '@/components/panes/MousePane.tsx';
import { SoundPane } from '@/components/panes/SoundPane.tsx';
import { DisplayPane } from '@/components/panes/DisplayPane.tsx';
import { FontPane } from '@/components/panes/FontPane.tsx';
import { SysVarPane } from '@/components/panes/SysVarPane.tsx';
import { BasicPane } from '@/components/panes/BasicPane.tsx';
import { BasicVarsPane } from '@/components/panes/BasicVarsPane.tsx';
import { BanksPane } from '@/components/panes/BanksPane.tsx';
import { DiskInfoPane } from '@/components/panes/DiskInfoPane.tsx';
import { DrivePane } from '@/components/panes/DrivePane.tsx';
import { TapePane } from '@/components/panes/TapePane.tsx';
import { DisassemblyPane } from '@/components/panes/DisassemblyPane.tsx';
import { TextPane } from '@/components/panes/TextPane.tsx';
import { ChangelogOverlay, toggleChangelog } from '@/components/panes/ChangelogPane.tsx';
import { MemoryPane } from '@/components/panes/MemoryPane.tsx';

import { paneOrder, SPECTRUM_ONLY_PANES, isDevPaneHidden } from '@/ui/panes.ts';
import { needsGamepadPolling } from '@/store/settings.ts';
import { initAudio, init, loadFile, currentModel, transcribeMode } from '@/emulator.ts';
import { isCpcModel } from '@/models.ts';
import { configuringPlayer } from '@/components/panes/JoystickPane.tsx';
import { InputController } from '@/input-controller.ts';

// ── Pane registry ───────────────────────────────────────────────────────

const PANE_COMPONENTS: Record<string, () => JSX.Element> = {
  'hardware-panel': HardwarePane,
  'snapshot-panel': LoadSavePane,
  'joystick-panel': JoystickPane,
  'mouse-panel': MousePane,
  'sound-panel': SoundPane,
  'display-pane': DisplayPane,
  'font-panel': FontPane,
  'sysvar-panel': SysVarPane,
  'basic-panel': BasicPane,
  'basic-vars-panel': BasicVarsPane,
  'banks-panel': BanksPane,
  'disk-info-panel': DiskInfoPane,
  'drive-panel': DrivePane,
  'tape-panel': TapePane,
  'text-panel': TextPane,
  'disasm-panel': DisassemblyPane,
  'memory-panel': MemoryPane,
};

function renderPanes(side: 'left' | 'right') {
  return () => {
    const order = paneOrder();
    const cpc = isCpcModel(currentModel());
    const textMode = transcribeMode() !== 'off';
    return order
      .filter(p => p.sidebar === side)
      .filter(p => !isDevPaneHidden(p.id))
      .filter(p => !(cpc && SPECTRUM_ONLY_PANES.has(p.id)))
      .filter(p => p.id !== 'text-panel' || textMode)
      .map(p => {
        const Component = PANE_COMPONENTS[p.id];
        return Component ? <Component /> : null;
      });
  };
}

// ── Input Controller ────────────────────────────────────────────────────

const inputController = new InputController();

export function App() {
  const leftPanes = renderPanes('left');
  const rightPanes = renderPanes('right');
  const [isDragging, setIsDragging] = createSignal(false);

  // Register global keyboard/audio/drag-drop handlers
  onMount(() => {
    document.addEventListener('keydown', inputController.onKeyDown);
    document.addEventListener('keyup', inputController.onKeyUp);
    window.addEventListener('blur', inputController.onBlur);
    document.addEventListener('click', initAudio, { once: true });

    // Depth counter avoids flicker when pointer moves between child elements
    let dragDepth = 0;

    function onDragEnter(e: DragEvent) {
      if (!e.dataTransfer?.types.includes('Files')) return;
      dragDepth++;
      setIsDragging(true);
    }
    function onDragLeave() {
      if (--dragDepth <= 0) {
        dragDepth = 0;
        setIsDragging(false);
      }
    }
    function onDragOver(e: DragEvent) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }
    function onDrop(e: DragEvent) {
      e.preventDefault();
      dragDepth = 0;
      setIsDragging(false);
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      file.arrayBuffer().then(buf => loadFile(new Uint8Array(buf), file.name));
    }
    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);

    onCleanup(() => {
      document.removeEventListener('keydown', inputController.onKeyDown);
      document.removeEventListener('keyup', inputController.onKeyUp);
      window.removeEventListener('blur', inputController.onBlur);
      document.removeEventListener('click', initAudio);
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    });
  });

  // Gamepad polling loop — auto-tracks needsGamepadPolling() and configuringPlayer()
  createEffect(() => {
    if (!needsGamepadPolling() && configuringPlayer() < 0) return;
    let rafId = 0;
    function loop() {
      inputController.pollGamepads();
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);
    onCleanup(() => {
      cancelAnimationFrame(rafId);
      inputController.reset();
    });
  });

  // Mark the document in Amstrad mode so CPC-specific styling (e.g. hiding the
  // Spectrum rainbow stripe on pane title bars) can key off it.
  createEffect(() => {
    document.body.classList.toggle('cpc-mode', isCpcModel(currentModel()));
  });

  // Init emulator on mount
  onMount(() => { init(); });

  return (
    <>
      <Sidebar id="sidebar" side="left" extra={
        <div id="toolbar">
          <h1>
            <span class="logo-stripe" />
            <span class="logo">ZX<span class="logo-num">84</span><sup class="logo-version" onClick={(e) => { e.stopPropagation(); toggleChangelog(); }}>v{__APP_VERSION__}</sup><AppMenu /></span>
            <span class="logo-stripe" />
          </h1>
          <ChangelogOverlay />
        </div>
      }>
        {leftPanes()}
      </Sidebar>

      <div id="main">
        <Screen />
        <StatusBar />
        <div id="diag"><div id="diag-header" /></div>
      </div>

      <Sidebar id="right-sidebar" side="right">
        {rightPanes()}
      </Sidebar>

      <Tooltip />

      <Show when={isDragging()}>
        <div class="drag-overlay">
          <div class="drag-overlay-box">
            <span class="drag-overlay-icon">⬇</span>
            <span class="drag-overlay-label">Drop to load</span>
            <span class="drag-overlay-hint">SNA · Z80 · SZX · TAP · TZX · DSK · ZIP</span>
          </div>
        </div>
      </Show>
    </>
  );
}
