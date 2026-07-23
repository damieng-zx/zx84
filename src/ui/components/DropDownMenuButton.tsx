import type { JSX } from 'solid-js';
import { createSignal, createEffect, Show, onCleanup } from 'solid-js';

export interface MenuItem {
  value: string;
  label: string;
  /** If defined (true or false), renders as a checkable toggle item. A parent
   *  (with `children`) that also sets `checked` is clickable to toggle the
   *  whole group, and still opens its flyout on hover. */
  checked?: boolean;
  /** Tri-state: some-but-not-all of a group selected → shows a dash. */
  indeterminate?: boolean;
  /** Sub-menu items — renders as a flyout on hover. */
  children?: MenuItem[];
  /** Renders a horizontal separator instead of a clickable item. */
  separator?: boolean;
  /** Renders a non-clickable section sub-heading instead of an item. */
  heading?: boolean;
  /** Locale flags shown inline on the right of this item row.
   *  Clicking a flag fires onSelect with the flag's value string. */
  flags?: { locale: string; emoji: string; value: string }[];
}

interface Props {
  icon?: JSX.Element;
  /** Text shown on the button face instead of (or alongside) the icon, with a
   *  dropdown caret — renders the button like a select box rather than an
   *  icon-only control. */
  label?: string;
  title?: string;
  items: MenuItem[];
  onSelect: (value: string) => void;
  size?: 'lg' | 'md' | 'sm';
}

export function DropDownMenuButton(props: Props) {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ top: 0, left: 0 });
  let btnRef!: HTMLButtonElement;
  let menuRef!: HTMLDivElement;

  function close() { setOpen(false); }

  // Close on click outside or Escape
  createEffect(() => {
    if (!open()) return;
    function onMouseDown(e: MouseEvent) {
      if (
        menuRef && !menuRef.contains(e.target as Node) &&
        btnRef && !btnRef.contains(e.target as Node)
      ) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    onCleanup(() => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    });
  });

  // Position the menu using fixed positioning to escape overflow:hidden parents
  createEffect(() => {
    if (!open() || !btnRef) return;
    const rect = btnRef.getBoundingClientRect();
    setPos({ top: rect.bottom + 2, left: rect.left });
  });

  function handleClick(item: MenuItem) {
    if (item.children && item.checked === undefined) return;
    props.onSelect(item.value);
    if (item.checked === undefined) close();
  }

  function handleFlagClick(value: string, e: MouseEvent) {
    e.stopPropagation();
    props.onSelect(value);
    close();
  }

  function check(item: MenuItem) {
    if (item.checked === undefined) return null;
    return (
      <span class="ddmenu-check">
        {item.indeterminate ? '\u2013' : item.checked ? '\u2713' : ''}
      </span>
    );
  }

  function renderItem(item: MenuItem) {
    if (item.separator) {
      return <div class="ddmenu-separator" />;
    }
    if (item.heading) {
      return <div class="ddmenu-heading">{item.label}</div>;
    }
    if (item.children) {
      // Parent: the row is clickable to toggle the whole group when checkable;
      // hovering anywhere on it reveals the flyout of sub-parts.
      const toggleable = item.checked !== undefined;
      return (
        <div class="ddmenu-parent">
          <div
            class="ddmenu-item ddmenu-parent-row"
            onClick={toggleable ? () => handleClick(item) : undefined}
          >
            {check(item)}
            <span>{item.label}</span>
            <span class="ddmenu-arrow">{'\u25B8'}</span>
          </div>
          <div class="ddmenu ddmenu-sub">
            {item.children.map((child) => renderItem(child))}
          </div>
        </div>
      );
    }
    return (
      <div class="ddmenu-item ddmenu-item-flags" onClick={() => handleClick(item)}>
        {check(item)}
        <span class="ddmenu-label">{item.label}</span>
        {item.flags && (
          <span class="ddmenu-flags">
            {item.flags.map(f => (
              <span class="ddmenu-flag" title={`${item.label} (${f.locale})`} onClick={e => handleFlagClick(f.value, e)}>{f.emoji}</span>
            ))}
          </span>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        ref={btnRef}
        class={`btn btn-${props.size ?? 'md'} ddmenu-btn`}
        classList={{ 'ddmenu-btn-labeled': !!props.label }}
        title={props.title}
        onClick={() => setOpen(!open())}
      >
        {props.icon}
        <Show when={props.label}>
          <span class="ddmenu-btn-label">{props.label}</span>
          <span class="ddmenu-btn-caret">{'▾'}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div
          ref={menuRef}
          class="ddmenu"
          style={{ top: `${pos().top}px`, left: `${pos().left}px` }}
        >
          {props.items.map((item) => renderItem(item))}
        </div>
      </Show>
    </>
  );
}
