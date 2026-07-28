'use strict';

const EventEmitter = require('node:events');

const VACATION_SETTING = 'vacation_user_ids';
const ENABLED_SETTING = 'vacation_enabled';
const AUTO_RETURN_SETTING = 'vacation_auto_return';

/**
 * Owns the vacation status of every Homey user.
 *
 * Homey has no vacation concept of its own, so this is entirely ours and lives
 * in app settings. Settings rather than device store is deliberate: vacation has
 * to work for users who have no paired device, and a single source of truth is
 * what stops the settings page, a Flow, a device tile and auto-return from
 * drifting apart. Devices subscribe to 'change' and follow.
 *
 * Emits:
 *   'change' -> { added: string[], removed: string[], ids: string[] }
 */
class VacationStore extends EventEmitter {

  /**
   * @param {object} opts
   * @param {import('homey').App['homey']} opts.homey
   */
  constructor({ homey }) {
    super();
    this.homey = homey;
  }

  // ---------------------------------------------------------------------------
  // Feature toggles
  // ---------------------------------------------------------------------------

  /** Both default to on, so a fresh install behaves as described in the store. */
  isEnabled() {
    return this.homey.settings.get(ENABLED_SETTING) !== false;
  }

  isAutoReturnEnabled() {
    return this.homey.settings.get(AUTO_RETURN_SETTING) !== false;
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /**
   * The raw stored ids. Kept even while the feature is disabled, so switching it
   * back on restores what was there rather than silently losing it.
   */
  getStoredIds() {
    const stored = this.homey.settings.get(VACATION_SETTING);
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [];
  }

  /**
   * The ids that actually count right now. Empty while the feature is off, which
   * is what makes the master toggle a single check for every caller.
   */
  getActiveIds() {
    return this.isEnabled() ? this.getStoredIds() : [];
  }

  isOnVacation(userId) {
    return this.getActiveIds().includes(userId);
  }

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  /**
   * @param {string} userId
   * @param {boolean} onVacation
   * @returns {boolean} whether anything actually changed
   */
  async set(userId, onVacation) {
    return this.setMany(onVacation ? [userId] : [], onVacation ? [] : [userId]);
  }

  /**
   * Applies additions and removals in one write, so a bulk change emits a single
   * 'change' event and fires the household-wide triggers at most once.
   *
   * @param {string[]} add
   * @param {string[]} remove
   * @returns {boolean} whether anything actually changed
   */
  async setMany(add = [], remove = []) {
    const before = this.getStoredIds();
    const next = new Set(before);

    const added = add.filter((id) => !next.has(id));
    const removed = remove.filter((id) => next.has(id));

    added.forEach((id) => next.add(id));
    removed.forEach((id) => next.delete(id));

    if (added.length === 0 && removed.length === 0) return false;

    await this.homey.settings.set(VACATION_SETTING, [...next]);
    this.emit('change', { added, removed, ids: [...next] });

    return true;
  }

  /**
   * Drops ids of users who no longer exist. Called with the live user list rather
   * than on a timer, so a Homey that is briefly unreachable never wipes anything.
   *
   * @param {string[]} knownUserIds
   */
  async pruneUnknown(knownUserIds) {
    const known = new Set(knownUserIds);
    const stale = this.getStoredIds().filter((id) => !known.has(id));

    if (stale.length === 0) return false;

    return this.setMany([], stale);
  }

}

module.exports = VacationStore;
