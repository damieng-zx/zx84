import { onMount, onCleanup, For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { HiOutlineFolderOpen, HiOutlineArrowDownTray, HiOutlineRectangleStack } from 'solid-icons/hi';
import { loadFile, loadableExtensions, saveMenuItems } from '@/shell/media.ts';
import { machineCaps, machineKind } from '@/state/machine-caps.ts';
import { toggleLibrary, libraryVisible } from '@/ui/panes.ts';
import { machineUi } from '@/ui/machine-ui.ts';
import { openFile } from '@/ui/file-picker.ts';

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
    await loadFile(results[0].data, results[0].name, undefined, { autoBoot: true });
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
          <For each={saveMenuItems()}>
            {(item) => (
              <div class="save-menu-item" onClick={handleSave(item.run)}>
                {item.label}
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
