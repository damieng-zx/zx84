import { Show } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { RawHtml } from '@/components/RawHtml.tsx';
import { DropDownMenuButton } from '@/components/DropDownMenuButton.tsx';
import { HiOutlineEllipsisVertical, HiOutlineDocumentPlus, HiOutlineArrowDownTray, HiOutlineArrowPath } from 'solid-icons/hi';
import {
  driveAStatus, driveBStatus, trapLogHtml, showTrapLog, currentModel,
  currentDiskName, currentDiskNameB, currentDiskInfo, currentDiskInfoB,
  ejectDisk, loadFile, insertBlankDisk, saveDisk, machine, spectrum,
  currentDiskNameC, currentDiskNameD, currentDiskInfoC, currentDiskInfoD,
  driveCStatus, driveDStatus, ejectPlusDDisk, insertBlankPlusDDisk, savePlusDDisk,
  applyDisplaySettings, flipDisk, diskSideA, diskSideB,
} from '@/emulator.ts';
import {
  diskSoundA, setDiskSoundA, diskSoundB, setDiskSoundB,
  writeProtectA, setWriteProtectA, writeProtectB, setWriteProtectB,
  driveBForceReady, setDriveBForceReady,
  diskSoundC, setDiskSoundC, diskSoundD, setDiskSoundD,
  writeProtectC, setWriteProtectC, writeProtectD, setWriteProtectD,
  plusDEnabled, tapeTurbo, setTapeTurbo,
  persistSetting, resetSettingsGroup,
} from '@/store/settings.ts';
import { isPlus3 } from '@/spectrum.ts';
import { cpcHasDisk, isPlusDCapable } from '@/models.ts';
import { DISK_FORMATS, formatLabel, createBlankDisk, type DskImage } from '@/plus3/dsk.ts';
import type { DriveStatus } from '@/state/disk-state.ts';
import { openFile } from '@/ui/file-picker.ts';

const LED_COLORS: Record<DriveStatus['led'], string> = {
  off:   '#111',
  motor: '#2266ee',
  seek:  '#ddaa00',
  read:  '#22bb44',
  write: '#dd2222',
};

function renderDiskInfoStr(img: DskImage, showProtection = true): string {
  const n = '<span class="reg-name">';
  const e = '</span>';
  const t0 = img.tracks[0]?.[0];
  const spt = t0 ? t0.sectors.length : 0;
  const sectorSize = t0?.sectors[0] ? (128 << t0.sectors[0].n) : 0;
  // A flippy disk's two sides are independent 180K filesystems, so report a
  // single side's capacity rather than the combined 360K of the whole DSK.
  const effectiveSides = img.flippy ? 1 : img.numSides;
  const capacityKB = (effectiveSides * img.numTracks * spt * sectorSize) / 1024;
  const tooltip = `${img.numSides} side${img.numSides > 1 ? 's' : ''}, ${img.numTracks} tracks, ${spt} sectors/track`;
  const lines = [
    `${n}Format${e}   <span title="${tooltip}">${img.diskFormat} (${capacityKB} KB)</span>`,
  ];
  // The Protect row reports +3 DSK copy-protection detection; it's meaningless
  // for raw +D images (always "None"), so the +D drives suppress it.
  if (showProtection) lines.push(`${n}Protect${e}  ${img.protection || 'None'}`);
  return lines.join('\n');
}

