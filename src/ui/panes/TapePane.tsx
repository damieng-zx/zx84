import { createEffect, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { DropDownMenuButton } from '@/ui/components/DropDownMenuButton.tsx';
import { HiOutlineBackward, HiOutlinePlay, HiOutlinePause, HiOutlineStop, HiOutlineEllipsisVertical, HiOutlineChevronLeft, HiOutlineChevronRight, HiOutlineArrowDownTray } from 'solid-icons/hi';
import {
  tapeRewind, tapeTogglePlay, tapeTogglePause, tapeSetPosition, toggleAutoRewind,
  ejectTape, loadFile, tapePrev, tapeNext, saveTape,
} from '@/shell/media.ts';
import { applyDisplaySettings } from '@/shell/settings.ts';
import {
  tapeLoaded, tapeName, tapeBlocks, tapePosition, tapePlaying, tapePaused, casBlocks, casPosition,
} from '@/state/tape-state.ts';
import { machineCaps } from '@/state/machine-caps.ts';
import { tapeAutoRewind, tapeCollapseBlocks, setTapeCollapseBlocks, tapeFastRom, setTapeFastRom, tapeTurbo, setTapeTurbo, tapeSoundEnabled, setTapeSoundEnabled } from '@/store/settings.ts';
import { persistSetting, resetSettingsGroup } from '@/store/settings.ts';
import { parseTapeBlockMeta } from '@/ui/panes/tape-block-meta.ts';
import { openFile } from '@/ui/file-picker.ts';

// Logical cassettes are instant-load (ROM/BIOS trap), with a simple block list.
// They do not expose pulse timings or a real-time transport.
const isInstantTape = () => machineCaps().tape === 'instant';

export function TapePane() {
  let containerRef!: HTMLDivElement;

  async function handleLoadTape() {
    const results = await openFile({
      id: 'zx84-tape',
      extensions: [...machineCaps().tapeExtensions],
    });
    if (!results) return;
    await loadFile(results[0].data, results[0].name);
  }

  // Auto-scroll the current block into view *within the tape pane only*. Using
  // element.scrollIntoView() would also scroll every scrollable ancestor — incl.
  // the page itself — to bring the block on-screen, yanking the whole layout
  // down. Adjust just the container's own scrollTop instead ('nearest' style:
  // move only when the block sits outside the visible band).
  createEffect(() => {
    tapePosition(); // track
    if (!containerRef) return;
    const current = containerRef.querySelector('.tape-block.current') as HTMLElement;
    if (!current) return;
    const c = containerRef.getBoundingClientRect();
    const e = current.getBoundingClientRect();
    if (e.top < c.top) containerRef.scrollTop -= c.top - e.top;
    else if (e.bottom > c.bottom) containerRef.scrollTop += e.bottom - c.bottom;
  });

  return (
    <Pane id="tape-panel" label="Tape" mono onResetSettings={() => { if (tapeLoaded()) ejectTape(); resetSettingsGroup('tape'); applyDisplaySettings(); }}>
      <div id="tape-controls">
        <button class="btn btn-md" title="Rewind" onClick={tapeRewind}><HiOutlineBackward /></button>
        <button class="btn btn-md" title="Previous block" onClick={tapePrev}><HiOutlineChevronLeft /></button>
        <button
          title={tapePlaying() ? 'Stop' : 'Play'}
          class={`btn btn-md${tapePlaying() ? ' active' : ''}`}
          onClick={tapeTogglePlay}
        >{tapePlaying() ? <HiOutlineStop /> : <HiOutlinePlay />}</button>
        <button
          title="Pause"
          class={`btn btn-md${tapePaused() ? ' active' : ''}`}
          onClick={tapeTogglePause}
        ><HiOutlinePause /></button>
        <button class="btn btn-md" title="Next block" onClick={tapeNext}><HiOutlineChevronRight /></button>
        <button class="btn btn-md" title="Download tape" disabled={!tapeLoaded()} onClick={() => saveTape()}><HiOutlineArrowDownTray /></button>
        <DropDownMenuButton
          icon={<HiOutlineEllipsisVertical />}
          title="Tape options"
          items={[
            // Loading sounds aren't wired for the CPC (its cassette is AY-silent).
            ...(machineCaps().tapeSound ? [{ value: 'tape-sound', label: 'Loading sounds', checked: tapeSoundEnabled() }] : []),
            { value: 'auto-rewind', label: 'Auto-rewind', checked: tapeAutoRewind() },
            { value: 'collapse-blocks', label: 'Combine paired blocks', checked: tapeCollapseBlocks() },
            { value: '__sep1', label: '', separator: true },
            // Only machines that actually trap their ROM's tape-read routine
            // offer fast loading; the toggle would be dead elsewhere.
            ...(machineCaps().fastRomLoading ? [{ value: 'fast-rom', label: 'Fast ROM loading', checked: tapeFastRom() }] : []),
            { value: 'turbo', label: 'Turbo while loading', checked: tapeTurbo() },
          ]}
          onSelect={(value) => {
            if (value === 'fast-rom') {
              setTapeFastRom(!tapeFastRom());
              persistSetting('tape-instant-rom', tapeFastRom() ? 'on' : 'off');
              applyDisplaySettings();
            } else if (value === 'turbo') {
              setTapeTurbo(!tapeTurbo());
              persistSetting('tape-turbo-load', tapeTurbo() ? 'on' : 'off');
              applyDisplaySettings();
            } else if (value === 'tape-sound') {
              setTapeSoundEnabled(!tapeSoundEnabled());
              persistSetting('tape-sound', tapeSoundEnabled() ? 'on' : 'off');
            } else if (value === 'auto-rewind') {
              toggleAutoRewind();
            } else if (value === 'collapse-blocks') {
              setTapeCollapseBlocks(!tapeCollapseBlocks());
              persistSetting('tape-collapse-blocks', tapeCollapseBlocks() ? 'on' : 'off');
            }
          }}
        />
      </div>
      <div
        id="tape-name"
        classList={{ 'tape-name-clickable': !tapeLoaded() }}
        onClick={() => !tapeLoaded() && handleLoadTape()}
      >
        <span class="tape-name-text" title={tapeLoaded() ? tapeName() : ''}>
          {tapeLoaded() ? tapeName() : 'No tape inserted'}
        </span>
        <Show when={tapeLoaded()}>
          <button class="tape-eject" title="Eject tape" onClick={(e) => { e.stopPropagation(); ejectTape(); }}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
              <path d="M8 2L2 10h12L8 2zM2 12v2h12v-2H2z"/>
            </svg>
          </button>
        </Show>
      </div>
      <Show when={tapeLoaded() && isInstantTape()}>
        <div id="tape-blocks" class="mono-block">
          {casBlocks().map((b, i) => {
            const blocks = casBlocks();
            const collapse = tapeCollapseBlocks();
            const isHeader = b.kind === 'header';
            // Collapsed: a data block following a header is absorbed into it.
            if (collapse && !isHeader && i > 0 && blocks[i - 1].kind === 'header') return null;
            const next = blocks[i + 1];
            const paired = collapse && isHeader && next && next.kind !== 'header';
            // A collapsed header spans [i, i+1] for the current/played indicators.
            const lastIndex = paired ? i + 1 : i;
            const pos = casPosition();
            const isCurrent = pos >= i && pos <= lastIndex;
            const isPlayed = lastIndex < pos;
            const title = paired ? `${b.type} "${b.name}"` : b.label;
            const detail = paired ? `${b.type} · ${next.size} bytes` : b.detail;
            return (
              <div class={`tape-block${isPlayed ? ' played' : ''}${isCurrent ? ' current' : ''}`}>
                {title}
                <Show when={detail}><div class="tb-detail">{detail}</div></Show>
              </div>
            );
          })}
        </div>
      </Show>
      <Show when={tapeLoaded() && !isInstantTape()}>
        <div id="tape-blocks" class="mono-block" ref={containerRef}>
          {tapeBlocks().map((block, i) => {
            const meta = parseTapeBlockMeta(block, i, tapeBlocks(), tapeCollapseBlocks());
            if (meta.hidden) return null;
            // A collapsed header absorbs the hidden data child at i+1, so it spans
            // [i, i+1] for the purpose of the played/current (loading) indicators.
            const lastIndex = meta.absorbsNext ? i + 1 : i;
            const isCurrent = tapePosition() >= i && tapePosition() <= lastIndex;
            const isPlayed = lastIndex < tapePosition();
            const className = `tape-block${isPlayed ? ' played' : ''}${isCurrent ? ' current' : ''}${meta.control ? ' control' : ''}`;
            const displayLine = (tapeCollapseBlocks() && meta.line.startsWith(`${i}: `))
              ? meta.line.slice(`${i}: `.length)
              : meta.line;
            return (
              <div class={className} onClick={() => tapeSetPosition(i)}>
                {displayLine}
                {meta.detail && meta.detail.split('\n').map((line) => (
                  <div class="tb-detail">{line}</div>
                ))}
              </div>
            );
          })}
        </div>
      </Show>
    </Pane>
  );
}
