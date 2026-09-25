// Persist only whitelisted appearance choices, never message, conversation or account data. Values outside
// the whitelist are dropped rather than trusted, because this object is written straight into CSS custom
// properties and dataset attributes.
(() => {
  'use strict';
  const KEY = 'ohSidePanelAppearance';
  const defaults = Object.freeze({ fontSize: 14, accent: 'slate' });
  const SIZES = [12, 13, 14, 16, 18];
  const ACCENTS = ['slate', 'teal', 'violet', 'amber'];
  const normalize = value => ({
    fontSize: SIZES.includes(Number(value?.fontSize)) ? Number(value.fontSize) : defaults.fontSize,
    accent: ACCENTS.includes(value?.accent) ? value.accent : defaults.accent
  });
  let prefs;
  try { prefs = normalize(JSON.parse(localStorage.getItem(KEY))); } catch { prefs = { ...defaults }; }
  let font = null, accent = null, status = null;

  function apply() {
    document.documentElement.style.setProperty('--chat-font-size', `${prefs.fontSize}px`);
    document.documentElement.dataset.accent = prefs.accent;
    if (font) font.value = String(prefs.fontSize);
    if (accent) accent.value = prefs.accent;
  }
  function save() {
    apply();
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
      if (status) status.textContent = 'Text size and accent saved. Conversations are never stored.';
    } catch {
      if (status) status.textContent = 'Appearance applied, but Chrome could not save it.';
    }
  }
  apply();
  window.addEventListener('storage', event => {
    if (event.key !== KEY && event.key !== null) return;
    try { prefs = normalize(JSON.parse(event.newValue)); } catch { prefs = { ...defaults }; }
    apply();
  });

  function bind() {
    font = document.getElementById('font-size');
    accent = document.getElementById('accent-color');
    status = document.getElementById('appearance-status');
    if (!font || !accent) return;
    apply();
    font.addEventListener('change', () => { prefs = normalize({ ...prefs, fontSize: Number(font.value) }); save(); });
    accent.addEventListener('change', () => { prefs = normalize({ ...prefs, accent: accent.value }); save(); });
    document.getElementById('reset-appearance')?.addEventListener('click', () => { prefs = { ...defaults }; save(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