function DiskInfo(props: {
  label: string;
  name: string;
  diskInfo: DskImage | null;
  status: DriveStatus;
  soundEnabled: boolean;
  writeProtected: boolean;
  forceReady?: boolean;
  newItems: { value: string; label: string }[];
  onNewDisk: (value: string) => void;
  onSave: () => void;
  onEject: () => void;
  onInsert: () => void;
  onToggleSound: () => void;
  onToggleWriteProtect: () => void;
  onToggleForceReady?: () => void;
  /** Active side of a flippy disk (0 = A, 1 = B); flip handler to turn it over. */
  side?: number;
  onFlip?: () => void;
  showProtection?: boolean;
  /** Show the global "Turbo while loading" toggle in this drive's menu (+3 /
   *  CPC drives, whose FDC reads engage disk turbo). */
  showTurbo?: boolean;
}) {
  return (
    <div class="disk-section">
      <div class="drive-header">
        <span class="disk-label">{props.label}</span>
        <span class="drive-track-info">
          <span class="reg-name">Track</span>{' '}{props.status.track}
          {'  '}
          <span class="reg-name">Sector</span>{' '}{props.status.sector}
        </span>
        <DropDownMenuButton
          icon={<HiOutlineDocumentPlus />}
          title={`New disk in drive ${props.label}`}
          size="sm"
          items={props.newItems}
          onSelect={(value) => props.onNewDisk(value)}
        />
        <button
          class="btn btn-sm ddmenu-btn"
          classList={{ 'btn-dirty': props.status.dirty }}
          title={props.status.dirty ? `Save drive ${props.label} (unsaved changes)` : `Save drive ${props.label}`}
          disabled={!props.diskInfo}
          onClick={() => props.onSave()}
        >
          <HiOutlineArrowDownTray />
        </button>
        <DropDownMenuButton
          icon={<HiOutlineEllipsisVertical />}
          title={`Drive ${props.label} options`}
          size="sm"
          items={[
            { value: 'sound', label: 'Drive sounds', checked: props.soundEnabled },
            { value: 'wp', label: 'Write protect', checked: props.writeProtected },
            ...(props.onToggleForceReady
              ? [{ value: 'force-ready', label: 'Present when empty', checked: props.forceReady }]
              : []),
            ...(props.showTurbo
              ? [{ value: '__sep', label: '', separator: true },
                 { value: 'turbo', label: 'Turbo while loading', checked: tapeTurbo() }]
              : []),
          ]}
          onSelect={(value) => {
            if (value === 'sound') props.onToggleSound();
            else if (value === 'wp') props.onToggleWriteProtect();
            else if (value === 'force-ready') props.onToggleForceReady?.();
            else if (value === 'turbo') {
              setTapeTurbo(!tapeTurbo());
              persistSetting('tape-turbo-load', tapeTurbo() ? 'on' : 'off');
              applyDisplaySettings();
            }
          }}
        />
      </div>
      <div class="disk-slot">
        <div
          class="disk-name"
          classList={{ 'disk-name-clickable': !props.name }}
          onClick={() => !props.name && props.onInsert()}
        >
          <span class="disk-name-text" title={props.name || ''}>
            {props.name
              ? (props.diskInfo?.flippy ? `${props.name} — Side ${props.side ? 'B' : 'A'}` : props.name)
              : 'No disk inserted'}
          </span>
          <Show when={props.name && props.diskInfo?.flippy && props.onFlip}>
            <button
              class="tape-eject"
              title={`Flip disk ${props.label} (turn over to Side ${props.side ? 'A' : 'B'})`}
              onClick={(e) => { e.stopPropagation(); props.onFlip!(); }}
            >
              <HiOutlineArrowPath size={14} />
            </button>
          </Show>
          <Show when={props.name}>
            <button class="tape-eject" title={`Eject disk ${props.label}`} onClick={(e) => { e.stopPropagation(); props.onEject(); }}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                <path d="M8 2L2 10h12L8 2zM2 12v2h12v-2H2z"/>
              </svg>
            </button>
          </Show>
        </div>
        <span class="drive-led" style={{ background: LED_COLORS[props.status.led] }} title={props.status.led} />
      </div>
      <Show when={props.diskInfo}>
        <pre class="disk-info-output" innerHTML={renderDiskInfoStr(props.diskInfo!, props.showProtection ?? true)} />
      </Show>
    </div>
  );
}

function syncWriteProtect(unit: number, value: boolean): void {
  if (machine) machine.fdc.writeProtect[unit] = value;
}

function syncForceReady(unit: number, value: boolean): void {
  if (machine) machine.fdc.forceReady[unit] = value;
}

function syncPlusDWriteProtect(unit: number, value: boolean): void {
  if (spectrum) spectrum.mgtPlusD.fdc.writeProtect[unit] = value;
}

const PLUS3_NEW_ITEMS = DISK_FORMATS.map((fmt, i) => ({ value: `new-${i}`, label: formatLabel(fmt) }));
const PLUSD_NEW_ITEMS = [{ value: 'blank', label: 'Blank +D disk (800K)' }];

