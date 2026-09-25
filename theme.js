// Appearance only. The theme choice is stored separately from any other preference and is the only thing
// this file writes: no message text, no account data, no conversation state, no network.
// Runs in <head> before the panel paints, so dark mode never flashes white on open.
(() => {
  'use strict';
  const KEY = 'ohSidePanelTheme';
  const normalise = value => (['light', 'dark', 'system'].includes(value) ? value : 'system');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { preference = normalise(localStorage.getItem(KEY)); } catch { /* use system when storage is unavailable */ }
  let control = null, status = null;

  function apply() {
    const resolved = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    if (control) control.value = preference;
  }
  apply();
  media.addEventListener('change', () => { if (preference === 'system') apply(); });
  // A second panel window shares the choice.
  window.addEventListener('storage', event => {
    if (event.key === KEY || event.key === null) { preference = normalise(event.newValue); apply(); }
  });

  function bind() {
    control = document.getElementById('theme-select');
    status = document.getElementById('theme-status');
    if (!control) return;
    apply();
    control.addEventListener('change', () => {
      preference = normalise(control.value);
      apply();
      const name = preference === 'system' ? 'System' : preference === 'dark' ? 'Dark' : 'Light';
      try {
        localStorage.setItem(KEY, preference);
        if (status) { status.textContent = `${name} theme selected. Chat and account data are never stored.`; status.className = 'sr-only'; }
      } catch {
        if (status) { status.textContent = 'Theme applied for this panel, but Chrome could not save the preference.'; status.className = 'hint theme-save-error'; }
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
