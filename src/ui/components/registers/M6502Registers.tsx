/**
 * 6502 register & flag display — the register panel for `cpuFamily: 'm6502'`.
 *
 * Laid out like the Z80 panel: registers in two aligned columns on the left,
 * the status-register flags paired on the right. The 6502 has no IFF/IM pair —
 * its interrupt mask is the I flag, shown with the others. Builds the DOM once,
 * then writes text nodes directly, so Solid never re-renders it.
 */

import { createEffect, onMount, onCleanup } from 'solid-js';
import { machine } from '@/shell/context.ts';
import { regsRev } from '@/state/debug-state.ts';
import { set8, set16, setStr, makeLabel, makeSlot, makeFlag } from './dom.ts';

export function M6502Registers() {
  let ref!: HTMLPreElement;

  onMount(() => {
    const pre = ref;
    const s = {
      a: makeSlot(), x: makeSlot(), y: makeSlot(), p: makeSlot(),
      pc: makeSlot(), sp: makeSlot(), tpf: makeSlot(),
      fSign: makeFlag('Sign', 'Negative: bit 7 of the last result'),
      fOvfl: makeFlag('Ovfl', 'Overflow: signed overflow from ADC/SBC (or bit 6 via BIT)'),
      fDeci: makeFlag('Deci', 'Decimal: ADC/SBC work in BCD'),
      fIDis: makeFlag('IDis', 'Interrupt disable: set masks IRQ (NMI still fires)'),
      fZero: makeFlag('Zero', 'Set if the last result was zero'),
      fCrry: makeFlag('Crry', 'Carry: carry out of bit 7, or no borrow'),
    };
    const t = (str: string) => document.createTextNode(str);

    // Row 1: A   xx    X   xx     Sign Ovfl
    pre.append(
      makeLabel('A ', 'Accumulator'), t('  '), s.a, t('    '),
      makeLabel('X ', 'Index register X'), t('  '), s.x, t('     '),
      s.fSign.el, t(' '), s.fOvfl.el, t('\n'),
    );
    // Row 2: Y   xx    P   xx     Deci IDis
    pre.append(
      makeLabel('Y ', 'Index register Y'), t('  '), s.y, t('    '),
      makeLabel('P ', 'Processor status (NV-BDIZC)'), t('  '), s.p, t('     '),
      s.fDeci.el, t(' '), s.fIDis.el, t('\n'),
    );
    // Row 3: PC  xxxx  SP  xxxx   Zero Crry
    pre.append(
      makeLabel('PC', 'Program counter'), t('  '), s.pc, t('  '),
      makeLabel('SP', 'Stack pointer (page 1)'), t('  '), s.sp, t('   '),
      s.fZero.el, t(' '), s.fCrry.el, t('\n'),
    );
    // Row 4: cycles per frame.
    pre.append(makeLabel('T/F', 'CPU cycles per frame'), t(' '), s.tpf);

    let pA = -1, pX = -1, pY = -1, pP = -1, pPC = -1, pSP = -1, pTPF = '';

    createEffect(() => {
      regsRev(); // track the signal
      if (!machine) return;
      const snap = machine.services.debug.regs();
      const v: Record<string, number> = {};
      for (const r of snap.regs) v[r.name] = r.value;
      pA = set8(s.a, v['A'] ?? 0, pA);
      pX = set8(s.x, v['X'] ?? 0, pX);
      pY = set8(s.y, v['Y'] ?? 0, pY);
      pP = set8(s.p, v['P'] ?? 0, pP);
      pPC = set16(s.pc, snap.pc, pPC);
      pSP = set16(s.sp, 0x0100 | (snap.sp & 0xFF), pSP);
      pTPF = setStr(s.tpf, machine.tStatesPerFrame.toLocaleString(), pTPF);
      const flag = (name: string) => snap.flags.find(fl => fl.name === name)?.set ?? false;
      s.fSign.update(flag('N'));
      s.fOvfl.update(flag('V'));
      s.fDeci.update(flag('D'));
      s.fIDis.update(flag('I'));
      s.fZero.update(flag('Z'));
      s.fCrry.update(flag('C'));
    });

    onCleanup(() => {
      pre.textContent = '';
    });
  });

  return <pre id="regs-output" ref={ref} />;
}