export function DrivePane() {
  async function handleInsertDisk(unit: number) {
    const results = await openFile({
      id: 'zx84-disk',
      extensions: ['.dsk', '.hfe', '.zip'],
    });
    if (!results) return;
    await loadFile(results[0].data, results[0].name, unit);
  }

  async function handleInsertPlusDDisk(unit: number) {
    const results = await openFile({
      id: 'zx84-plusd-disk',
      extensions: ['.mgt', '.img', '.hfe', '.zip'],
    });
    if (!results) return;
    await loadFile(results[0].data, results[0].name, unit);
  }

  // The +D drives C:/D: only exist when the +D is enabled *and* fitted to a
  // capable model — switching to e.g. the +3 (not +D-capable) must hide them
  // even though the persisted plusDEnabled setting stays on.
  const plusDActive = () => plusDEnabled() && isPlusDCapable(currentModel());

  return (
    <Pane id="drive-panel" label="Drives" mono visible={isPlus3(currentModel()) || cpcHasDisk(currentModel()) || plusDActive()} onResetSettings={() => {
      // Eject any loaded disk in each drive — +3/CPC A:/B: and the +D's C:/D:.
      // Guarded so empty drives don't fire a misleading "ejected" toast.
      if (currentDiskName()) ejectDisk(0);
      if (currentDiskNameB()) ejectDisk(1);
      if (currentDiskNameC()) ejectPlusDDisk(0);
      if (currentDiskNameD()) ejectPlusDDisk(1);
      resetSettingsGroup('drive');
      if (machine) {
        machine.fdc.writeProtect[0] = false; machine.fdc.writeProtect[1] = false;
        machine.fdc.forceReady[1] = false;
      }
      if (spectrum) { spectrum.mgtPlusD.fdc.writeProtect[0] = false; spectrum.mgtPlusD.fdc.writeProtect[1] = false; }
    }}>
      <Show when={isPlus3(currentModel()) || cpcHasDisk(currentModel())}>
        <DiskInfo
          label="A:"
          name={currentDiskName()}
          diskInfo={currentDiskInfo()}
          status={driveAStatus()}
          soundEnabled={diskSoundA()}
          writeProtected={writeProtectA()}
          side={diskSideA()}
          onFlip={() => flipDisk(0)}
          showTurbo
          newItems={PLUS3_NEW_ITEMS}
          onNewDisk={(value) => {
            const fmt = DISK_FORMATS[parseInt(value.slice(4))];
            if (fmt) insertBlankDisk(createBlankDisk(fmt), formatLabel(fmt), 0);
          }}
          onSave={() => saveDisk(0)}
          onEject={() => ejectDisk(0)}
          onInsert={() => handleInsertDisk(0)}
          onToggleSound={() => {
            setDiskSoundA(!diskSoundA());
            persistSetting('disk-sound-a', diskSoundA() ? 'on' : 'off');
          }}
          onToggleWriteProtect={() => {
            setWriteProtectA(!writeProtectA());
            persistSetting('write-protect-a', writeProtectA() ? 'on' : 'off');
            syncWriteProtect(0, writeProtectA());
          }}
        />
        <DiskInfo
          label="B:"
          name={currentDiskNameB()}
          diskInfo={currentDiskInfoB()}
          status={driveBStatus()}
          soundEnabled={diskSoundB()}
          writeProtected={writeProtectB()}
          forceReady={driveBForceReady()}
          side={diskSideB()}
          onFlip={() => flipDisk(1)}
          showTurbo
          newItems={PLUS3_NEW_ITEMS}
          onNewDisk={(value) => {
            const fmt = DISK_FORMATS[parseInt(value.slice(4))];
            if (fmt) insertBlankDisk(createBlankDisk(fmt), formatLabel(fmt), 1);
          }}
          onSave={() => saveDisk(1)}
          onEject={() => ejectDisk(1)}
          onInsert={() => handleInsertDisk(1)}
          onToggleSound={() => {
            setDiskSoundB(!diskSoundB());
            persistSetting('disk-sound-b', diskSoundB() ? 'on' : 'off');
          }}
          onToggleWriteProtect={() => {
            setWriteProtectB(!writeProtectB());
            persistSetting('write-protect-b', writeProtectB() ? 'on' : 'off');
            syncWriteProtect(1, writeProtectB());
          }}
          onToggleForceReady={() => {
            setDriveBForceReady(!driveBForceReady());
            persistSetting('drive-b-force-ready', driveBForceReady() ? 'on' : 'off');
            syncForceReady(1, driveBForceReady());
          }}
        />
      </Show>
      <Show when={plusDActive()}>
        <DiskInfo
          label="C:"
          name={currentDiskNameC()}
          diskInfo={currentDiskInfoC()}
          status={driveCStatus()}
          soundEnabled={diskSoundC()}
          writeProtected={writeProtectC()}
          showProtection={false}
          newItems={PLUSD_NEW_ITEMS}
          onNewDisk={() => insertBlankPlusDDisk(0)}
          onSave={() => savePlusDDisk(0)}
          onEject={() => ejectPlusDDisk(0)}
          onInsert={() => handleInsertPlusDDisk(0)}
          onToggleSound={() => {
            setDiskSoundC(!diskSoundC());
            persistSetting('disk-sound-c', diskSoundC() ? 'on' : 'off');
          }}
          onToggleWriteProtect={() => {
            setWriteProtectC(!writeProtectC());
            persistSetting('write-protect-c', writeProtectC() ? 'on' : 'off');
            syncPlusDWriteProtect(0, writeProtectC());
          }}
        />
        <DiskInfo
          label="D:"
          name={currentDiskNameD()}
          diskInfo={currentDiskInfoD()}
          status={driveDStatus()}
          soundEnabled={diskSoundD()}
          writeProtected={writeProtectD()}
          showProtection={false}
          newItems={PLUSD_NEW_ITEMS}
          onNewDisk={() => insertBlankPlusDDisk(1)}
          onSave={() => savePlusDDisk(1)}
          onEject={() => ejectPlusDDisk(1)}
          onInsert={() => handleInsertPlusDDisk(1)}
          onToggleSound={() => {
            setDiskSoundD(!diskSoundD());
            persistSetting('disk-sound-d', diskSoundD() ? 'on' : 'off');
          }}
          onToggleWriteProtect={() => {
            setWriteProtectD(!writeProtectD());
            persistSetting('write-protect-d', writeProtectD() ? 'on' : 'off');
            syncPlusDWriteProtect(1, writeProtectD());
          }}
        />
      </Show>
      <Show when={showTrapLog()}>
        <RawHtml id="trap-log" html={trapLogHtml} />
      </Show>
    </Pane>
  );
}
