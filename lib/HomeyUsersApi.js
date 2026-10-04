'use strict';

const http = require('node:http');

// Homey hands out an owner API token that expires after roughly two weeks of
// non-use. Rather than track that clock, we keep using a token until a request
// comes back unauthorised and then fetch a fresh one exactly once.
const UNAUTHORISED = new Set([401, 403]);

const USERS_PATH = '/api/manager/users/user';

// One socket, held open between reads.
//
// This used to be `agent: false`, a fresh TCP connection per request. At one
// read a second that is 86,400 connections a day, and measured against a
// keep-alive agent it costs 32% more CPU per poll on the client alone - plus
// the same work again inside Homey core, which has to accept and tear down
// every one of them, and which is left holding the TIME_WAIT sockets because
// `Connection: close` makes the server the side that closes.
//
// It saves no measurable memory; the reason is CPU and the load on Homey. The
// one thing it introduces is the reused-socket race - the server hanging up in
// the window between picking a pooled socket and the write landing - which
// surfaces as ECONNRESET with `req.reusedSocket` true, and which Node does not
// retry for you. request() does, once. Forced testing produced that error in
// 37% of requests against a server closing 0-2 ms after answering, and zero in
// any realistic shape, including a server idle timeout shorter than the poll.
// maxSockets is 2, not 1: a caller demanding a fresh read may overlap a read
// already in flight, and with a single socket the fresh one would queue behind
// exactly the stale read it exists to avoid waiting for. Only one is ever kept
// idle.
const agent = new http.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 1 });

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
 * here. What it does keep is one pooled socket - see the agent above; the
 * watcher reads once a second, so the connection is never idle for long.
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
    if (this.session === null) {
      const session = Promise.all([
        this.homey.api.getOwnerApiToken(),
        this.homey.api.getLocalUrl(),
      ])
        .then(([token, baseUrl]) => ({ token, baseUrl }))
        .catch((err) => {
          // Not cached, so the next call retries rather than failing forever -
          // but only if this is still the session everyone is waiting on. A
          // late rejection must not throw away a newer one that is already in
          // flight, or the next read pays for a token fetch it did not need.
          if (this.session === session) this.session = null;
          throw new Error(this.homey.__('error.api_session', { message: err.message }));
        });

      this.session = session;
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
      throw new Error(this.homey.__('error.api_status', { status: res.status }));
    }

    let body;
    try {
      body = JSON.parse(res.body);
    } catch (err) {
      // Deliberately without err.message: V8 embeds a fragment of the offending
      // input in a SyntaxError, and the input here is the user list, so the
      // household's names would ride into the event log and possibly into
      // Homey's storage with it.
      throw new Error(this.homey.__('error.api_unreadable'));
    }

    // Homey answers either bare or wrapped in { result }, depending on version.
    return body?.result ?? body ?? {};
  }

  /**
   * One GET, retried once if a pooled socket died under us.
   *
   * @param {boolean} [isRetry]
   * @returns {Promise<{status: number, body: string}>}
   */
  async request(isRetry = false) {
    try {
      return await this.attempt();
    } catch (err) {
      // Only this exact shape, and only once: the socket came from the pool and
      // the server had already closed it. A fresh connection cannot hit it, so
      // a retry that fails the same way is a real fault and must surface.
      if (isRetry || err.code !== 'ECONNRESET' || err.reusedSocket !== true) throw err;

      return this.attempt(true);
    }
  }

  /**
   * @returns {Promise<{status: number, body: string}>}
   */
  async attempt() {
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
        agent,
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;

          if (body.length > MAX_RESPONSE_BYTES) {
            req.destroy(new Error(this.homey.__('error.api_unreadable')));
          }
        });
        // Without this, a response cut off mid-body leaves the promise pending
        // until the idle timer fires, holding a poll open for the whole timeout.
        res.on('error', reject);
        res.on('aborted', () => reject(new Error(this.homey.__('error.api_closed'))));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });

      req.on('timeout', () => {
        // 'timeout' only fires the idle timer; the socket has to be closed by
        // hand or the request hangs on for ever.
        req.destroy(new Error(this.homey.__('error.api_timeout')));
      });
      req.on('error', (err) => {
        // Carried on the error so request() can tell the pooled-socket race
        // apart from a Homey that is genuinely unreachable.
        err.reusedSocket = req.reusedSocket === true;
        reject(err);
      });
      req.end();
    });
  }

}

module.exports = HomeyUsersApi;
