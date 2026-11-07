import { createSignal, For, Show } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { HiOutlineChevronUp, HiOutlineChevronDown, HiOutlineChevronLeft, HiOutlineChevronRight } from 'solid-icons/hi';
import { joyP1, joyP2, joyMapP1, joyMapP2, setJoyP1, setJoyP2, setJoyMapP1, setJoyMapP2, persistSetting, gamepadConfigP1, gamepadConfigP2, setGamepadConfigP1, setGamepadConfigP2, resetSettingsGroup } from '@/store/settings.ts';
import { joyPressForType } from '@/shell/media.ts';
import { applyDisplaySettings, settingEnabled } from '@/shell/settings.ts';
import { machineCaps } from '@/state/machine-caps.ts';

// On the Spectrum a joystick can present to the CPU through several interface
// types (Kempston/Cursor/Sinclair — each maps to different ports/bits), so the
// type has to be chosen. The CPC, MSX and Atari each expose fixed joystick
// ports to the CPU, so there is nothing to select and the type selector is
// hidden. The F2 button is shown for sticks with a second fire button.
const isFixedJoystick = () => machineCaps().fixedJoystick;
const fireButtons = () => machineCaps().joystickFireButtons ?? (isFixedJoystick() ? 2 : 1);
// A machine with its own interfaces lists them (the PCW's Kempston,
// Spectravideo and Cascade); otherwise the selector offers the Spectrum's.
const SPECTRUM_JOYSTICK_TYPES = [
  { id: 'kempston', label: 'Kempston' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'sinclair1', label: 'Sinclair Port 1' },
  { id: 'sinclair2', label: 'Sinclair Port 2' },
] as const;
const joystickTypes = () => machineCaps().joystickTypes ?? SPECTRUM_JOYSTICK_TYPES;

// Configuration mode state
export const [configuringPlayer, setConfiguringPlayer] = createSignal<number>(-1);
export const [configuringStep, setConfiguringStep] = createSignal<string>('');
export const [configuringProgress, setConfiguringProgress] = createSignal<number>(0);

function cancelConfiguration(): void {
  setConfiguringPlayer(-1);
  setConfiguringStep('');
  setConfiguringProgress(0);
}

function DpadButton(props: { dir: string; playerIdx: number }) {
  const selectors = [joyP1, joyP2];
  const icons: Record<string, typeof HiOutlineChevronUp> = {
    up: HiOutlineChevronUp, down: HiOutlineChevronDown, left: HiOutlineChevronLeft, right: HiOutlineChevronRight,
  };
  const Icon = icons[props.dir];

  const onPress = (e: Event) => {
    e.preventDefault();
    (e.target as HTMLElement).classList.add('pressed');
    joyPressForType(props.dir, true, selectors[props.playerIdx](), props.playerIdx);
  };
  const onRelease = (e: Event) => {
    e.preventDefault();
    (e.target as HTMLElement).classList.remove('pressed');
    joyPressForType(props.dir, false, selectors[props.playerIdx](), props.playerIdx);
  };
  const onLeave = (e: Event) => {
    (e.target as HTMLElement).classList.remove('pressed');
    joyPressForType(props.dir, false, selectors[props.playerIdx](), props.playerIdx);
  };

  const isActive = () => configuringPlayer() === props.playerIdx && configuringStep() === props.dir;
  const progress = () => isActive() ? configuringProgress() : 0;

  const configStyle = () => isActive() ? {
    background: progress() > 0
      ? `conic-gradient(from 0deg, #3399ff ${progress() * 360}deg, #e0e0e0 ${progress() * 360}deg)`
      : undefined,
  } : undefined;

  const isFire = () => props.dir === 'fire' || props.dir === 'fire2';

  const className = () => [
    'joy-btn',
    isFire() ? 'joy-fire' : '',
    isActive() ? (progress() > 0 ? 'joy-config-holding' : 'joy-config-waiting') : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      class={className()}
      data-dir={props.dir}
      onMouseDown={onPress}
      onMouseUp={onRelease}
      onMouseLeave={onLeave}
      onTouchStart={onPress}
      onTouchEnd={onRelease}
      onTouchCancel={onLeave}
      style={configStyle()}
    >{props.dir === 'fire' ? 'F1' : props.dir === 'fire2' ? 'F2' : <Icon />}</div>
  );
}

function DeadZoneIndicator(props: { playerIdx: number }) {
  const isActive = () => configuringPlayer() === props.playerIdx && configuringStep() === 'deadzone';
  const progress = () => isActive() ? configuringProgress() : 0;

  const className = () => [
    'joy-deadzone',
    isActive() ? (progress() > 0 ? 'joy-config-holding' : 'joy-config-waiting') : '',
  ].filter(Boolean).join(' ');

  const style = () => isActive() && progress() > 0 ? {
    background: `conic-gradient(from 0deg, #3399ff ${progress() * 360}deg, #e0e0e0 ${progress() * 360}deg)`,
  } : undefined;

  return <div class={className()} data-dir="deadzone" style={style()} />;
}

