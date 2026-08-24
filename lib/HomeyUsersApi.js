'use strict';

const http = require('node:http');

// Homey hands out an owner API token that expires after roughly two weeks of
// non-use. Rather than track that clock, we keep using a token until a request
// comes back unauthorised and then fetch a fresh one exactly once.
const UNAUTHORISED = new Set([401, 403]);

const USERS_PATH = '/api/manager/users/user';

// A card evaluation that cannot finish is worse than one that fails: Homey would
// sit waiting on it.
//
// Two seconds, not the ten this used to be. A healthy answer takes 8-15 ms, so
// two seconds is already a hundredfold margin, and the old value was reached in
// two places where waiting that long is worse than giving up: the watcher polls
// every second, and an unauthorised reply retries once - which put the worst
// case for a condition card at ten seconds plus ten more, with the Flow that
// asked the question stopped dead for both.
const REQUEST_TIMEOUT_MS = 2000;

// The timeout above is an *idle* timer, so a source dribbling a byte every nine
// seconds would hold the request open and grow the buffer for ever. A household
// user list is a few kilobytes; half a megabyte is far past anything real.
const MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * A deliberately tiny client for the one Homey Web API endpoint this app needs.
 *
 * Two libraries were rejected on memory grounds, both measured on the Homey Pro
 * rather than guessed at:
 *
 *  - the official `homey-api` package pulls in socket.io for realtime events
 *    this app never subscribes to (measured +7.4 MB, and 686 files of archive);
 *  - Node's global `fetch` is undici, whose connection pools and native buffers
 *    cost far more than the V8 heap suggests.
 *
 * node:http is already resident in every Homey app, and the request below is a
 * plain unencrypted GET to loopback, so none of what undici adds is any use
 * here. `agent: false` keeps it honest: no pooled sockets kept alive between
 * the occasional Flow evaluation.
 *
 * Exposes the same `users.getUsers()` shape as `homey-api` so the calling code
 * does not care which of the three it is talking to.
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

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Homey returned ${res.status} for the user list`);
    }

    let body;
    try {
      body = JSON.parse(res.body);
    } catch (err) {
      // Deliberately without err.message: V8 embeds a fragment of the offending
      // input in a SyntaxError, and the input here is the user list, so the
      // household's names would ride into the event log and possibly into
      // Homey's storage with it.
      throw new Error('Homey sent an unreadable user list');
    }

    // Homey answers either bare or wrapped in { result }, depending on version.
    return body?.result ?? body ?? {};
  }

  /**
   * @returns {Promise<{status: number, body: string}>}
   */
  async request() {
    const { token, baseUrl } = await this.getSession();
    const url = new URL(USERS_PATH, baseUrl);

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'GET',
        // getOwnerApiToken() returns a bare token with no scheme. Homey rejects
        // it as "Invalid Session" unless it is presented as a Bearer credential.
        headers: { Authorization: `Bearer ${token}` },
        agent: false,
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;

          if (body.length > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('Homey sent an implausibly large user list'));
          }
        });
        // Without this, a response cut off mid-body leaves the promise pending
        // until the idle timer fires, holding a poll open for ten seconds.
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Homey closed the connection early')));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });

      req.on('timeout', () => {
        // 'timeout' only fires the idle timer; the socket has to be closed by
        // hand or the request hangs on for ever.
        req.destroy(new Error(`Homey did not answer within ${REQUEST_TIMEOUT_MS}ms`));
      });
      req.on('error', reject);
      req.end();
    });
  }

}

module.exports = HomeyUsersApi;
