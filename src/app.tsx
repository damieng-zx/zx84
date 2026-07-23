/**
 * Root layout: sidebars, main screen, tooltip.
 */

import { onMount, onCleanup, createEffect, createSignal, Show, type JSX } from 'solid-js';
import { Sidebar } from '@/ui/components/Sidebar.tsx';
import { Screen } from '@/ui/components/Screen.tsx';
import { StatusBar } from '@/ui/components/StatusBar.tsx';
import { Tooltip } from '@/ui/components/Tooltip.tsx';
import { AppMenu } from '@/ui/components/AppMenu.tsx';

import { HardwarePane } from '@/ui/panes/HardwarePane.tsx';
import { LoadSavePane } from '@/ui/panes/LoadSavePane.tsx';
import { RomPane } from '@/ui/panes/RomPane.tsx';
import { JoystickPane } from '@/ui/panes/JoystickPane.tsx';
import { MousePane } from '@/ui/panes/MousePane.tsx';
import { SoundPane } from '@/ui/panes/SoundPane.tsx';
import { DisplayPane } from '@/ui/panes/DisplayPane.tsx';
import { MonitorPane } from '@/ui/panes/MonitorPane.tsx';
import { FontPane } from '@/ui/panes/FontPane.tsx';
import { SysVarPane } from '@/ui/panes/SysVarPane.tsx';
import { BasicPane } from '@/ui/panes/BasicPane.tsx';
import { BasicVarsPane } from '@/ui/panes/BasicVarsPane.tsx';
import { BanksPane } from '@/ui/panes/BanksPane.tsx';
import { DrivePane } from '@/ui/panes/DrivePane.tsx';
import { MicrodrivePane } from '@/ui/panes/MicrodrivePane.tsx';
import { TapePane } from '@/ui/panes/TapePane.tsx';
import { DisassemblyPane } from '@/ui/panes/DisassemblyPane.tsx';
import { TextPane } from '@/ui/panes/TextPane.tsx';
import { ChangelogOverlay, toggleChangelog } from '@/ui/panes/ChangelogPane.tsx';
import { MemoryPane } from '@/ui/panes/MemoryPane.tsx';

import { machineUi } from '@/ui/machine-ui.ts';
import { machineCaps, machineKind } from '@/state/machine-caps.ts';
import { paneOrder, isPaneUserHidden } from '@/ui/panes.ts';
import { needsGamepadPolling, scale } from '@/store/settings.ts';
import { initAudio, init, syncFocusPause } from '@/shell/lifecycle.ts';
import { loadFile } from '@/shell/media.ts';
import { loadStartupMedia } from '@/shell/url-media.ts';
import { transcribeMode } from '@/state/activity-state.ts';
import { configuringPlayer } from '@/ui/panes/JoystickPane.tsx';
import { InputController } from '@/input-controller.ts';

// ── Pane registry ───────────────────────────────────────────────────────

const PANE_COMPONENTS: Record<string, () => JSX.Element> = {
  'hardware-panel': HardwarePane,
  'snapshot-panel': LoadSavePane,
  'rom-panel': RomPane,
  'joystick-panel': JoystickPane,
  'mouse-panel': MousePane,
  'sound-panel': SoundPane,
  'display-pane': DisplayPane,
  'monitor-pane': MonitorPane,
  'font-panel': FontPane,
  'sysvar-panel': SysVarPane,
  'basic-panel': BasicPane,
  'basic-vars-panel': BasicVarsPane,
  'banks-panel': BanksPane,
  'drive-panel': DrivePane,
  'microdrive-panel': MicrodrivePane,
  'tape-panel': TapePane,
  'text-panel': TextPane,
  'disasm-panel': DisassemblyPane,
  'memory-panel': MemoryPane,
};

function renderPanes(side: 'left' | 'right') {
  return () => {
    const order = paneOrder();
    const hidden = machineCaps().hiddenPanes;
    const textMode = transcribeMode() !== 'off';
    return order
      .filter(p => p.sidebar === side)
      .filter(p => !isPaneUserHidden(p.id))
      .filter(p => !hidden.includes(p.id))
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

    // Auto-pause emulation when the tab is hidden or the window loses focus.
    // A single handler covers both "tab hidden" (visibilitychange) and "window
    // blurred" (blur/focus); syncFocusPause() reads the combined active state.
    window.addEventListener('focus', syncFocusPause);
    window.addEventListener('blur', syncFocusPause);
    document.addEventListener('visibilitychange', syncFocusPause);

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
      window.removeEventListener('focus', syncFocusPause);
      window.removeEventListener('blur', syncFocusPause);
      document.removeEventListener('visibilitychange', syncFocusPause);
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

  // Mark the document with the active platform so platform-specific styling
  // (e.g. hiding the Spectrum rainbow stripe on pane title bars for non-
  // Spectrum machines) can key off it.
  createEffect(() => {
    const kind = machineKind();
    document.body.classList.toggle('cpc-mode', kind === 'cpc');
    document.body.classList.toggle('einstein-mode', kind === 'einstein');
    document.body.classList.toggle('msx-mode', kind === 'msx');
  });

  // Mirror the display scale (1×/2×/3×) into a CSS variable so the on-screen
  // keyboards size their key unit from the same mode as the screen canvas,
  // shrinking proportionally instead of breaking at narrower widths.
  createEffect(() => {
    document.documentElement.style.setProperty('--display-scale', String(scale()));
  });

  // Init emulator on mount
  onMount(() => {
    void init().then(() => loadStartupMedia(window.location.search));
  });

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
        {/* The on-screen keyboard is a per-machine UI contribution (only the
            Spectrum supplies one); machines without one show no keyboard. */}
        <Show when={!isPaneUserHidden('keyboard-panel') && machineUi(machineKind()).Keyboard} keyed>
          {(Keyboard) => <Keyboard />}
        </Show>
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
            <span class="drag-overlay-hint">SNA · Z80 · SZX · TAP · TZX · DSK · HFE · MDR · ZIP</span>
          </div>
        </div>
      </Show>
    </>
  );
}
