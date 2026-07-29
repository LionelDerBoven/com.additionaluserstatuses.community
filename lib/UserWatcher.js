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
 *   'everyone-home-asleep' -> ({ id, name }) the last person at home to fall asleep
 *   'first-home-awake'     -> ({ id, name }) the first person at home to wake up
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
    this.lastAtHome = null; // Map<userId, boolean>, counted users only
    this.lastAwakeAtHome = null; // Map<userId, boolean>, counted users only
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
    // Arrivals are read from the full list, because auto-return has to notice a
    // user coming home *while on vacation* - and vacation users are precisely
    // the ones getCountedUsers() leaves out.
    const users = await this.userStatus.fetchUsers();
    const counted = await this.userStatus.getCountedUsers();

    const present = new Map(users.map((user) => [user.id, user.present === true]));
    const atHome = new Map(counted.map((user) => [user.id, user.present === true]));
    const awakeAtHome = new Map(counted.map((user) => [user.id, user.present && !user.asleep]));
    const awakeCount = counted.filter((user) => user.present && !user.asleep).length;
    const everyoneHomeAsleep = await this.userStatus.isEveryoneHomeAsleep();

    // How many people *still in the house* were already awake at the last check.
    //
    // Counting everyone who was awake - including someone who has since left -
    // would make the result depend on where the poll boundary happens to fall:
    // an early riser leaving and a sleeper waking is a first rise when the two
    // land in different polls, and would not be when they land in the same one.
    const lastAwakeAmongStillHome = this.lastAwakeAtHome === null
      ? null
      : counted.filter((user) => user.present && this.lastAwakeAtHome.get(user.id) === true).length;

    if (!silent && this.lastPresent !== null) {
      // Someone who was away and is now home. Used for auto-return from vacation.
      for (const user of users) {
        const wasPresent = this.lastPresent.get(user.id);
        if (wasPresent === false && user.present === true) {
          this.emit('arrived', { id: user.id, name: user.name });
        }
      }

      // The first person at home to wake up: the house goes from nobody awake to
      // somebody awake, and at least one of them got there by waking up.
      //
      // Keyed on the count going 0 -> non-zero rather than "exactly one is awake
      // now", because one alarm can wake two people inside a single poll - and
      // "exactly one" would then be false and the Flow would never run. It also
      // must not be a plain edge on "everyone at home is asleep": somebody
      // arriving home awake flips that too without anyone having woken.
      if (lastAwakeAmongStillHome === 0 && awakeCount > 0) {
        const justWoke = counted.filter((user) => {
          const wasAtHome = this.lastAtHome.get(user.id) === true;
          const wasAwakeAtHome = this.lastAwakeAtHome.get(user.id) === true;
          return wasAtHome && !wasAwakeAtHome && user.present && !user.asleep;
        });

        if (justWoke.length > 0) {
          // Two people waking inside one poll is one morning, not two. Either is
          // defensibly "first"; report the earlier one rather than invent a
          // tie-break, and fire exactly once.
          this.emit('first-home-awake', { id: justWoke[0].id, name: justWoke[0].name });
        }
      }

      // Edge, not level: fire on the transition into the state, so a Flow runs
      // once at bedtime rather than every fifteen seconds all night.
      if (everyoneHomeAsleep === true && this.lastEveryoneHomeAsleep === false) {
        // ...and somebody must actually have fallen asleep. The state also flips
        // when the last awake person simply goes out, leaving a sleeping house
        // behind - nobody went to bed there, so that must stay silent.
        const justFellAsleep = counted.filter((user) => {
          const wasAwakeAtHome = this.lastAwakeAtHome.get(user.id) === true;
          return wasAwakeAtHome && user.present && user.asleep;
        });

        if (justFellAsleep.length > 0) {
          // If two nodded off within one poll, either is defensibly "the last";
          // report the later one in the list rather than inventing a tie-break.
          const last = justFellAsleep[justFellAsleep.length - 1];
          this.emit('everyone-home-asleep', { id: last.id, name: last.name });
        }
      }
    }

    this.lastPresent = present;
    this.lastAtHome = atHome;
    this.lastAwakeAtHome = awakeAtHome;
    this.lastEveryoneHomeAsleep = everyoneHomeAsleep;
  }

}

module.exports = UserWatcher;
