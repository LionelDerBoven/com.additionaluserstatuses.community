'use strict';

const EventEmitter = require('node:events');

const VACATION_SETTING = 'vacation_user_ids';
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

    // Writes are read-modify-write against a settings store whose set() is
    // genuinely asynchronous. Two landing together - a Flow and a device tile,
    // say - would both read the old list and the second would silently drop the
    // first's change. Chaining them makes each read what the last one wrote.
    this.writes = Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /** Defaults to on, so a fresh install behaves as the store description says. */
  isAutoReturnEnabled() {
    return this.homey.settings.get(AUTO_RETURN_SETTING) !== false;
  }

  /**
   * The ids of everyone currently on vacation.
   *
   * There is deliberately no master on/off switch for the feature: nobody on
   * vacation already means every vacation card reads false and nothing is
   * excluded from the 'everyone' cards, so a toggle would only add a second way
   * to express the same thing.
   */
  getIds() {
    const stored = this.homey.settings.get(VACATION_SETTING);
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [];
  }

  isOnVacation(userId) {
    return this.getIds().includes(userId);
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
    const run = () => this.applyMany(add, remove);

    // Queued whether or not the previous write succeeded: one failure must not
    // wedge every later change.
    this.writes = this.writes.then(run, run);

    return this.writes;
  }

  /**
   * The actual read-modify-write. Only ever called from the queue in setMany.
   *
   * @param {string[]} add
   * @param {string[]} remove
   * @returns {Promise<boolean>} whether anything actually changed
   */
  async applyMany(add, remove) {
    const before = this.getIds();
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
    const stale = this.getIds().filter((id) => !known.has(id));

    if (stale.length === 0) return false;

    return this.setMany([], stale);
  }

}

module.exports = VacationStore;
