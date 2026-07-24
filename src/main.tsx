/**
 * ZX84 - ZX Spectrum Emulator
 * Entry point: render Solid app.
 */

import { render } from 'solid-js/web';
import { App } from '@/app.tsx';
import { saveRefreshState } from '@/shell/lifecycle.ts';
import '@/styles.css';

const root = document.getElementById('app')!;
if (import.meta.env.DEV && window.location.pathname === '/keyboard-lab') {
  void import('@/ui/keyboard-lab/KeyboardLab.tsx').then(({ KeyboardLab }) => {
    render(() => <KeyboardLab />, root);
  });
} else {
  render(() => <App />, root);
}

// Persist machine state before the page unloads so a manual refresh resumes
// where it left off (Vite HMR is disabled — see vite.config.ts).
if (!(import.meta.env.DEV && window.location.pathname === '/keyboard-lab')) {
  window.addEventListener('beforeunload', () => {
    saveRefreshState();
  });
}
