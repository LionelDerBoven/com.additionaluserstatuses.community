'use strict';

const EventEmitter = require('node:events');

// How often we re-read the user list. This is the whole mechanism, not a
// fallback: see subscribeRealtime() for why. Measured on a Homey Pro 2023, a
// sleep status change was picked up about six seconds after it happened.
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
 *   'everyone-asleep'      -> ({ id, name }) the last person anywhere to fall asleep
 *   'everyone-home-awake'  -> ({ id, name }) the last person at home to wake up
 *   'everyone-awake'       -> ({ id, name }) the last person anywhere to wake up
 *   'everyone-home'        -> ()             everyone who counts is now at home
 *   'everyone-left'        -> ()             everyone who counts has now gone out
 *   'first-home-asleep'    -> ({ id, name }) the first person at home to fall asleep
 *   'first-home-awake'     -> ({ id, name }) the first person at home to wake up
 *   'someone-home-awake'   -> ({ id, name }) anyone at home waking, once per person
 *   'first-asleep'         -> ({ id, name }) the first person anywhere to fall asleep
 *   'first-awake'          -> ({ id, name }) the first person anywhere to wake up, once
 *                             per night
 *   'arrived'              -> ({ id, name }) a user who was away and is now home
 *   'user-changed'         -> ({ id, name, field, value }) any presence or sleep
 *                             change, for the settings log. Reported raw and
 *                             unfiltered, because the point of the log is to
 *                             explain why a household-level card did or did not
 *                             fire, and that needs the inputs, not the verdict.
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
    this.lastAsleep = null; // Map<userId, boolean>, all users
    this.lastAtHome = null; // Map<userId, boolean>, counted users only
    this.lastAwakeAtHome = null; // Map<userId, boolean>, counted users only
    this.lastAsleepAtHome = null; // Map<userId, boolean>, counted users only
    this.lastEveryoneHomeAsleep = null;
    this.lastEveryoneAsleep = null;
    this.lastEveryoneHome = null;
    this.lastNobodyHome = null;

    // Whether the household-wide wake-up card has already gone off this night.
    // A night opens when the first person falls asleep, which is what keeps the
    // second person to get up quiet - see the 'first-awake' block in check().
    this.wakeReportedThisNight = false;
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
   * Best-effort, and as of Homey firmware 13.3.0 it delivers nothing.
   *
   * Tested 2026-07-29: the subscription registers without error, then no event
   * ever arrives - a real sleep status change produced zero. So the poll is the
   * mechanism here, not a safety net. This is kept because it costs nothing,
   * cannot throw, and will start shortening the latency by itself the day Athom
   * begins emitting on homey:manager:users - the log line below is how you would
   * find out that had happened.
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
    const asleep = new Map(users.map((user) => [user.id, user.asleep === true]));
    const atHome = new Map(counted.map((user) => [user.id, user.present === true]));
    const awakeAtHome = new Map(counted.map((user) => [user.id, user.present && !user.asleep]));
    const asleepAtHome = new Map(counted.map((user) => [user.id, user.present && user.asleep]));
    const awakeCount = counted.filter((user) => user.present && !user.asleep).length;
    const asleepAtHomeCount = counted.filter((user) => user.present && user.asleep).length;
    const asleepCount = counted.filter((user) => user.asleep).length;
    const everyoneHomeAsleep = await this.userStatus.isEveryoneHomeAsleep();
    const everyoneAsleep = await this.userStatus.isEveryoneAsleep();
    const everyoneHome = await this.userStatus.isEveryoneHome();
    const nobodyHome = await this.userStatus.isNobodyHome();

    // How many people *still in the house* were already awake at the last check.
    //
    // Counting everyone who was awake - including someone who has since left -
    // would make the result depend on where the poll boundary happens to fall:
    // an early riser leaving and a sleeper waking is a first rise when the two
    // land in different polls, and would not be when they land in the same one.
    const lastAwakeAmongStillHome = this.lastAwakeAtHome === null
      ? null
      : counted.filter((user) => user.present && this.lastAwakeAtHome.get(user.id) === true).length;

    // The same measure for the other end of the evening: how many people *still
    // in the house* were already asleep. Someone who was asleep here and has
    // since gone out must not keep the first-to-bed card from firing.
    const lastAsleepAmongStillHome = this.lastAsleepAtHome === null
      ? null
      : counted.filter((user) => user.present && this.lastAsleepAtHome.get(user.id) === true).length;

    // How many counted users were asleep anywhere. Presence deliberately plays
    // no part: somebody asleep at a hotel is still a sleeper, and somebody out
    // for the evening is simply not one, so neither can hold the night open.
    const lastAsleepCounted = this.lastAsleep === null
      ? null
      : counted.filter((user) => this.lastAsleep.get(user.id) === true).length;

    if (!silent && this.lastPresent !== null) {
      for (const user of users) {
        const wasPresent = this.lastPresent.get(user.id);
        const wasAsleep = this.lastAsleep.get(user.id);

        // Someone who was away and is now home. Drives auto-return from vacation.
        if (wasPresent === false && user.present === true) {
          this.emit('arrived', { id: user.id, name: user.name });
        }

        // Every raw change, for the log. Compared against a known previous value
        // so a user Homey has only just told us about is not reported as having
        // just changed.
        if (wasPresent !== undefined && wasPresent !== (user.present === true)) {
          this.emit('user-changed', {
            id: user.id, name: user.name, field: 'present', value: user.present === true,
          });
        }
        if (wasAsleep !== undefined && wasAsleep !== (user.asleep === true)) {
          this.emit('user-changed', {
            id: user.id, name: user.name, field: 'asleep', value: user.asleep === true,
          });
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

      // Anyone at home waking, second and third riser included. Emitted per
      // person rather than once for the household, because the card is about a
      // person: it names who, and two people waking in one poll is two events.
      //
      // Homey has a card for this, but it fires for any user anywhere - the
      // housemate asleep at a hotel, the guest account that never says where it
      // is. Requiring that they were asleep *here* is the whole difference, and
      // it is what makes an empty house unable to set it off.
      for (const user of counted) {
        const wasAsleepAtHome = this.lastAsleepAtHome.get(user.id) === true;
        if (wasAsleepAtHome && user.present && !user.asleep) {
          this.emit('someone-home-awake', { id: user.id, name: user.name });
        }
      }

      // The first person at home to fall asleep: nobody in the house was asleep
      // and now somebody is, and at least one of them got there by going to bed.
      //
      // The mirror of the wake-up block above, and it needs the same two guards.
      // Keyed on the count going 0 -> non-zero rather than "exactly one is
      // asleep now", because a couple turning in together lands in one poll. And
      // the sleeper has to have been at home already, or somebody carried home
      // asleep in the back of a car would count as having gone to bed here.
      if (lastAsleepAmongStillHome === 0 && asleepAtHomeCount > 0) {
        const justFellAsleep = counted.filter((user) => {
          const wasAtHome = this.lastAtHome.get(user.id) === true;
          const wasAsleepAtHome = this.lastAsleepAtHome.get(user.id) === true;
          return wasAtHome && !wasAsleepAtHome && user.present && user.asleep;
        });

        if (justFellAsleep.length > 0) {
          // Two turning in inside one poll is one bedtime, not two: report the
          // earlier one rather than invent a tie-break, and fire exactly once.
          const first = justFellAsleep[0];
          this.emit('first-home-asleep', { id: first.id, name: first.name });
        }
      }

      // The first person anywhere to fall asleep. This is also where a night
      // begins for the household-wide wake-up card below.
      if (lastAsleepCounted === 0 && asleepCount > 0) {
        // '=== false' rather than '!== true': a user Homey has only just told us
        // about has no previous value, and has not just fallen asleep.
        const justFellAsleep = counted.filter((user) => this.lastAsleep.get(user.id) === false && user.asleep);

        if (justFellAsleep.length > 0) {
          const first = justFellAsleep[0];
          this.wakeReportedThisNight = false;
          this.emit('first-asleep', { id: first.id, name: first.name });
        }
      }

      // The first person anywhere to wake up.
      //
      // This one cannot use the "nobody was awake" edge the at-home card uses:
      // household-wide that is never true once a single housemate is out for the
      // evening, so the card would sit silent for ever. Instead it closes the
      // night the block above opened and fires for whoever gets up first, once -
      // the second riser finds the night already reported.
      if (lastAsleepCounted > 0 && !this.wakeReportedThisNight) {
        const justWoke = counted.filter((user) => this.lastAsleep.get(user.id) === true && !user.asleep);

        if (justWoke.length > 0) {
          const first = justWoke[0];
          this.wakeReportedThisNight = true;
          this.emit('first-awake', { id: first.id, name: first.name });
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

      // The other end of the night: nobody at home is asleep any more.
      //
      // Keyed on the count of sleepers going non-zero -> zero, not on an edge of
      // everyoneHomeAsleep: that flips the moment the *first* person wakes,
      // which is a different card. It needs the same guard as its mirror, too -
      // the sleeper count also reaches zero when the last sleeper simply leaves
      // the house, and nobody woke up there.
      if (lastAsleepAmongStillHome > 0 && asleepAtHomeCount === 0) {
        const justWoke = counted.filter((user) => {
          const wasAsleepAtHome = this.lastAsleepAtHome.get(user.id) === true;
          return wasAsleepAtHome && user.present && !user.asleep;
        });

        if (justWoke.length > 0) {
          // Two rising within one poll is one morning: report the later one,
          // the mirror of reporting the later of two who fell asleep.
          const last = justWoke[justWoke.length - 1];
          this.emit('everyone-home-awake', { id: last.id, name: last.name });
        }
      }

      // The same, household-wide: nobody who counts is asleep any more.
      if (lastAsleepCounted > 0 && asleepCount === 0) {
        const justWoke = counted.filter((user) => this.lastAsleep.get(user.id) === true && !user.asleep);

        if (justWoke.length > 0) {
          const last = justWoke[justWoke.length - 1];
          this.emit('everyone-awake', { id: last.id, name: last.name });
        }
      }

      // Everyone who counts is now at home, and everyone has now gone out.
      //
      // Homey has "the first person comes home" and "the last person leaves",
      // which are about an empty house. These are about a full one, and they
      // count the household this app was told to count: somebody on vacation or
      // unticked in the settings no longer holds "everyone is home" back.
      //
      // Both need somebody to have actually walked through the door, the same
      // way bedtime needs somebody to have actually fallen asleep. The state
      // flips on its own when the count changes - the last person away comes
      // back from vacation while everyone else is already in, and suddenly
      // "everyone is home" is true although nobody arrived. Firing a welcome
      // scene at a household that never left is exactly the failure 1.3.1 fixed
      // at the other end of the day.
      //
      // No tag either: what made this true is the household reaching a state,
      // and on a poll boundary several people can cross at once.
      if (everyoneHome === true && this.lastEveryoneHome === false) {
        const arrived = counted.some((user) => this.lastPresent.get(user.id) === false && user.present);
        if (arrived) this.emit('everyone-home');
      }
      if (nobodyHome === true && this.lastNobodyHome === false) {
        const left = counted.some((user) => this.lastPresent.get(user.id) === true && !user.present);
        if (left) this.emit('everyone-left');
      }

      // The same bedtime for the whole household, presence and all: everybody
      // counted is now asleep, wherever they are. It needs the same guard - the
      // state also flips when the last awake person is taken out of the count,
      // by going on vacation or being unticked in the settings, and nobody went
      // to bed there.
      if (everyoneAsleep === true && this.lastEveryoneAsleep === false) {
        const justFellAsleep = counted.filter((user) => this.lastAsleep.get(user.id) === false && user.asleep);

        if (justFellAsleep.length > 0) {
          const last = justFellAsleep[justFellAsleep.length - 1];
          this.emit('everyone-asleep', { id: last.id, name: last.name });
        }
      }
    }

    this.lastPresent = present;
    this.lastAsleep = asleep;
    this.lastAtHome = atHome;
    this.lastAwakeAtHome = awakeAtHome;
    this.lastAsleepAtHome = asleepAtHome;
    this.lastEveryoneHomeAsleep = everyoneHomeAsleep;
    this.lastEveryoneAsleep = everyoneAsleep;
    this.lastEveryoneHome = everyoneHome;
    this.lastNobodyHome = nobodyHome;
  }

}

module.exports = UserWatcher;
