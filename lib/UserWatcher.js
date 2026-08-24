'use strict';

const EventEmitter = require('node:events');

// How often we re-read the user list. This is the whole mechanism, and there is
// no push channel to fall back on - see the class comment for what was tested.
//
// It is therefore the app's entire response time: a card fires on average half
// an interval after the person actually moved, and one interval at worst. At
// the old fifteen seconds that was measured at 11.4 s and 12.4 s behind Homey's
// own equivalent cards on this Homey; at one second it is a fifth of a second
// on average.
//
// One second is affordable because the read is small: /api/manager/users/user
// is 4.2 KB for a three-person household and answers in 8-15 ms, so the poll
// occupies roughly one percent of one of the four cores. Going faster buys
// little a house can feel and multiplies that figure, so this is the floor
// worth having rather than the lowest number that works.
const POLL_INTERVAL_MS = 1000;

// How often at most to complain that a pass is overrunning the interval, or
// that the reads are failing. Whatever breaks one pass tends to break the next
// sixty, and at one pass a second an unthrottled line is 3600 an hour.
const SLOW_REPORT_INTERVAL_MS = 60000;

// How long an arrival stays 'recent' for the guards that ask whether somebody
// actually walked through a door. Generous: the gap it exists to bridge is one
// or two passes, so seconds, not minutes.
const ARRIVAL_MEMORY_MS = 60000;

// After this many failed reads in a row, stop trying every second. A Homey that
// is rebooting, or has started refusing the user list outright, is not going to
// be talked round by asking 3600 times an hour - and each refusal on the
// unauthorised path costs a fresh owner API session. Backs off to at most
// MAX_BACKOFF_MS and drops straight back to the full rate on the first success,
// so a blip costs nothing and a real outage costs nothing either.
const FAILURES_BEFORE_BACKOFF = 3;
const MAX_BACKOFF_MS = 30000;

