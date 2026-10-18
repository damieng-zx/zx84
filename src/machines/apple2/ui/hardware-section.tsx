/**
 * Apple II Hardware-pane options: the expansion cards.
 *
 * Contributed to the generic Hardware pane via the UI manifest. An expansion
 * card is fitted at build time (its ROM is loaded then, and the machine's slot
 * map changes), so each change rebuilds the machine; mounted disks carry over.
 */

import { Show } from 'solid-js';
import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import * as settings from '@/store/settings.ts';
import { apple2ModelInfo } from '../models.ts';

function rebuild(): void {
  void switchModel(currentModel());
}

export function Apple2HardwareSection() {
  const iic = () => apple2ModelInfo(currentModel()).iic;
  return (
    <>
      <Show when={!iic()}>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Fit the Disk ][ controller card in slot 6, with its drives"
        >
          <input
            type="checkbox"
            checked={settings.apple2Disk2()}
            onChange={(event) => {
              const on = (event.target as HTMLInputElement).checked;
              settings.setApple2Disk2(on);
              settings.persistSetting('apple2-disk2', on ? 'on' : 'off');
              rebuild();
            }}
          />
          Disk ][ controller
        </label>
      </div>
      </Show>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Plug a joystick or paddles into the game port. Without it paddle reads time out at full scale and the buttons never close."
        >
          <input
            type="checkbox"
            checked={settings.apple2Joystick()}
            onChange={(event) => {
              const on = (event.target as HTMLInputElement).checked;
              settings.setApple2Joystick(on);
              settings.persistSetting('apple2-joystick', on ? 'on' : 'off');
              rebuild();
            }}
          />
          Paddles / joystick
        </label>
      </div>
      <Show when={!iic()}>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Fit a Mockingboard sound card in slot 4: two AY-3-8910 sound chips (left and right) behind two 6522 VIAs"
        >
          <input
            type="checkbox"
            checked={settings.apple2Mockingboard()}
            onChange={(event) => {
              const on = (event.target as HTMLInputElement).checked;
              settings.setApple2Mockingboard(on);
              settings.persistSetting('apple2-mockingboard', on ? 'on' : 'off');
              rebuild();
            }}
          />
          Mockingboard (slot 4)
        </label>
      </div>
      </Show>
      <Show when={apple2ModelInfo(currentModel()).iie && !iic()}>
        <div class="multiface-row">
          <label
            class="mf-check"
            title="Fit the extended 80-column card: 64K of auxiliary RAM, which the //e's 80-column text, double hi-res and most 128K software need"
          >
            <input
              type="checkbox"
              checked={settings.apple2eEightyCol()}
              onChange={(event) => {
                const on = (event.target as HTMLInputElement).checked;
                settings.setApple2eEightyCol(on);
                settings.persistSetting('apple2e-80col', on ? 'on' : 'off');
                rebuild();
              }}
            />
            Extended 80-column card (64K)
          </label>
        </div>
      </Show>
      <Show when={!apple2ModelInfo(currentModel()).iie}>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Fit a Videx Videoterm 80-column card in slot 3. Its output replaces the Apple's own once PR#3 has switched it on."
        >
          <input
            type="checkbox"
            checked={settings.apple2EightyCol()}
            onChange={(event) => {
              const on = (event.target as HTMLInputElement).checked;
              settings.setApple2EightyCol(on);
              settings.persistSetting('apple2-80col', on ? 'on' : 'off');
              rebuild();
            }}
          />
          Videx 80-column card (slot 3)
        </label>
      </div>
      <div class="multiface-row">
        <label
          class="mf-check"
          title="Fit the 16K language card in slot 0 — RAM that replaces the ROM at $D000-$FFFF, needed by Apple Pascal and many later programs"
        >
          <input
            type="checkbox"
            checked={settings.apple2LangCard()}
            onChange={(event) => {
              const on = (event.target as HTMLInputElement).checked;
              settings.setApple2LangCard(on);
              settings.persistSetting('apple2-langcard', on ? 'on' : 'off');
              rebuild();
            }}
          />
          Language card (16K)
        </label>
      </div>
      </Show>
    </>
  );
}
