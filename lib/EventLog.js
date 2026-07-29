'use strict';

// Keeps the log to a bounded, small footprint. 100 lines is enough to answer
// "why did my Flow not fire this morning?" and, at the truncation limit below,
// caps the whole buffer at roughly 25 KB however long the app runs.
const MAX_ENTRIES = 100;
const MAX_MESSAGE_LENGTH = 200;

/**
 * A small in-memory record of what the app has done, shown on the settings page.
 *
 * Deliberately not persisted. Writing every event to app settings would put the
 * log on flash - repeated writes for something nobody reads most days - and the
 * settings store is not a log store. The cost is that restarting the app clears
 * it, which the settings page says plainly rather than leaving you to wonder.
 */
class EventLog {

  constructor({ limit = MAX_ENTRIES } = {}) {
    this.limit = limit;
    this.entries = [];
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
  }

  /** Newest first, which is the order the settings page wants to show. */
  list() {
    return [...this.entries].reverse();
  }

  clear() {
    this.entries = [];
  }

}

module.exports = EventLog;
