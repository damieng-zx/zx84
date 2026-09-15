/** Coalesce overlay updates until the selected font and browser layout are ready. */
export function createOverlayLayout() {
  let generation = 0;
  let frame = 0;
  let font = '';
  let ready = false;
  let pending: { element: HTMLPreElement; width: number; height: number } | null = null;

  function schedule(): void {
    if (!ready || !pending || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!pending) return;
      const { element, width, height } = pending;
      element.style.transform = 'none';
      const naturalWidth = element.scrollWidth;
      const naturalHeight = element.scrollHeight;
      if (!naturalWidth || !naturalHeight) return;
      element.style.transform = 'scale(' + width / naturalWidth + ',' + height / naturalHeight + ')';
      element.style.visibility = '';
    });
  }

  return {
    update(element: HTMLPreElement, nextFont: string, width: number, height: number): void {
      pending = { element, width, height };
      if (nextFont !== font) {
        font = nextFont;
        ready = false;
        element.style.visibility = 'hidden';
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        const token = ++generation;
        const loaded = () => {
          if (token !== generation) return;
          ready = true;
          schedule();
        };
        // A frame alone does not guarantee a web font is loaded. On failure,
        // measure the fallback font so the overlay remains usable offline.
        document.fonts.load(font).then(loaded, loaded);
      }
      schedule();
    },
    cancel(): void {
      ++generation;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pending = null;
      font = '';
      ready = false;
    },
  };
}
