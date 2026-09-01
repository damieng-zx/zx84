/**
 * Z80 register & flag display — the register panel for `cpuFamily: 'z80'`.
 *
 * The AF/AF' shadow pairing, the index registers, IFF/IM and the IR pair are
 * Z80 shape, so this layout is family-specific: another CPU family ships its
 * own panel and `Registers.tsx` picks between them. Builds the DOM once, then
 * updates text nodes directly via createEffect — Solid never re-renders this
 * component after mount, so there is zero DOM churn.
 */

import { createEffect, onMount, onCleanup } from 'solid-js';
import { machine } from '@/shell/context.ts';
import { regsRev } from '@/state/debug-state.ts';
import { set16, set8x2, setStr, makeLabel, makeSlot, makeFlag } from './dom.ts';

export function Z80Registers() {
  let ref!: HTMLPreElement;

  onMount(() => {
    const pre = ref;

    // Build DOM structure once
    const s = {
      af: makeSlot(), af_: makeSlot(), bc: makeSlot(), bc_: makeSlot(),
      de: makeSlot(), de_: makeSlot(), hl: makeSlot(), hl_: makeSlot(),
      ix: makeSlot(), iy: makeSlot(), sp: makeSlot(), pc: makeSlot(),
      ir: makeSlot(), tpf: makeSlot(), iff: makeSlot(), im: makeSlot(), halt: makeSlot(),
      fSign: makeFlag('Sign', 'Set if result is negative (bit 7 of result)'),
      fZero: makeFlag('Zero', 'Set if result is zero'),
      fHalf: makeFlag('Half', 'Half-carry: set on carry from bit 3 to bit 4'),
      fPrty: makeFlag('Prty', 'Parity/Overflow: set on even parity or arithmetic overflow'),
      fSubt: makeFlag('Subt', 'Subtract: set if last operation was a subtraction'),
      fCrry: makeFlag('Crry', 'Carry: set on carry from bit 7 or borrow'),
    };

    const t = (str: string) => document.createTextNode(str);

    // Row 1: AF  xxxx  AF' xxxx   Sign Zero
    pre.append(
      makeLabel('AF', 'Accumulator and Flags'), t('  '), s.af, t('  '),
      makeLabel("AF'", 'Shadow Accumulator and Flags'), t(' '), s.af_, t('   '),
      s.fSign.el, t(' '), s.fZero.el, t('\n'),
    );
    // Row 2: BC  xxxx  BC' xxxx   Half Prty
    pre.append(
      makeLabel('BC', 'General-purpose register pair B and C'), t('  '), s.bc, t('  '),
      makeLabel("BC'", 'Shadow BC'), t(' '), s.bc_, t('   '),
      s.fHalf.el, t(' '), s.fPrty.el, t('\n'),
    );
    // Row 3: DE  xxxx  DE' xxxx   Subt Crry
    pre.append(
      makeLabel('DE', 'General-purpose register pair D and E'), t('  '), s.de, t('  '),
      makeLabel("DE'", 'Shadow DE'), t(' '), s.de_, t('   '),
      s.fSubt.el, t(' '), s.fCrry.el, t('\n'),
    );
    // Row 4: HL  xxxx  HL' xxxx   T\F nnn
    pre.append(
      makeLabel('HL', 'General-purpose register pair H and L'), t('  '), s.hl, t('  '),
      makeLabel("HL'", 'Shadow HL'), t(' '), s.hl_, t('   '),
      makeLabel('T/F', 'T-states per frame'), t(' '), s.tpf, t('\n'),
    );
    // Row 5: IX  xxxx  IY  xxxx   EI  IMn HALT
    pre.append(
      makeLabel('IX', 'Index register X'), t('  '), s.ix, t('  '),
      makeLabel('IY', 'Index register Y'), t('  '), s.iy, t('   '),
      s.iff, t('  '), makeLabel('IM', 'Interrupt mode'), s.im, s.halt, t('\n'),
    );
    // Row 6: SP  xxxx  PC  xxxx   IR  xxxx
    pre.append(
      makeLabel('SP', 'Stack pointer'), t('  '), s.sp, t('  '),
      makeLabel('PC', 'Program counter'), t('  '), s.pc, t('   '),
      makeLabel('IR', 'Interrupt vector + Refresh counter'), t('  '), s.ir,
    );

    // Previous values — skip DOM writes when unchanged
    let pAF = -1, pAF_ = -1, pBC = -1, pBC_ = -1, pDE = -1, pDE_ = -1;
    let pHL = -1, pHL_ = -1, pIX = -1, pIY = -1, pSP = -1, pPC = -1;
    let pIR = -1, pTPF = '', pIFF = '', pIM = '', pHALT = '';

    createEffect(() => {
      regsRev(); // track the signal
      if (!machine) return;
      const snap = machine.services.debug.regs();
      const v: Record<string, number> = {};
      for (const r of snap.regs) v[r.name] = r.value;
      pAF = set16(s.af, v['AF'] ?? 0, pAF);
      pAF_ = set16(s.af_, v["AF'"] ?? 0, pAF_);
      pBC = set16(s.bc, v['BC'] ?? 0, pBC);
      pBC_ = set16(s.bc_, v["BC'"] ?? 0, pBC_);
      pDE = set16(s.de, v['DE'] ?? 0, pDE);
      pDE_ = set16(s.de_, v["DE'"] ?? 0, pDE_);
      pHL = set16(s.hl, v['HL'] ?? 0, pHL);
      pHL_ = set16(s.hl_, v["HL'"] ?? 0, pHL_);
      pIX = set16(s.ix, v['IX'] ?? 0, pIX);
      pIY = set16(s.iy, v['IY'] ?? 0, pIY);
      pSP = set16(s.sp, snap.sp, pSP);
      pPC = set16(s.pc, snap.pc, pPC);
      pIR = set8x2(s.ir, v['I'] ?? 0, v['R'] ?? 0, pIR);
      const tpf = machine.tStatesPerFrame.toLocaleString();
      pTPF = setStr(s.tpf, tpf, pTPF);
      pIFF = setStr(s.iff, snap.iff1 ? 'EI' : 'DI', pIFF);
      pIM = setStr(s.im, String(snap.im), pIM);
      pHALT = setStr(s.halt, snap.halted ? ' HALT' : '', pHALT);
      const flag = (name: string) => snap.flags.find(fl => fl.name === name)?.set ?? false;
      s.fSign.update(flag('S'));
      s.fZero.update(flag('Z'));
      s.fHalf.update(flag('H'));
      s.fPrty.update(flag('P'));
      s.fSubt.update(flag('N'));
      s.fCrry.update(flag('C'));
    });

    onCleanup(() => {
      pre.textContent = '';
    });
  });

  return <pre id="regs-output" ref={ref} />;
}
