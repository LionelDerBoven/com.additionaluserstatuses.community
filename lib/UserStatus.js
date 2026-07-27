'use strict';

// Homey's own user list rarely changes within a single Flow run, but several
// Flows can evaluate in the same instant. A very short cache collapses that
// burst into one API call while staying far too brief to serve a stale
// presence value to a condition card.
const LIST_CACHE_TTL_MS = 2000;

const EXCLUDED_SETTING = 'excluded_user_ids';

/**
 * Reads the live Homey user list and answers the two household-wide questions
 * Homey itself cannot: is everyone home, and is everyone asleep.
 */
class UserStatus {

  /**
   * @param {object} opts
   * @param {import('homey').App['homey']} opts.homey
   * @param {() => Promise<object>} opts.getApi Resolves to a HomeyAPI instance.
   */
  constructor({ homey, getApi }) {
    this.homey = homey;
    this.getApi = getApi;
    this.cache = null;
    this.cachedAt = 0;
    this.pending = null;
  }

  // ---------------------------------------------------------------------------
  // Reading users
  // ---------------------------------------------------------------------------

  /**
   * Every Homey user, as plain objects, newest read at most LIST_CACHE_TTL_MS old.
   */
  async fetchUsers() {
    if (this.cache && Date.now() - this.cachedAt < LIST_CACHE_TTL_MS) {
      return this.cache;
    }

    // Both cards evaluating in the same Flow is the normal case, and they arrive
    // together. Sharing the in-flight promise - not just the settled result - is
    // what actually collapses that burst into a single API call.
    if (!this.pending) {
      this.pending = this.readUsers()
        .then((users) => {
          this.cache = users;
          this.cachedAt = Date.now();
          return users;
        })
        .finally(() => {
          // A failed read is not cached, so the next evaluation retries.
          this.pending = null;
        });
    }

    return this.pending;
  }

  async readUsers() {
    const api = await this.getApi();
    const users = await api.users.getUsers();

    // getUsers() resolves to an id-keyed object of User instances. Flatten it to
    // plain data so nothing downstream depends on the API's own class shape.
    return Object.values(users).map((user) => ({
      id: user.id,
      name: user.name || this.homey.__('unnamed_user'),
      role: user.role || 'user',
      enabled: user.enabled !== false,
      present: user.present === true,
      asleep: user.asleep === true,
      // Homey leaves these null until a status is set for the first time. We keep
      // the distinction so the settings page can explain an unexpected 'false'.
      presenceKnown: user.present !== null && user.present !== undefined,
      sleepKnown: user.asleep !== null && user.asleep !== undefined,
    }));
  }

  /**
   * Drops the excluded ids from the settings, then any disabled account.
   */
  getExcludedIds() {
    const stored = this.homey.settings.get(EXCLUDED_SETTING);
    return Array.isArray(stored) ? stored : [];
  }

  /**
   * The users the 'everyone' cards actually look at.
   */
  async getCountedUsers() {
    const excluded = new Set(this.getExcludedIds());

    // A disabled account can never come home or go to sleep, so counting one
    // would deadlock both cards at false forever. Excluded regardless of settings.
    return (await this.fetchUsers())
      .filter((user) => user.enabled)
      .filter((user) => !excluded.has(user.id));
  }

  // ---------------------------------------------------------------------------
  // The two questions
  // ---------------------------------------------------------------------------

  async isEveryoneHome() {
    return this.evaluate('present');
  }

  async isEveryoneAsleep() {
    return this.evaluate('asleep');
  }

  /**
   * @param {'present'|'asleep'} field
   */
  async evaluate(field) {
    const counted = await this.getCountedUsers();

    // 'Every member of an empty set' is vacuously true, which is exactly the
    // wrong answer here: a misconfigured app would silently fire "everyone is
    // asleep" automations in an empty house. Fail closed and say why.
    if (counted.length === 0) {
      this.homey.app.log(
        `No users are being counted, so the '${field}' condition returns false. `
        + 'Check the app settings: every user may be switched off, or disabled in Homey.',
      );
      return false;
    }

    // Strict true: a user whose status Homey has never been told is not someone
    // we can claim is home or asleep.
    return counted.every((user) => user[field] === true);
  }

  // ---------------------------------------------------------------------------
  // Settings page support
  // ---------------------------------------------------------------------------

  /**
   * Everything the settings page needs in one round trip: the full user list
   * with a counted flag, plus what the cards would answer right now.
   */
  async getOverview() {
    const excluded = new Set(this.getExcludedIds());
    const users = (await this.fetchUsers())
      .map((user) => ({
        ...user,
        counted: user.enabled && !excluded.has(user.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const counted = users.filter((user) => user.counted);

    return {
      users,
      countedCount: counted.length,
      everyoneHome: counted.length > 0 && counted.every((user) => user.present),
      everyoneAsleep: counted.length > 0 && counted.every((user) => user.asleep),
    };
  }

}

module.exports = UserStatus;
