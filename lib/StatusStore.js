'use strict';

const EventEmitter = require('node:events');

/**
 * Which users hold one status.
 *
 * Homey has no concept of a user status beyond home and asleep, so every status
 * this app adds is entirely ours and lives in app settings. Settings rather than
 * device store is deliberate: a status has to work for users who have no paired
 * device, and a single source of truth is what stops the settings page, a Flow,
 * a device tile and auto-return from drifting apart. Devices subscribe to
 * 'change' and follow.
 *
 * One instance per status, each with its own settings key. Vacation keeps the
 * key it has always had, so upgrading changes nothing on disk.
 *
 * Emits:
 *   'change' -> { added: string[], removed: string[], ids: string[] }
 */
class StatusStore extends EventEmitter {

  /**
   * @param {object} opts
   * @param {import('homey').App['homey']} opts.homey
   * @param {string} opts.settingKey Where this status keeps its user ids.
   */
  constructor({ homey, settingKey }) {
    super();
    this.homey = homey;
    this.settingKey = settingKey;

    // Writes are read-modify-write against a settings store whose set() is
    // genuinely asynchronous. Two landing together - a Flow and a device tile,
    // say - would both read the old list and the second would silently drop the
    // first's change. Chaining them makes each read what the last one wrote.
    this.writes = Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /**
   * The ids of everyone who currently holds this status.
   *
   * There is deliberately no master on/off switch per status: nobody holding it
   * already means every card about it reads false and nothing is excluded from
   * the 'everyone' cards, so a toggle would only add a second way to express the
   * same thing.
   */
  getIds() {
    const stored = this.homey.settings.get(this.settingKey);
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [];
  }

  has(userId) {
    return this.getIds().includes(userId);
  }

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  /**
   * @param {string} userId
   * @param {boolean} held
   * @returns {Promise<boolean>} whether anything actually changed
   */
  async set(userId, held) {
    return this.setMany(held ? [userId] : [], held ? [] : [userId]);
  }

  /**
   * Applies additions and removals in one write, so a bulk change emits a single
   * 'change' event and fires the household-wide triggers at most once.
   *
   * @param {string[]} add
   * @param {string[]} remove
   * @returns {Promise<boolean>} whether anything actually changed
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

    await this.homey.settings.set(this.settingKey, [...next]);
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

  /** Forgets the whole status, for a custom one the user deletes. */
  async forget() {
    await this.homey.settings.unset(this.settingKey);
  }

}

module.exports = StatusStore;