/**
 * Watches Homey's users for the transitions the trigger cards need.
 *
 * v1.0 of this app was purely pull-based: conditions were asked a question and
 * answered it. Triggers have to notice a change instead, which needs something
 * watching - and on presence and sleep, the Apps SDK offers an app nothing to
 * watch with. Polling is not this class's preference, it is the only mechanism
 * that exists.
 *
 * Established on firmware 13.4.1, 2026-08-24, by logging every event that
 * arrived on each channel rather than trusting the documentation:
 *
 *  - `this.homey.presence` and `this.homey.users` do not exist. The managers the
 *    SDK hands an app are api, app, apps, arp, audio, ble, clock, cloud,
 *    dashboards, dir, discovery, drivers, env, flow, geolocation, i18n, images,
 *    insights, ledring, manifest, nfc, notifications, platform, rf, settings,
 *    speechInput, speechOutput, videos, zigbee and zwave. Presence is not among
 *    them, and there is no permission that adds it.
 *  - `homey.api.getApi()` registers without complaint on homey:manager:presence,
 *    homey:manager:users and homey:manager:api, and `hasApi()` answers false for
 *    all three. A real sleep change produced not one event on any of them, with
 *    `emit` itself wrapped so that an event under any name would have shown up.
 *
 * That leaves one loopback GET on a timer, which costs no memory worth measuring
 * and a percent of a core. The homey-api package would bring a socket.io feed
 * with it, but it is the 13.4 MB this app deliberately removed - and it is the
 * Web API client, not the Apps SDK, so it would be a second session against the
 * same Homey rather than a channel the app is entitled to.
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
 *   'first-arrived'        -> ({ id, name }) the first person into an empty house
 *   'user-left'            -> ({ id, name }) one user, out
 *   'user-arrived'         -> ({ id, name }) one user, home
 *   'user-asleep'          -> ({ id, name }) one user, asleep
 *   'user-awake'           -> ({ id, name }) one user, awake
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

    // Who has walked through the door but did not count yet when they did.
    //
    // Coming home from holiday is two events, one poll apart: the arrival, and
    // auto-return clearing the vacation flag that was keeping them out of the
    // count. By the poll where they finally count, lastPresent already says
    // they are in, so the 'somebody must actually have arrived' guard below
    // sees nobody arrive and stays silent - which is precisely the household
    // most wanting a welcome scene. Remembering the arrival across that gap is
    // what lets the guard tell it apart from somebody who was indoors all along
    // and merely rejoined the count.
    this.recentArrivals = new Map();

    // Whether the household-wide wake-up card has already gone off this night.
    // A night opens when the first person falls asleep, which is what keeps the
    // second person to get up quiet - see the 'first-awake' block in check().
    this.wakeReportedThisNight = false;
    this.pollTimer = null;
    this.inFlight = null;
    this.stopped = false;
    this.lastSlowReportAt = 0;
    this.lastFailureReportAt = 0;
    this.failureStreak = 0;
    this.nextAttemptAt = 0;
  }

  async start() {
    // A stopped watcher that is started again must not have every pass return
    // immediately for the rest of the process.
    this.stopped = false;

    // Armed before the seed read, and deliberately so. A Homey that has just
    // rebooted starts every app at once and may not answer the loopback API
    // yet; if the seed throws and the interval is set after it, the app keeps
    // running, conditions keep working, the settings page looks healthy - and
    // not one trigger card ever fires again for the life of the process.
    //
    // Seeding still works: a failed seed leaves lastPresent null, and the
    // `lastPresent !== null` guard in check() makes the first poll that does
    // succeed the seed instead. So "starting the app must not look like
    // everybody just fell asleep" holds either way.
    this.pollTimer = this.homey.setInterval(() => {
      if (Date.now() < this.nextAttemptAt) return;

      this.check().catch((err) => this.reportFailure(err));
    }, POLL_INTERVAL_MS);

    await this.check({ silent: true });
  }

  stop() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.stopped = true;
  }

  /**
   * One pass, and never two at once.
   *
   * A read that stalls outlasts the interval easily - the interval is one second
   * and an unanswered request waits seconds for its timeout, then retries once.
   * Two passes overlapping both read the old snapshot before either writes it,
   * so the slower one writes a stale world back and the transition is replayed
   * on the next poll: one bedtime, two Flows, and a spurious "woke up" in the
   * log between them.
   *
   * Skipping is the right answer rather than queueing: the passes that piled up
   * behind a stall would all diff the same list, and the one that runs when the
   * Homey answers again sees the whole change anyway.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.silent] Seed the snapshot without emitting anything.
   */
  async check(opts = {}) {
    if (this.stopped) return undefined;
    if (this.inFlight) return this.inFlight;

    const startedAt = Date.now();

    this.inFlight = this.runCheck(opts)
      .then((result) => {
        // Back to full speed the moment Homey answers again.
        this.failureStreak = 0;
        this.nextAttemptAt = 0;
        return result;
      })
      .finally(() => {
        this.inFlight = null;
        this.reportIfSlow(Date.now() - startedAt);
      });

    return this.inFlight;
  }

  /**
   * A read failed. Slow down, and say so at most once a minute.
   *
   * Both halves matter at one pass a second. Unthrottled, a Homey that refuses
   * the user list writes 3600 lines an hour into the app log; and every refusal
   * on the unauthorised path drops the session and fetches a new owner API
   * token, so retrying at full rate asks Homey to start a session roughly once a
   * second for as long as the fault lasts. Neither is a way to treat a device
   * that is already having trouble.
   *
   * @param {Error} err
   */
  reportFailure(err) {
    this.failureStreak += 1;

    if (this.failureStreak >= FAILURES_BEFORE_BACKOFF) {
      // 2s, 4s, 8s ... capped. The streak keeps counting so the delay holds at
      // the cap rather than sawing back down.
      const backoff = Math.min(POLL_INTERVAL_MS * (2 ** (this.failureStreak - FAILURES_BEFORE_BACKOFF + 1)), MAX_BACKOFF_MS);
      this.nextAttemptAt = Date.now() + backoff;
    }

    if (Date.now() - this.lastFailureReportAt < SLOW_REPORT_INTERVAL_MS) return;

    this.lastFailureReportAt = Date.now();
    this.homey.app.error(
      `Watcher poll failed (${this.failureStreak} in a row): ${err.message}`,
    );
  }

  /**
   * Say so when a pass outlasts the interval it is supposed to fit inside.
   *
   * The response time of every trigger card is the interval, and that only holds
   * while a pass finishes within one. A Homey that has grown slow to answer
   * stretches the cards silently otherwise - they keep working, they keep being
   * late, and nothing anywhere says why. Rate-limited to once a minute, because
   * whatever makes one pass slow tends to make the next sixty slow too.
   *
   * @param {number} elapsed
   */
  reportIfSlow(elapsed) {
    if (elapsed <= POLL_INTERVAL_MS) return;
    if (Date.now() - this.lastSlowReportAt < SLOW_REPORT_INTERVAL_MS) return;

    this.lastSlowReportAt = Date.now();
    this.homey.app.log(
      `A user check took ${elapsed}ms, longer than the ${POLL_INTERVAL_MS}ms between checks. `
      + 'Trigger cards will be at least that late until Homey answers faster.',
    );
  }

  /**
   * The pass itself. Only ever called through check(), which serialises it.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.silent]
   */
  async runCheck({ silent = false } = {}) {
    // One read, three lists. Arrivals come from the full list, because
    // auto-return has to notice a user coming home *while on vacation* - and
    // vacation users are precisely the ones `counted` leaves out.
    //
    // The per-user cards name a person, so they use `eligible` rather than
    // `counted`: somebody on holiday is still that person, and 'Alex comes
    // home' is exactly the moment a Flow wants to know. Being unticked in the
    // settings or disabled in Homey still silences them - those are the two the
    // settings page promises never fire anything.
    // `fresh` because this is the read the response time is made of. The list
    // cache outlives the interval, so without it every other pass would be
    // handed the list the previous pass had already diffed, and the detection
    // would quietly run at the cache's speed instead of the poll's.
    const { users, eligible, counted } = await this.userStatus.snapshot({ fresh: true });

    // Checked again on the far side of the read, because stop() can land while
    // it is in flight. Without this, a pass that began before onUninit() goes on
    // to emit, and the handlers fire Flow cards and write to the event log of an
    // app that is being torn down: the household gets a bedtime scene out of an
    // app update. Only the entry check existed, and a read takes 8-15 ms of
    // every 1000, so the window is small but it is open on every restart.
    if (this.stopped) return;

    const present = new Map(users.map((user) => [user.id, user.present === true]));
    const asleep = new Map(users.map((user) => [user.id, user.asleep === true]));
    const atHome = new Map(counted.map((user) => [user.id, user.present === true]));
    const awakeAtHome = new Map(counted.map((user) => [user.id, user.present && !user.asleep]));
    const asleepAtHome = new Map(counted.map((user) => [user.id, user.present && user.asleep]));
    const awakeCount = counted.filter((user) => user.present && !user.asleep).length;
    const asleepAtHomeCount = counted.filter((user) => user.present && user.asleep).length;
    const asleepCount = counted.filter((user) => user.asleep).length;
    // Derived from the very same `counted` above rather than asked of
    // UserStatus, which would be four more trips past the cache and four more
    // chances to answer about a different household than the diff is about.
    //
    // Same rules as the condition cards, empty set included: 'every member of
    // an empty set' is vacuously true, which is exactly the wrong answer here -
    // a household nobody counts must not fire bedtime Flows at an empty house.
    const atHomeCounted = counted.filter((user) => user.present);
    const everyoneHomeAsleep = atHomeCounted.length > 0 && atHomeCounted.every((user) => user.asleep === true);
    const everyoneAsleep = counted.length > 0 && counted.every((user) => user.asleep === true);
    const everyoneHome = counted.length > 0 && counted.every((user) => user.present === true);
    const nobodyHome = counted.length > 0 && counted.every((user) => user.present !== true);

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

      // One person, one card. These are the four transitions Homey has cards for
      // as well - the difference is entirely in who they fire for: Homey counts
      // every account it has, including the guest phone that never reports where
      // it is, so a household replacing those cards with these gets the same
      // Flows without the accounts it deliberately switched off.
      //
      // '=== true' / '=== false' rather than a negation: a user Homey has only
      // just told us about has no previous value, and has not just changed.
      for (const user of eligible) {
        const wasPresent = this.lastPresent.get(user.id);
        const wasAsleep = this.lastAsleep.get(user.id);
        const who = { id: user.id, name: user.name };

        if (wasPresent === true && user.present !== true) this.emit('user-left', who);
        if (wasPresent === false && user.present === true) this.emit('user-arrived', who);
        if (wasAsleep === false && user.asleep === true) this.emit('user-asleep', who);
        if (wasAsleep === true && user.asleep !== true) this.emit('user-awake', who);
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

      // Anybody counted who has just gone to bed, wherever they are.
      //
      // '=== false' rather than '!== true': a user Homey has only just told us
      // about has no previous value, and has not just fallen asleep.
      const wentToBed = counted.filter((user) => this.lastAsleep.get(user.id) === false && user.asleep);

      // A new night, for the household-wide wake-up card below.
      //
      // Keyed on somebody actually going to bed rather than on the sleeper count
      // leaving zero, which is what it used to be. That edge never arrives again
      // if a single counted user's sleep flag stays stuck at true - a bedtime
      // Flow whose wake-up counterpart is conditioned on being at home does
      // exactly that to somebody who wakes up elsewhere. The count then never
      // returns to zero, the night never reopens, and 'the first person wakes
      // up' goes silent for good, with nothing in the log to say why. Somebody
      // going to bed is the thing a night actually begins with, and it survives
      // a housemate whose flag is wrong.
      if (wentToBed.length > 0) this.wakeReportedThisNight = false;

      // The first person anywhere to fall asleep.
      if (lastAsleepCounted === 0 && asleepCount > 0 && wentToBed.length > 0) {
        this.emit('first-asleep', { id: wentToBed[0].id, name: wentToBed[0].name });
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
      // Walked in either this poll, or in one of the polls since - see
      // recentArrivals. Somebody indoors all along who merely rejoined the
      // count is in neither, which is the case both guards exist to reject.
      const walkedIn = (user) => user.present === true
        && (this.lastPresent.get(user.id) === false || this.recentArrivals.has(user.id));

      if (everyoneHome === true && this.lastEveryoneHome === false) {
        if (counted.some(walkedIn)) this.emit('everyone-home');
      }
      if (nobodyHome === true && this.lastNobodyHome === false) {
        const left = counted.some((user) => this.lastPresent.get(user.id) === true && !user.present);
        if (left) this.emit('everyone-left');
      }

      // The house was empty and is not any more. The exact mirror of the card
      // above, counting the same household, and it needs the same guard: an
      // empty house also stops being empty when somebody already indoors is
      // added back to the count - coming home from holiday, or being ticked in
      // the settings - and nobody walked through a door there.
      if (nobodyHome === false && this.lastNobodyHome === true) {
        const arrived = counted.filter(walkedIn);

        // Two people through the door inside one poll is one homecoming, not
        // two: report the earlier one rather than invent a tie-break, the same
        // way the bedtime cards do.
        if (arrived.length > 0) this.emit('first-arrived', { id: arrived[0].id, name: arrived[0].name });
      }

      // The same bedtime for the whole household, presence and all: everybody
      // counted is now asleep, wherever they are. It needs the same guard - the
      // state also flips when the last awake person is taken out of the count,
      // by going on vacation or being unticked in the settings, and nobody went
      // to bed there.
      if (everyoneAsleep === true && this.lastEveryoneAsleep === false && wentToBed.length > 0) {
        const last = wentToBed[wentToBed.length - 1];
        this.emit('everyone-asleep', { id: last.id, name: last.name });
      }
    }

    // Maintained after the guards, so an arrival is still 'recent' for the pass
    // that reads it. An arrival is remembered only while the person does not
    // count yet; the moment they do, the guards above have had their chance and
    // the memory is spent. Leaving again forgets it too - they did not stay.
    if (this.lastPresent !== null) {
      const now = Date.now();

      for (const user of users) {
        if (this.lastPresent.get(user.id) === false && user.present === true) this.recentArrivals.set(user.id, now);
        if (user.present !== true) this.recentArrivals.delete(user.id);
      }
      for (const user of counted) this.recentArrivals.delete(user.id);

      // Timestamped, and dropped once the arrival is too old to be the one a
      // guard is asking about.
      //
      // The three rules above all assume the person eventually either counts or
      // leaves. Somebody at home who counts for neither does exist: a status
      // that holds them out and does not auto-return - "staying at my parents'"
      // with no end date - keeps them present, uncounted, and remembered. Weeks
      // later, clearing that status would let walkedIn() call them a new arrival
      // and fire the welcome scene at a household that never went anywhere,
      // which is the exact thing these guards were written to prevent.
      for (const [id, at] of this.recentArrivals) {
        if (now - at > ARRIVAL_MEMORY_MS) this.recentArrivals.delete(id);
      }

      // A user deleted from Homey would otherwise sit in here for ever.
      const known = new Set(users.map((user) => user.id));
      for (const id of this.recentArrivals.keys()) if (!known.has(id)) this.recentArrivals.delete(id);
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
