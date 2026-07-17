/**
 * ZX84 architecture boundary rules (dependency-cruiser).
 *
 * See docs/re-architecture.md §3.1 (import table) and §7 (enforcement).
 *
 * The target layout (src/machines/<name>/, src/media/, src/shell/) does not
 * exist yet — the code is still in its current, pre-migration layout. These
 * rules therefore encode the *spirit* of the target boundaries against the
 * CURRENT layout, for the boundaries that are already meaningful today:
 *
 *   - Cores model commodity silicon and must import nothing above the cores
 *     layer (cores + media-types + utils only).
 *   - The media/format code (src/floppy, src/tape → future src/media) must not
 *     import machines, UI, or state.
 *   - Each machine folder (src/cpc, src/einstein, src/msx → future
 *     src/machines/<name>) is an island: it must not import another machine
 *     folder, nor components/state/store.
 *
 * Every currently-existing violation is listed below as an explicit, documented
 * exception. `npm run depcheck` MUST pass today; this exception list is the
 * burn-down backlog for the migration — each entry names the violation and the
 * phase that removes it. When a phase relocates the offending file, delete its
 * exception here and the rule tightens automatically.
 */

// ── Baseline exceptions (burn-down backlog) ────────────────────────────────
//
// cores-know-nothing:
//   1. src/cores/ula.ts → src/keyboard.ts
//      The Ferranti ULA is Spectrum-only custom silicon that reads the key
//      matrix. Moves to src/machines/spectrum/ (ula.ts + keyboard.ts together)
//      in Phase 1; the import is then in-folder. §3.4 also narrows it to a
//      KeyMatrixSource interface. Removes this exception.
//   2. src/cores/gate-array.ts → src/cpc/constants.ts
//      The Amstrad gate array is CPC-only custom silicon. Moves to
//      src/machines/cpc/gate-array.ts in Phase 1; import becomes in-folder.
const CORES_EXCEPTION_TARGETS =
  '|src/keyboard\\.ts$' + // ula.ts → SpectrumKeyboard (Phase 1)
  '|src/cpc/constants\\.ts$'; // gate-array.ts → CPC constants (Phase 1)

// machines-are-islands / machines-no-ui:
//   None. No CPC/Einstein/MSX file currently imports another machine folder or
//   components/state/store. These rules are already clean.
//
// media-is-pure:
//   None. src/floppy and src/tape currently import only cores (types) and each
//   other; neither reaches a machine, UI, or state module.

module.exports = {
  forbidden: [
    {
      name: 'cores-know-nothing',
      comment:
        'src/cores/** models commodity silicon: it may import only other cores, ' +
        'media types (src/floppy), and src/utils. See re-architecture §3.1.',
      severity: 'error',
      from: { path: '^src/cores/' },
      to: {
        pathNot:
          '^(src/cores/|src/floppy/|src/utils/|node_modules/)' +
          CORES_EXCEPTION_TARGETS,
      },
    },
    {
      name: 'media-is-pure',
      comment:
        'Format/media code (src/floppy, src/tape → future src/media) parses into ' +
        'neutral models and must not import a machine, UI, or state. §3.1/§4.',
      severity: 'error',
      from: { path: '^src/(floppy|tape)/' },
      to: {
        path: '^src/(spectrum\\.ts|cpc/|einstein/|msx/|components/|state/|store/|managers/|emulator\\.ts)',
      },
    },
    {
      name: 'machines-are-islands',
      comment:
        'A machine folder (src/cpc, src/einstein, src/msx → future ' +
        'src/machines/<name>) must not import another machine folder. §3.1.',
      severity: 'error',
      from: { path: '^src/(cpc|einstein|msx)/' },
      to: { path: '^src/(cpc|einstein|msx)/', pathNot: '^src/$1/' },
    },
    {
      name: 'machines-no-ui',
      comment:
        'A machine folder must not import UI, reactive state, or the settings ' +
        'store; those bind to machines through services/registry, not vice-versa. §3.1.',
      severity: 'error',
      from: { path: '^src/(cpc|einstein|msx)/' },
      to: { path: '^src/(components|state|store)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
