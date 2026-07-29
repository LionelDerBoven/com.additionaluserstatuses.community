'use strict';

// Keeps the log to a bounded, small footprint. 100 lines is enough to answer
// "why did my Flow not fire this morning?" and, at the truncation limit below,
// caps the whole buffer at a measured 25 KB however long the app runs.
const MAX_ENTRIES = 100;
const MAX_MESSAGE_LENGTH = 200;

const ENTRIES_SETTING = 'log_entries';
const PERSIST_SETTING = 'log_persist';

// Events arrive in bursts - a vacation change fires several in a row - and each
// save is a flash write. Coalescing them into one write a few seconds later
// turns a burst into a single write without losing anything a human would miss.
const SAVE_DEBOUNCE_MS = 5000;

/**
 * A small record of what the app has done, shown on the settings page.
 *
 * Memory-only by default: writing every event to app settings puts a log nobody
 * reads most days onto flash. Persistence is opt-in, and when it is on the
 * writes are debounced so a burst of events costs one write rather than five.
 */
class EventLog {

  /**
   * @param {object} [opts]
   * @param {import('homey').App['homey']} [opts.homey] Needed only to persist.
   */
  constructor({ homey = null, limit = MAX_ENTRIES } = {}) {
    this.homey = homey;
    this.limit = limit;
    this.entries = [];
    this.saveTimer = null;

    if (this.isPersistent()) this.load();
  }

  isPersistent() {
    return Boolean(this.homey) && this.homey.settings.get(PERSIST_SETTING) === true;
  }

  /** Restores a persisted log, ignoring anything that is not the right shape. */
  load() {
    const stored = this.homey.settings.get(ENTRIES_SETTING);
    if (!Array.isArray(stored)) return;

    this.entries = stored
      .filter((e) => e && typeof e.message === 'string' && typeof e.at === 'number')
      .slice(-this.limit);
  }

  /**
   * @param {string} message
   * @param {'info'|'trigger'|'error'} [level]
   */
  add(message, level = 'info') {
    const text = String(message);

    this.entries.push({
      at: Date.now(),
      level,
      // A runaway error message must not be able to grow the buffer without limit.
      message: text.length > MAX_MESSAGE_LENGTH
        ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…`
        : text,
    });

    // Oldest out first. At this size splice is cheaper than any ring-buffer
    // bookkeeping would be, and leaves the array in newest-last order.
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }

    this.scheduleSave();
  }

  /** Newest first, which is the order the settings page wants to show. */
  list() {
    return [...this.entries].reverse();
  }

  clear() {
    this.entries = [];
    this.scheduleSave();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  scheduleSave() {
    if (!this.isPersistent() || this.saveTimer) return;

    this.saveTimer = this.homey.setTimeout(() => {
      this.saveTimer = null;
      this.save().catch(() => {
        // A log that cannot be written is not worth taking the app down for.
      });
    }, SAVE_DEBOUNCE_MS);
  }

  async save() {
    if (!this.isPersistent()) return;

    await this.homey.settings.set(ENTRIES_SETTING, this.entries);
  }

  /**
   * Called when the user flips the setting. Turning it on keeps what is already
   * in memory; turning it off removes the stored copy rather than leaving an
   * orphan sitting in settings for ever.
   *
   * @param {boolean} persist
   */
  async onPersistChanged(persist) {
    if (persist) {
      await this.save();
      return;
    }

    if (this.saveTimer) {
      this.homey.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    await this.homey.settings.unset(ENTRIES_SETTING);
  }

  /** Flush on shutdown, so the last few seconds are not lost. */
  async stop() {
    if (this.saveTimer) {
      this.homey.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    await this.save().catch(() => {});
  }

}

module.exports = EventLog;
