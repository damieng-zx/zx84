/**
 * Modal file-selection dialog for ZIP archives containing multiple loadable files.
 * Creates its own DOM overlay — nothing in index.html needed. Styled with the
 * app's pane classes (.pane / .section-label / .btn) so it matches the UI; it's
 * a dialog, so it has no collapse twisty or drag.
 */

/** Show a modal picker for the given filenames. Resolves with the chosen name, or null if cancelled. */
export function showFilePicker(filenames: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;

    function finish(value: string | null): void {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    }

    // ── Overlay ──────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';

    // ── Panel (reuses .pane chrome) ──────────────────────────────────
    const panel = document.createElement('div');
    panel.className = 'pane dialog';

    const title = document.createElement('div');
    title.className = 'section-label dialog-title';
    title.textContent = 'Select a file to load';
    panel.appendChild(title);

    const content = document.createElement('div');
    content.className = 'dialog-content';

    // ── File list ────────────────────────────────────────────────────
    const list = document.createElement('div');
    list.className = 'dialog-list';
    const sorted = [...filenames].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    for (const name of sorted) {
      const item = document.createElement('div');
      item.className = 'dialog-item';
      item.textContent = name;
      item.addEventListener('click', () => finish(name));
      list.appendChild(item);
    }
    content.appendChild(list);

    // ── Cancel button ────────────────────────────────────────────────
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-md';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => finish(null));
    actions.appendChild(cancelBtn);
    content.appendChild(actions);

    panel.appendChild(content);
    overlay.appendChild(panel);

    // ── Dismiss via overlay click / Escape ────────────────────────────
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    }
    document.addEventListener('keydown', onKeyDown);

    // ── Cleanup ──────────────────────────────────────────────────────
    function cleanup(): void {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
    }

    document.body.appendChild(overlay);
  });
}
