// Memory-only best-effort lease: while a turn is in flight the connected OpenHands tab is marked
// non-discardable, so Chrome's memory saver cannot throw away the tab whose reply we are capturing.
// Changes are serialized per tab, including acquire/release races. Nothing is persisted.
export class TabAwakeLease {
  constructor(api = chrome) { this.api = api; this.entries = new Map(); }
  acquire(tabId) { return this.change(tabId, true); }
  release(tabId) { return this.change(tabId, false); }
  change(tabId, keep) {
    if (!Number.isInteger(tabId)) return Promise.resolve();
    let entry = this.entries.get(tabId);
    if (!entry && !keep) return Promise.resolve();
    if (!entry) { entry = { work: Promise.resolve() }; this.entries.set(tabId, entry); }
    const work = entry.work.then(async () => {
      try {
        if (entry.original === undefined) {
          const tab = await this.api.tabs.get(tabId);
          if (typeof tab.autoDiscardable !== 'boolean') return;
          entry.original = tab.autoDiscardable;
        }
        await this.api.tabs.update(tabId, { autoDiscardable: keep ? false : entry.original });
      } catch { /* tab closed, or the extension context was invalidated by an update */ }
    });
    entry.work = work;
    return work.finally(() => { if (!keep && entry.work === work) this.entries.delete(tabId); });
  }
}
