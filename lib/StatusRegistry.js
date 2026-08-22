'use strict';

const EventEmitter = require('node:events');

const StatusStore = require('./StatusStore');

const CUSTOM_SETTING = 'custom_statuses';

// Ids reserved for the two statuses this app ships. A custom status may not take
// them, because vacation's id is wired to a settings key that predates all this.
const VACATION = 'vacation';
const DND = 'dnd';

// Homey's own ids are lowercase and dashless, and a status id becomes part of a
// settings key, so keep it to something that can never need escaping.
const ID_PATTERN = /^[a-z0-9_]{1,32}$/;

const MAX_CUSTOM = 20;

// A status name is free text from the settings page, and the page is reachable
// by any Homey user of this Homey. Unbounded, it persists across restarts, is
// served back to the page, and becomes a Flow tag value - so it is capped on
// write, and again on read, because the setting can be written directly.
const MAX_NAME = 64;

/**
 * Every status a user can hold, built in or invented here.
 *
 * The app started with vacation alone, and its cards, device and settings key
 * are in people's Flows. So vacation is not special-cased away: it is the first
 * entry in this registry, still backed by its original store and settings key,
 * and the generic cards reach it through the same interface as any other status.
 *
 * A status is: an id, a name to show, where its members are stored, whether
 * holding it takes you out of the 'everyone' cards, and whether coming home
 * clears it.
 *
 * Emits:
 *   'statuses-changed' -> () a status was added, renamed or removed
 */
class StatusRegistry extends EventEmitter {

  /**
   * @param {object} opts
   * @param {import('homey').App['homey']} opts.homey
   * @param {import('./VacationStore')} opts.vacation The existing vacation store.
   */
  constructor({ homey, vacation }) {
    super();
    this.homey = homey;
    this.vacation = vacation;
    this.stores = new Map([[VACATION, vacation]]);
  }

  // ---------------------------------------------------------------------------
  // Definitions
  // ---------------------------------------------------------------------------

  /** The statuses the user defined, ignoring anything of the wrong shape. */
  getCustom() {
    const stored = this.homey.settings.get(CUSTOM_SETTING);
    if (!Array.isArray(stored)) return [];

    return stored
      .slice(0, MAX_CUSTOM)
      .filter((entry) => entry && ID_PATTERN.test(entry.id) && typeof entry.name === 'string')
      .filter((entry) => entry.id !== VACATION && entry.id !== DND)
      .map((entry) => ({
        id: entry.id,
        // Trimmed here as well as on write: the settings page can write this
        // key directly, so saveCustom() is not the only way in.
        name: entry.name.slice(0, MAX_NAME),
        builtin: false,
        excludeFromEveryone: entry.excludeFromEveryone === true,
        autoReturn: entry.autoReturn === true,
      }));
  }

  /**
   * Every status, built in first.
   *
   * Vacation excludes its holders from the 'everyone' cards and that is not
   * negotiable - it is the behaviour those cards have had since 1.1.0, and Flows
   * depend on it. Do-not-disturb deliberately does not: it says something about
   * how to treat a person, not about whether they are part of the household.
   */
  list() {
    return [
      {
        id: VACATION,
        name: this.homey.__('status.vacation'),
        builtin: true,
        excludeFromEveryone: true,
        autoReturn: this.vacation.isAutoReturnEnabled(),
      },
      {
        id: DND,
        name: this.homey.__('status.dnd'),
        builtin: true,
        excludeFromEveryone: false,
        autoReturn: false,
      },
      ...this.getCustom(),
    ];
  }

  get(id) {
    return this.list().find((status) => status.id === id) || null;
  }

  /**
   * The store holding one status's members, created on first use.
   *
   * Vacation's was handed in; every other status gets a key derived from its id.
   * Returns null for a status that does not exist, so a Flow card pointing at a
   * status the user has since deleted fails loudly rather than writing into a
   * settings key nobody reads.
   */
  store(id) {
    if (!this.get(id)) return null;
    if (this.stores.has(id)) return this.stores.get(id);

    const store = new StatusStore({ homey: this.homey, settingKey: `status_${id}_user_ids` });
    this.stores.set(id, store);

    return store;
  }

  /** Every store that has been asked for, plus vacation. */
  allStores() {
    return this.list().map((status) => this.store(status.id)).filter(Boolean);
  }

  // ---------------------------------------------------------------------------
  // Questions the cards ask
  // ---------------------------------------------------------------------------

  has(statusId, userId) {
    const store = this.store(statusId);
    return store ? store.has(userId) : false;
  }

  /** The users to leave out of the 'everyone' cards, from every status that says so. */
  excludedUserIds() {
    const ids = new Set();

    for (const status of this.list()) {
      if (!status.excludeFromEveryone) continue;

      const store = this.store(status.id);
      if (store) store.getIds().forEach((id) => ids.add(id));
    }

    return ids;
  }

  /** The statuses that clear themselves when Homey sees the user come home. */
  autoReturning() {
    return this.list().filter((status) => status.autoReturn);
  }

  // ---------------------------------------------------------------------------
  // Editing the custom ones
  // ---------------------------------------------------------------------------

  /**
   * Replaces the set of custom statuses in one write.
   *
   * The settings page edits a list, not one status at a time, so this takes the
   * whole list. Members of a status that disappears are forgotten with it -
   * leaving them behind would mean a status the user deleted silently coming
   * back with its old holders if they ever reused the id.
   *
   * @param {Array<{id: string, name: string, excludeFromEveryone?: boolean, autoReturn?: boolean}>} wanted
   */
  async saveCustom(wanted) {
    if (!Array.isArray(wanted)) throw new Error('Statuses must be a list.');
    if (wanted.length > MAX_CUSTOM) throw new Error(`At most ${MAX_CUSTOM} custom statuses.`);

    const seen = new Set();
    const cleaned = wanted.map((entry) => {
      const id = String(entry?.id || '').trim().toLowerCase();
      const name = String(entry?.name || '').trim();

      if (!ID_PATTERN.test(id)) throw new Error(`'${id}' is not a usable status id.`);
      if (id === VACATION || id === DND) throw new Error(`'${id}' is already a built-in status.`);
      if (seen.has(id)) throw new Error(`'${id}' is listed twice.`);
      if (!name) throw new Error(`The status '${id}' needs a name.`);
      if (name.length > MAX_NAME) throw new Error(`The name for '${id}' is too long.`);

      seen.add(id);

      return {
        id,
        name,
        excludeFromEveryone: entry.excludeFromEveryone === true,
        autoReturn: entry.autoReturn === true,
      };
    });

    const gone = this.getCustom().filter((status) => !seen.has(status.id));

    await this.homey.settings.set(CUSTOM_SETTING, cleaned);

    for (const status of gone) {
      const store = this.stores.get(status.id) || new StatusStore({
        homey: this.homey, settingKey: `status_${status.id}_user_ids`,
      });

      await store.forget();
      this.stores.delete(status.id);
    }

    this.emit('statuses-changed');

    return this.list();
  }

}

module.exports = StatusRegistry;
module.exports.VACATION = VACATION;
module.exports.DND = DND;
module.exports.ID_PATTERN = ID_PATTERN;
