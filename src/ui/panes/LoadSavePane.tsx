import { onMount, onCleanup, For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { HiOutlineFolderOpen, HiOutlineArrowDownTray, HiOutlineRectangleStack } from 'solid-icons/hi';
import {
  loadFile, loadableExtensions, saveSnapshot, saveCpcSnapshot, saveScreenshot,
  saveRAM,
} from '@/shell/media.ts';
import type { SaveMenuItem } from '@/machines/machine.ts';
import { machineCaps, machineKind } from '@/state/machine-caps.ts';
import { toggleLibrary, libraryVisible } from '@/ui/panes.ts';
import { machineUi } from '@/ui/machine-ui.ts';
import { openFile } from '@/ui/file-picker.ts';

/** Label + action for each Save-menu entry a descriptor can name. */
const SAVE_ITEMS: Record<SaveMenuItem, { label: string; run: () => void }> = {
  'snapshot-szx': { label: 'Snapshot (.szx)', run: () => { void saveSnapshot('szx'); } },
  'snapshot-z80': { label: 'Snapshot (.z80)', run: () => { void saveSnapshot('z80'); } },
  'snapshot-sna-v2': { label: 'Snapshot v2 (.sna)', run: () => saveCpcSnapshot(2) },
  'snapshot-sna-v3': { label: 'Snapshot v3 (.sna)', run: () => saveCpcSnapshot(3) },
  'screenshot-png': { label: 'Screenshot (.png)', run: () => saveScreenshot('png') },
  'screen-scr': { label: 'Screen (.scr)', run: () => saveScreenshot('scr') },
  'ram-bin': { label: 'RAM (.bin)', run: () => saveRAM() },
};

const saveMenu = () => machineCaps().saveMenu;
const hasLibrary = () => machineCaps().library;

export function LoadSavePane() {
  let menuRef!: HTMLDivElement;
  let saveButtonRef!: HTMLButtonElement;

  onMount(() => {
    function close(e: MouseEvent) {
      if (menuRef && !menuRef.contains(e.target as Node) &&
          !saveButtonRef?.contains(e.target as Node)) {
        menuRef.style.display = 'none';
      }
    }
    document.addEventListener('click', close);
    onCleanup(() => document.removeEventListener('click', close));
  });

  function toggleMenu(e: MouseEvent) {
    e.stopPropagation();
    const menu = menuRef;
    const button = saveButtonRef;
    if (!menu || !button) return;

    if (menu.style.display === 'block') {
      menu.style.display = 'none';
    } else {
      const rect = button.getBoundingClientRect();
      const parent = button.offsetParent as HTMLElement;
      const parentRect = parent?.getBoundingClientRect();

      menu.style.left = `${rect.left - (parentRect?.left || 0)}px`;
      menu.style.top = `${rect.bottom - (parentRect?.top || 0)}px`;
      menu.style.display = 'block';
    }
  }

  function handleSave(action: () => void) {
    return () => {
      if (menuRef) menuRef.style.display = 'none';
      action();
    };
  }

  async function handleLoad() {
    const results = await openFile({
      id: 'zx84-snapshot',
      extensions: loadableExtensions(),
    });
    if (!results) return;
    await loadFile(results[0].data, results[0].name);
  }

  return (
    <Pane id="snapshot-panel" label="Load / Save">
      <div id="snap-row">
        <button class="btn btn-md" id="snap-load-btn" title="Load file" onClick={handleLoad}>
          <HiOutlineFolderOpen /> Load
        </button>
        <Show when={hasLibrary()}>
          <button
            class="btn btn-md"
            id="snap-library-btn"
            classList={{ active: libraryVisible() }}
            title="Show/hide the software library"
            onClick={toggleLibrary}
          >
            <HiOutlineRectangleStack /> Library
          </button>
        </Show>
        <button
          ref={saveButtonRef}
          class="btn btn-md"
          id="snap-save-btn"
          title="Save..."
          onClick={toggleMenu}
        >
          <HiOutlineArrowDownTray /> Save
        </button>
        <div ref={menuRef} class="save-menu" style="display:none">
          <For each={saveMenu()}>
            {(item) => (
              <div class="save-menu-item" onClick={handleSave(SAVE_ITEMS[item].run)}>
                {SAVE_ITEMS[item].label}
              </div>
            )}
          </For>
        </div>
      </div>
      <Show when={libraryVisible() && hasLibrary() && machineUi(machineKind()).LibraryBrowser} keyed>
        {(LibraryBrowser) => <LibraryBrowser />}
      </Show>
    </Pane>
  );
}
