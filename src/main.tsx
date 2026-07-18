/**
 * ZX84 - ZX Spectrum Emulator
 * Entry point: render Solid app.
 */

import { render } from 'solid-js/web';
import { App } from '@/app.tsx';
import { saveHMRState } from '@/shell/lifecycle.ts';
import '@/styles.css';

const root = document.getElementById('app')!;
render(() => <App />, root);

// Persist machine state before the page unloads so a manual refresh resumes
// where it left off (HMR is disabled — see vite.config.ts).
window.addEventListener('beforeunload', () => {
  saveHMRState();
});