function JoyColumn(props: { playerIdx: number; label: string }) {
  const joySel = () => props.playerIdx === 0 ? joyP1 : joyP2;
  const setJoySel = () => props.playerIdx === 0 ? setJoyP1 : setJoyP2;
  const joyMapSel = () => props.playerIdx === 0 ? joyMapP1 : joyMapP2;
  const setJoyMapSel = () => props.playerIdx === 0 ? setJoyMapP1 : setJoyMapP2;
  const gamepadConfig = () => props.playerIdx === 0 ? gamepadConfigP1 : gamepadConfigP2;
  const joyKey = () => props.playerIdx === 0 ? 'joy-p1' : 'joy-p2';
  const mapKey = () => props.playerIdx === 0 ? 'joy-map-p1' : 'joy-map-p2';

  const hasGamepadConfig = () => gamepadConfig()() !== null;

  const handleMapChange = (e: Event) => {
    const newValue = (e.target as HTMLSelectElement).value;

    if (configuringPlayer() === props.playerIdx) {
      cancelConfiguration();
    }

    if (newValue === 'gamepad-configure') {
      if (props.playerIdx === 0) setGamepadConfigP1(null);
      else setGamepadConfigP2(null);

      setConfiguringPlayer(props.playerIdx);
      setConfiguringStep('deadzone');
      setConfiguringProgress(0);
      setJoyMapSel()('gamepad');
    } else {
      setJoyMapSel()(newValue);
      persistSetting(mapKey(), newValue);
    }
  };

  // The setting is shared by every machine, so it can hold an interface this
  // one does not offer (the Spectrum's Kempston on a machine with its own
  // ports); the machine then gives each player the interface at their own
  // position in its list (player 1 the first, player 2 the second), and so
  // does the selector.
  const shownSel = (): string => {
    const v = joySel()();
    if (v === 'none' || joystickTypes().some(t => t.id === v)) return v;
    return (joystickTypes()[props.playerIdx] ?? joystickTypes()[0])?.id ?? 'none';
  };

  return (
    <div class="joy-column">
      <Show when={!isFixedJoystick()} fallback={<label>{props.label}</label>}>
        <label>{props.label}
          <select id={joyKey()} value={shownSel()} onChange={(e) => {
            setJoySel()((e.target as HTMLSelectElement).value);
            persistSetting(joyKey(), joySel()());
            applyDisplaySettings(); // tell the machine which interface is fitted
          }}>
            <For each={joystickTypes()}>{(t) => <option value={t.id}>{t.label}</option>}</For>
            <option value="none">None</option>
          </select>
        </label>
      </Show>
      <label>
        <select id={mapKey()} value={joyMapSel()()} onChange={handleMapChange}>
          <option value="none">No mapping</option>
          <option value="keys">Cursor keys</option>
          <option value="wasd">WASD + Space</option>
          <Show when={hasGamepadConfig()}><option value="gamepad">Gamestick</option></Show>
          <option value="gamepad-configure">Configure Gamestick</option>
        </select>
      </label>
      <div class="joy-dpad" data-player={props.playerIdx + 1}>
        <DpadButton dir="fire" playerIdx={props.playerIdx} />
        <DpadButton dir="up" playerIdx={props.playerIdx} />
        {/* The CPC (matrix bit 4) and MSX (trigger B) joysticks have a real
            second fire button; the Spectrum's and Atari's are single-fire. */}
        <Show when={fireButtons() === 2} fallback={<div class="joy-spacer" />}>
          <DpadButton dir="fire2" playerIdx={props.playerIdx} />
        </Show>
        <DpadButton dir="left" playerIdx={props.playerIdx} />
        <DeadZoneIndicator playerIdx={props.playerIdx} />
        <DpadButton dir="right" playerIdx={props.playerIdx} />
        <div class="joy-spacer" />
        <DpadButton dir="down" playerIdx={props.playerIdx} />
        <div class="joy-spacer" />
      </div>
    </div>
  );
}

export function JoystickPane() {
  return (
    <Pane id="joystick-panel" label="Joysticks" visible={machineCaps().joystick && settingEnabled(machineCaps().requires?.joystick)} onResetSettings={() => {
      cancelConfiguration();
      resetSettingsGroup('joystick');
      setGamepadConfigP1(null);
      setGamepadConfigP2(null);
      applyDisplaySettings();
    }}>
      <div id="joy-columns">
        <JoyColumn playerIdx={0} label="Player 1" />
        <Show when={(machineCaps().joystickPlayers ?? 2) === 2}>
          <JoyColumn playerIdx={1} label="Player 2" />
        </Show>
      </div>
    </Pane>
  );
}
