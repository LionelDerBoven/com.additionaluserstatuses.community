'use strict';

const EventEmitter = require('node:events');

// How often we re-read the user list when nothing has told us to. Homey's own
// realtime channel, when it works, prompts an immediate check on top of this, so
// this interval is the floor on how stale a trigger can be, not the usual case.
const POLL_INTERVAL_MS = 15000;

// Realtime events arrive in bursts - Homey often emits several for one user
// action - so a check is deferred briefly and collapses the burst into one read.
const SETTLE_MS = 250;

/**
 * Watches Homey's users for the transitions the trigger cards need.
 *
 * v1.0 of this app was purely pull-based: conditions were asked a question and
 * answered it. Triggers have to notice a change instead, which needs something
 * watching. The obvious route - the homey-api package's socket.io realtime feed -
 * is the 13.4 MB we deliberately removed, so this uses the SDK's own realtime
 * channel where available and falls back to polling, which costs one loopback
 * GET and no memory worth measuring.
 *
 * Emits:
 *   'everyone-home-asleep' -> fired once when the last person at home falls asleep
 *   'arrived'              -> ({ id, name }) a user who was away and is now home
 */
class UserWatcher extends EventEmitter {

  /**
   * @param {object} opts
   * @param {import('homey').App['homey']} opts.homey
   * @param {import('./UserStatus')} opts.userStatus
   */
  constructor({ homey, userStatus }) {
    super();
    this.homey = homey;
    this.userStatus = userStatus;

    this.lastPresent = null; // Map<userId, boolean>, null until first read
    this.lastEveryoneHomeAsleep = null;
    this.sawRealtime = false;
    this.settleTimer = null;
    this.pollTimer = null;
  }

  async start() {
    this.subscribeRealtime();

    // Seed the snapshot before any triggers can fire, so starting the app does
    // not look like "everybody just fell asleep" and set off bedtime Flows.
    await this.check({ silent: true });

    this.pollTimer = this.homey.setInterval(() => {
      this.check().catch((err) => this.homey.app.error(`Watcher poll failed: ${err.message}`));
    }, POLL_INTERVAL_MS);
  }

  stop() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    if (this.settleTimer) this.homey.clearTimeout(this.settleTimer);
    this.pollTimer = null;
    this.settleTimer = null;
  }

  /**
   * Best-effort: if Homey gives us realtime user events we react at once, and if
   * it does not, the poll below still covers everything. Either way this must not
   * be allowed to throw and take the app down with it.
   */
  subscribeRealtime() {
    try {
      const api = this.homey.api.getApi('homey:manager:users');
      api.on('realtime', () => {
        if (!this.sawRealtime) {
          this.sawRealtime = true;
          this.homey.app.log('Realtime user events are available; triggers will fire immediately.');
        }
        this.scheduleCheck();
      });
    } catch (err) {
      this.homey.app.log(`Realtime user events unavailable (${err.message}); polling every ${POLL_INTERVAL_MS / 1000}s.`);
    }
  }

  scheduleCheck() {
    if (this.settleTimer) return;

    this.settleTimer = this.homey.setTimeout(() => {
      this.settleTimer = null;
      this.check().catch((err) => this.homey.app.error(`Watcher check failed: ${err.message}`));
    }, SETTLE_MS);
  }

  /**
   * One pass: read the users, work out what changed, announce it.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.silent] Seed the snapshot without emitting anything.
   */
  async check({ silent = false } = {}) {
    const users = await this.userStatus.fetchUsers();

    const present = new Map(users.map((user) => [user.id, user.present === true]));
    const everyoneHomeAsleep = await this.userStatus.isEveryoneHomeAsleep();

    if (!silent && this.lastPresent !== null) {
      // Someone who was away and is now home. Used for auto-return from vacation.
      for (const user of users) {
        const wasPresent = this.lastPresent.get(user.id);
        if (wasPresent === false && user.present === true) {
          this.emit('arrived', { id: user.id, name: user.name });
        }
      }

      // Edge, not level: fire on the transition into the state, so a Flow runs
      // once at bedtime rather than every fifteen seconds all night.
      if (everyoneHomeAsleep === true && this.lastEveryoneHomeAsleep === false) {
        this.emit('everyone-home-asleep');
      }
    }

    this.lastPresent = present;
    this.lastEveryoneHomeAsleep = everyoneHomeAsleep;
  }

}

module.exports = UserWatcher;
