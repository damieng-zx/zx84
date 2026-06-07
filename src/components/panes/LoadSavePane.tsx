import { onMount, onCleanup, Show } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { HiOutlineFolderOpen, HiOutlineArrowDownTray } from 'solid-icons/hi';
import {
  loadFile, saveSnapshot, saveCpcSnapshot, saveScreenshot, saveRAM, currentModel,
} from '@/emulator.ts';
import { isCpcModel } from '@/models.ts';
import { openFile } from '@/ui/file-picker.ts';

const isCpc = () => isCpcModel(currentModel());

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
      extensions: ['.sna', '.z80', '.szx', '.sp', '.tap', '.tzx', '.dsk', '.zip'],
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
          <Show
            when={isCpc()}
            fallback={<>
              <div class="save-menu-item" onClick={handleSave(() => saveSnapshot('szx'))}>Snapshot (.szx)</div>
              <div class="save-menu-item" onClick={handleSave(() => saveSnapshot('z80'))}>Snapshot (.z80)</div>
              <div class="save-menu-item" onClick={handleSave(() => saveScreenshot('png'))}>Screenshot (.png)</div>
              <div class="save-menu-item" onClick={handleSave(() => saveScreenshot('scr'))}>Screen (.scr)</div>
              <div class="save-menu-item" onClick={handleSave(saveRAM)}>RAM (.bin)</div>
            </>}
          >
            <div class="save-menu-item" onClick={handleSave(() => saveCpcSnapshot(2))}>Snapshot v2 (.sna)</div>
            <div class="save-menu-item" onClick={handleSave(() => saveCpcSnapshot(3))}>Snapshot v3 (.sna)</div>
            <div class="save-menu-item" onClick={handleSave(() => saveScreenshot('png'))}>Screenshot (.png)</div>
          </Show>
        </div>
      </div>
    </Pane>
  );
}
