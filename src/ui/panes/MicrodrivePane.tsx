/**
 * ZX Interface 1 microdrive pane. Mirrors the Drives pane (DrivePane / DiskInfo)
 * layout so the controls look and behave like the disk drives: a header with a
 * "new blank cartridge" menu, a save button and an options menu (write protect),
 * then a slot whose empty name is click-to-insert with an eject button and LED.
 *
 * Drives 1-2 are shown by default with 3-8 behind an expander, since most
 * software only uses the first one or two. Cartridges load through the shared
 * loadFile() path (.mdr/.mdv), so drag-drop and the global Load picker work too.
 */

import { createEffect, Show, For } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { DropDownMenuButton, type MenuItem } from '@/ui/components/DropDownMenuButton.tsx';
import { HiOutlineEllipsisVertical, HiOutlineDocumentPlus, HiOutlineArrowDownTray } from 'solid-icons/hi';
import {
  loadFile,
  ejectMicrodrive, insertBlankMicrodrive, saveMicrodrive, setMicrodriveWriteProtect,
} from '@/shell/media.ts';
import { currentModel } from '@/state/machine-state.ts';
import {
  microdriveSlots, microdriveMotors, microdriveCount, setMicrodriveCount,
  microdriveCurrentSectors,
} from '@/state/microdrive-state.ts';
import { isInterface1Capable } from '@/models.ts';
import { interface1Enabled } from '@/store/settings.ts';
import { openFile } from '@/ui/file-picker.ts';

const NEW_ITEMS = [{ value: 'blank', label: 'Blank cartridge' }];

function blockLine(block: { type: string; name: string; bytes: number; loadAddress: number | null; autorunLine: number | null }): string {
  if (block.type === 'Program') return `PROGRAM "${block.name}"${block.autorunLine !== null ? ` LINE ${block.autorunLine}` : ''}`;
  if (block.type === 'Bytes') return `CODE "${block.name}" ${block.loadAddress ?? 0},${block.bytes}`;
  if (block.type === 'Number array') return `NUMERIC ARRAY "${block.name}" ${block.bytes}`;
  if (block.type === 'Character array') return `CHARACTER ARRAY "${block.name}" ${block.bytes}`;
  return `DATA "${block.name}" ${block.bytes}`;
}

function MicrodriveSlot(props: { unit: number }) {
  let blocksRef!: HTMLDivElement;
  const slot = () => microdriveSlots()[props.unit];
  const motorOn = () => microdriveMotors()[props.unit];
  const currentSector = () => microdriveCurrentSectors()[props.unit];
  const label = () => `${props.unit + 1}:`;

  createEffect(() => {
    currentSector(); // track
    if (!blocksRef) return;
    const current = blocksRef.querySelector('.microdrive-block.current') as HTMLElement;
    if (!current) return;
    const container = blocksRef.getBoundingClientRect();
    const element = current.getBoundingClientRect();
    if (element.top < container.top) blocksRef.scrollTop -= container.top - element.top;
    else if (element.bottom > container.bottom) blocksRef.scrollTop += element.bottom - container.bottom;
  });

  async function insert() {
    const results = await openFile({ id: 'zx84-microdrive', extensions: ['.mdr', '.mdv', '.zip'] });
    if (!results) return;
    await loadFile(results[0].data, results[0].name, props.unit);
  }

  // Drive 1's options menu also carries the "Drive count" sub-menu (1-8).
  function optionItems(): MenuItem[] {
    const items: MenuItem[] = [{ value: 'wp', label: 'Write protect', checked: slot()?.writeProtected }];
    if (props.unit === 0) {
      items.push(
        { value: '__sep', label: '', separator: true },
        {
          value: 'count', label: 'Drive count',
          children: Array.from({ length: 8 }, (_, i) => ({
            value: `count-${i + 1}`, label: String(i + 1), checked: microdriveCount() === i + 1,
          })),
        },
      );
    }
    return items;
  }

  return (
    <div class="disk-section">
      <div class="drive-header">
        <span class="disk-label">{label()}</span>
        <span
          class="drive-led"
          title={motorOn() ? 'motor on' : (slot()?.loaded ? 'idle' : 'empty')}
          style={{ background: motorOn() ? '#2266ee' : '#111' }}
        />
        <span class="drive-track-info" />
        <DropDownMenuButton
          icon={<HiOutlineDocumentPlus />}
          title={`New cartridge in microdrive ${props.unit + 1}`}
          size="sm"
          items={NEW_ITEMS}
          onSelect={() => insertBlankMicrodrive(props.unit)}
        />
        <button
          class="btn btn-sm ddmenu-btn"
          title={`Save microdrive ${props.unit + 1}`}
          disabled={!slot()?.loaded}
          onClick={() => saveMicrodrive(props.unit)}
        >
          <HiOutlineArrowDownTray />
        </button>
        <DropDownMenuButton
          icon={<HiOutlineEllipsisVertical />}
          title={`Microdrive ${props.unit + 1} options`}
          size="sm"
          items={optionItems()}
          onSelect={(value) => {
            if (value === 'wp') setMicrodriveWriteProtect(props.unit, !slot()?.writeProtected);
            else if (value.startsWith('count-')) setMicrodriveCount(parseInt(value.slice(6), 10));
          }}
        />
      </div>
      <div class="disk-slot">
        <div
          class="disk-name"
          classList={{ 'disk-name-clickable': !slot()?.loaded }}
          onClick={() => !slot()?.loaded && insert()}
        >
          <span class="disk-name-text" title={slot()?.name || ''}>
            {slot()?.loaded ? slot()!.name : 'No cartridge inserted'}
          </span>
          <Show when={slot()?.loaded}>
            <button class="tape-eject" title={`Eject cartridge ${props.unit + 1}`} onClick={(e) => { e.stopPropagation(); ejectMicrodrive(props.unit); }}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                <path d="M8 2L2 10h12L8 2zM2 12v2h12v-2H2z"/>
              </svg>
            </button>
          </Show>
        </div>
      </div>
      <Show when={slot()?.loaded}>
        <div class="microdrive-blocks mono-block" ref={blocksRef}>
          <For each={slot()?.blocks} fallback={<div class="tape-empty">No files on this cartridge.</div>}>
            {(block) => (
              <div class={`tape-block microdrive-block${block.sectors.includes(currentSector()) ? ' current' : ''}`}>
                {blockLine(block)}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function MicrodrivePane() {
  const active = () => interface1Enabled() && isInterface1Capable(currentModel());
  const units = () => Array.from({ length: microdriveCount() }, (_, i) => i);

  return (
    <Pane id="microdrive-panel" label="Microdrives" mono visible={active()} onResetSettings={() => {
      for (let u = 0; u < 8; u++) if (microdriveSlots()[u]?.loaded) ejectMicrodrive(u);
    }}>
      <For each={units()}>
        {(unit) => <MicrodriveSlot unit={unit} />}
      </For>
    </Pane>
  );
}
