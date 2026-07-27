'use strict';

// Homey hands out an owner API token that expires after roughly two weeks of
// non-use. Rather than track that clock, we keep using a token until a request
// comes back unauthorised and then fetch a fresh one exactly once.
const UNAUTHORISED = new Set([401, 403]);

const USERS_PATH = '/api/manager/users/user';

/**
 * A deliberately tiny client for the one Homey Web API endpoint this app needs.
 *
 * The obvious alternative is the official `homey-api` package, which is a fine
 * library but drags in socket.io for realtime events this app never subscribes
 * to. Since we make exactly one read-only GET, the whole dependency reduces to
 * the request below.
 *
 * Exposes the same `users.getUsers()` shape as `homey-api` so the calling code
 * does not care which of the two it is talking to.
 */
class HomeyUsersApi {

  /**
   * @param {object} opts
   * @param {import('homey').App['homey']} opts.homey
   */
  constructor({ homey }) {
    this.homey = homey;
    this.session = null;

    // Matches homey-api's shape, so UserStatus is agnostic about the source.
    this.users = { getUsers: () => this.getUsers() };
  }

  /**
   * Cached token plus base URL. Both come from ManagerApi and need the
   * homey:manager:api permission.
   */
  async getSession() {
    if (!this.session) {
      this.session = Promise.all([
        this.homey.api.getOwnerApiToken(),
        this.homey.api.getLocalUrl(),
      ])
        .then(([token, baseUrl]) => ({ token, baseUrl }))
        .catch((err) => {
          // Not cached, so the next call retries rather than failing forever.
          this.session = null;
          throw new Error(`Could not start a Homey API session: ${err.message}`);
        });
    }

    return this.session;
  }

  /**
   * @returns {Promise<Object<string, object>>} id-keyed users, as homey-api returns.
   */
  async getUsers() {
    let res = await this.request();

    if (UNAUTHORISED.has(res.status)) {
      // Most likely an expired token. Drop it and try once with a fresh one.
      this.session = null;
      res = await this.request();
    }

    if (!res.ok) {
      throw new Error(`Homey returned ${res.status} ${res.statusText} for the user list`);
    }

    const body = await res.json();

    // Homey answers either bare or wrapped in { result }, depending on version.
    return body?.result ?? body ?? {};
  }

  async request() {
    const { token, baseUrl } = await this.getSession();

    return fetch(`${baseUrl}${USERS_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

}

module.exports = HomeyUsersApi;
