'use strict';

/**
 * Checks for lib/UserWatcher.js.
 *
 * Triggers fire on edges, not levels, and getting that wrong is the difference
 * between a bedtime Flow running once and running every fifteen seconds all
 * night. These drive check() by hand rather than waiting on timers.
 */

const test = require('node:test');
const assert = require('node:assert');

const UserWatcher = require('../lib/UserWatcher');

/**
 * A UserStatus stand-in whose answers the test controls directly.
 */
function fakeStatus(initialUsers) {
  return {
    users: initialUsers,
    async fetchUsers() {
      return this.users;
    },
    // The watcher reads arrivals from the full list and the awake logic from the
    // counted one; these tests use no exclusions, so both return the same users.
    async getCountedUsers() {
      return this.users;
    },
    // Derived from the users rather than set by hand, so a test cannot describe
    // a household state that could never actually occur.
    async isEveryoneHomeAsleep() {
      const atHome = this.users.filter((u) => u.present);
      return atHome.length > 0 && atHome.every((u) => u.asleep);
    },
    async isEveryoneAsleep() {
      return this.users.length > 0 && this.users.every((u) => u.asleep);
    },
    async isEveryoneHome() {
      return this.users.length > 0 && this.users.every((u) => u.present);
    },
    async isNobodyHome() {
      return this.users.length > 0 && this.users.every((u) => !u.present);
    },
  };
}

function makeWatcher(status) {
  const homey = {
    // The watcher must never reach for a real timer in these tests.
    setInterval: () => null,
    clearInterval: () => {},
    setTimeout: () => null,
    clearTimeout: () => {},
    api: {
      getApi: () => {
        throw new Error('no realtime in tests');
      },
    },
    app: { log: () => {}, error: () => {} },
  };

  const watcher = new UserWatcher({ homey, userStatus: status });
  const events = {
    arrived: [],
    asleep: 0,
    asleepWho: [],
    firstAwake: [],
    firstHomeAsleep: [],
    firstAsleep: [],
    firstAnyAwake: [],
    everyoneAsleep: 0,
    everyoneAsleepWho: [],
    everyoneHomeAwake: [],
    someoneHomeAwake: [],
    everyoneAwake: [],
    everyoneHome: 0,
    everyoneLeft: 0,
  };
  watcher.on('arrived', (user) => events.arrived.push(user.id));
  watcher.on('everyone-home-asleep', (user) => {
    events.asleep += 1;
    events.asleepWho.push(user.id);
  });
  watcher.on('first-home-awake', (user) => events.firstAwake.push(user.id));
  watcher.on('first-home-asleep', (user) => events.firstHomeAsleep.push(user.id));
  watcher.on('first-asleep', (user) => events.firstAsleep.push(user.id));
  watcher.on('first-awake', (user) => events.firstAnyAwake.push(user.id));
  watcher.on('everyone-asleep', (user) => {
    events.everyoneAsleep += 1;
    events.everyoneAsleepWho.push(user.id);
  });
  watcher.on('everyone-home-awake', (user) => events.everyoneHomeAwake.push(user.id));
  watcher.on('someone-home-awake', (user) => events.someoneHomeAwake.push(user.id));
  watcher.on('everyone-awake', (user) => events.everyoneAwake.push(user.id));
  watcher.on('everyone-home', () => {
    events.everyoneHome += 1;
  });
  watcher.on('everyone-left', () => {
    events.everyoneLeft += 1;
  });

  return { watcher, events };
}

const user = (id, present, asleep = false) => ({
  id, name: `User ${id}`, present, asleep,
});

test('the first check only seeds, so starting the app fires nothing', async () => {
  const status = fakeStatus([user('a', true, true)]);
  const { watcher, events } = makeWatcher(status);

  await watcher.check({ silent: true });

  assert.strictEqual(events.asleep, 0, 'an app restart must not look like bedtime');
  assert.strictEqual(events.arrived.length, 0);
});

test('everyone-home-asleep fires once on the transition, not on every check', async () => {
  const status = fakeStatus([user('a', true, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, true)];
  await watcher.check();
  assert.strictEqual(events.asleep, 1);

  // Still asleep three checks later: the Flow should not run again.
  await watcher.check();
  await watcher.check();
  assert.strictEqual(events.asleep, 1, 'level, not edge, would fire every poll');
});

test('it can fire again after everyone wakes up', async () => {
  const status = fakeStatus([user('a', true, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, true)];
  await watcher.check();
  status.users = [user('a', true, false)];
  await watcher.check();
  status.users = [user('a', true, true)];
  await watcher.check();

  assert.strictEqual(events.asleep, 2);
});

// ---------------------------------------------------------------------------
// The last person at home to fall asleep — the mirror of "first to wake"
// ---------------------------------------------------------------------------

test('does not fire when the last awake person simply goes out', async () => {
  // a is asleep at home, b is awake at home, then b leaves. "Everyone at home is
  // asleep" flips false->true, but nobody went to bed, so this must stay silent.
  const status = fakeStatus([user('a', true, true), user('b', true, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, true), user('b', false, false)];
  await watcher.check();

  assert.strictEqual(events.asleep, 0, 'leaving the house is not going to bed');
});

test('does not fire when the first of two goes to sleep', async () => {
  const status = fakeStatus([user('a', true, false), user('b', true, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, true), user('b', true, false)];
  await watcher.check();

  assert.strictEqual(events.asleep, 0, 'b is still awake');
});

test('fires when the last awake person really falls asleep, naming them', async () => {
  const status = fakeStatus([user('a', true, true), user('b', true, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, true), user('b', true, true)];
  await watcher.check();

  assert.strictEqual(events.asleep, 1);
  assert.deepStrictEqual(events.asleepWho, ['b'], 'b was last to bed, not a');
});

test('does not fire when an empty house gains a sleeping user', async () => {
  const status = fakeStatus([user('a', false, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, true)];
  await watcher.check();

  assert.strictEqual(events.asleep, 0, 'arriving asleep is not falling asleep');
});

test('arrival is reported only for someone who was actually away', async () => {
  const status = fakeStatus([user('a', false), user('b', true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true), user('b', true)];
  await watcher.check();

  assert.deepStrictEqual(events.arrived, ['a'], 'b was already home');
});

test('staying home does not re-report an arrival', async () => {
  const status = fakeStatus([user('a', false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true)];
  await watcher.check();
  await watcher.check();

  assert.deepStrictEqual(events.arrived, ['a']);
});

test('a user seen for the first time is not treated as an arrival', async () => {
  const status = fakeStatus([user('a', true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  // A housemate added to Homey mid-run, already marked present.
  status.users = [user('a', true), user('b', true)];
  await watcher.check();

  assert.deepStrictEqual(events.arrived, [], 'no previous state means no transition');
});

test('a missing realtime channel is survivable', async () => {
  const status = fakeStatus([user('a', true)]);
  const { watcher } = makeWatcher(status);

  // getApi throws in this harness; subscribing must swallow it rather than
  // taking the app down, because polling alone is a complete fallback.
  assert.doesNotThrow(() => watcher.subscribeRealtime());
});

// ---------------------------------------------------------------------------
// The first person at home to wake up
//
// The distinction that matters: "exactly one person is awake" also becomes true
// in the evening when the second-to-last person goes to bed. This trigger must
// not fire then.
// ---------------------------------------------------------------------------

test('fires when a sleeping person wakes while the other still sleeps', async () => {
  const status = fakeStatus([user('a', true, true), user('b', true, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, true)];
  await watcher.check();

  assert.deepStrictEqual(events.firstAwake, ['a']);
});

test('does not fire again for the second person to wake', async () => {
  const status = fakeStatus([user('a', true, true), user('b', true, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, true)];
  await watcher.check();
  status.users = [user('a', true, false), user('b', true, false)];
  await watcher.check();

  assert.deepStrictEqual(events.firstAwake, ['a'], 'b waking is not a "first"');
});

test('does not fire in the evening when someone goes to bed leaving one awake', async () => {
  // Both awake, then b sleeps. "Exactly one awake" flips false->true here, so a
  // naive implementation would fire. Nobody woke up, so this must stay silent.
  const status = fakeStatus([user('a', true, false), user('b', true, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, true)];
  await watcher.check();

  assert.deepStrictEqual(events.firstAwake, [], 'going to bed is not waking up');
});

test('does not fire when somebody arrives home awake', async () => {
  // a is asleep at home; b comes home awake at 2am. b did not wake up here.
  const status = fakeStatus([user('a', true, true), user('b', false, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, true), user('b', true, false)];
  await watcher.check();

  assert.deepStrictEqual(events.firstAwake, [], 'arriving awake is not waking up');
  assert.deepStrictEqual(events.arrived, ['b'], 'but it is still an arrival');
});

test('does not fire on the seeding check', async () => {
  const status = fakeStatus([user('a', true, false), user('b', true, true)]);
  const { watcher, events } = makeWatcher(status);

  await watcher.check({ silent: true });

  assert.deepStrictEqual(events.firstAwake, [], 'a restart must not look like morning');
});

test('fires again the next morning', async () => {
  const status = fakeStatus([user('a', true, true), user('b', true, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, true)];
  await watcher.check();
  // Everyone back to sleep, then a wakes again.
  status.users = [user('a', true, true), user('b', true, true)];
  await watcher.check();
  status.users = [user('a', true, false), user('b', true, true)];
  await watcher.check();

  assert.deepStrictEqual(events.firstAwake, ['a', 'a']);
});

test('two overlapping checks do not report the same transition twice', async () => {
  // The 15s poll and a realtime-prompted check can land together. This holds
  // because every read of the previous snapshot happens after the last await,
  // making check-emit-record atomic. Adding an await inside that block would
  // break it silently, so the property is pinned here.
  const status = fakeStatus([user('a', true, false)]);
  status.fetchUsers = async function slowRead() {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return this.users;
  };
  const { watcher, events } = makeWatcher(status);

  await watcher.check({ silent: true });
  status.users = [user('a', true, true)];

  await Promise.all([watcher.check(), watcher.check()]);

  assert.strictEqual(events.asleep, 1, 'one bedtime must not run the Flow twice');
});

test('both waking inside one poll still fires, exactly once', async () => {
  // One alarm waking a couple is one morning. Keying on "exactly one is awake"
  // made this fire zero times, which is worse than firing twice: the Flow just
  // silently never ran.
  const status = fakeStatus([user('a', true, true), user('b', true, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, false)];
  await watcher.check();

  assert.strictEqual(events.firstAwake.length, 1, 'one morning, one trigger');
});

test('two of three waking together fires once, third waking later does not', async () => {
  const status = fakeStatus([
    user('a', true, true), user('b', true, true), user('c', true, true),
  ]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, false), user('c', true, true)];
  await watcher.check();
  assert.strictEqual(events.firstAwake.length, 1);

  status.users = [user('a', true, false), user('b', true, false), user('c', true, false)];
  await watcher.check();
  assert.strictEqual(events.firstAwake.length, 1, 'c is not a first riser');
});

test('a new morning fires again after everyone has gone back to sleep', async () => {
  const status = fakeStatus([user('a', true, true), user('b', true, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, false)];
  await watcher.check();
  status.users = [user('a', true, true), user('b', true, true)];
  await watcher.check();
  status.users = [user('a', true, false), user('b', true, false)];
  await watcher.check();

  assert.strictEqual(events.firstAwake.length, 2, 'two mornings, two triggers');
});

test('waking while somebody at home is already awake is not a first', async () => {
  const status = fakeStatus([user('a', true, false), user('b', true, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, false)];
  await watcher.check();

  assert.deepStrictEqual(events.firstAwake, [], 'a was already up');
});

// ---------------------------------------------------------------------------
// The first person to fall asleep — at home, and household-wide
// ---------------------------------------------------------------------------

test('the first person at home to fall asleep is named', async () => {
  const status = fakeStatus([user('a', true, false), user('b', true, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, true), user('b', true, false)];
  await watcher.check();

  assert.deepStrictEqual(events.firstHomeAsleep, ['a']);
  assert.deepStrictEqual(events.firstAsleep, ['a'], 'and household-wide too');
});

test('the second person to go to bed does not fire it again', async () => {
  const status = fakeStatus([user('a', true, false), user('b', true, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, true), user('b', true, false)];
  await watcher.check();
  status.users = [user('a', true, true), user('b', true, true)];
  await watcher.check();

  assert.deepStrictEqual(events.firstHomeAsleep, ['a'], 'b is not a first');
  assert.deepStrictEqual(events.firstAsleep, ['a']);
});

test('arriving home already asleep is not going to bed', async () => {
  const status = fakeStatus([user('a', true, false), user('b', false, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, true)];
  await watcher.check();

  assert.deepStrictEqual(events.firstHomeAsleep, [], 'b fell asleep elsewhere');
});

test('a sleeper who leaves does not block the next first to bed', async () => {
  // a is asleep at home, then goes out awake at the same moment b turns in.
  // The mirror of the 1.3.4 fix for the wake-up card.
  const status = fakeStatus([user('a', true, true), user('b', true, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', false, false), user('b', true, true)];
  await watcher.check();

  assert.deepStrictEqual(events.firstHomeAsleep, ['b']);
});

test('somebody falling asleep elsewhere counts household-wide, not at home', async () => {
  const status = fakeStatus([user('a', true, false), user('b', false, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  // b is away - at a hotel, or staying over with family - and goes to sleep.
  status.users = [user('a', true, false), user('b', false, true)];
  await watcher.check();

  assert.deepStrictEqual(events.firstHomeAsleep, [], 'nobody went to bed here');
  assert.deepStrictEqual(events.firstAsleep, ['b'], 'but somebody in the household did');
});

test('somebody away and awake does not hold the first to bed back', async () => {
  const status = fakeStatus([user('a', true, false), user('b', false, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, true), user('b', false, false)];
  await watcher.check();

  assert.deepStrictEqual(events.firstAsleep, ['a'], 'b is out, not up');
});

test('a user seen for the first time has not just fallen asleep', async () => {
  const status = fakeStatus([user('a', true, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  // A housemate added to Homey mid-run, already marked asleep.
  status.users = [user('a', true, false), user('b', true, true)];
  await watcher.check();

  assert.deepStrictEqual(events.firstAsleep, [], 'no previous state means no transition');
  assert.deepStrictEqual(events.firstHomeAsleep, []);
});

// ---------------------------------------------------------------------------
// The first person to wake up, household-wide — one per night
// ---------------------------------------------------------------------------

test('a sleeper elsewhere waking is a first household-wide, but not at home', async () => {
  // The case the at-home card cannot cover: a has been up all along, so "nobody
  // at home was awake" is false, yet b is the first of the household to wake.
  const status = fakeStatus([user('a', true, false), user('b', false, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', false, false)];
  await watcher.check();

  assert.deepStrictEqual(events.firstAwake, [], 'the at-home card stays silent');
  assert.deepStrictEqual(events.firstAnyAwake, ['b']);
});

test('somebody away and awake does not hold the first to wake back', async () => {
  const status = fakeStatus([user('a', true, true), user('b', false, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', false, false)];
  await watcher.check();

  assert.deepStrictEqual(events.firstAnyAwake, ['a']);
});

test('the second person up does not fire it again', async () => {
  const status = fakeStatus([user('a', true, true), user('b', true, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, true)];
  await watcher.check();
  status.users = [user('a', true, false), user('b', true, false)];
  await watcher.check();

  assert.deepStrictEqual(events.firstAnyAwake, ['a'], 'one morning, one trigger');
});

test('it fires again only after a new night has begun', async () => {
  const status = fakeStatus([user('a', true, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false)];
  await watcher.check();
  assert.deepStrictEqual(events.firstAnyAwake, ['a']);

  // Awake all day: nothing reopens the night.
  await watcher.check();
  assert.deepStrictEqual(events.firstAnyAwake, ['a']);

  status.users = [user('a', true, true)];
  await watcher.check();
  status.users = [user('a', true, false)];
  await watcher.check();

  assert.deepStrictEqual(events.firstAnyAwake, ['a', 'a'], 'a second night, a second morning');
  assert.deepStrictEqual(events.firstAsleep, ['a'], 'and one bedtime in between');
});

test('a household where nobody slept never reports a first waking', async () => {
  const status = fakeStatus([user('a', true, false), user('b', false, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, false)];
  await watcher.check();

  assert.deepStrictEqual(events.firstAnyAwake, [], 'coming home is not waking up');
});

test('seeding a sleeping household fires none of the new cards', async () => {
  const status = fakeStatus([user('a', true, true), user('b', true, true)]);
  const { watcher, events } = makeWatcher(status);

  await watcher.check({ silent: true });

  assert.deepStrictEqual(events.firstHomeAsleep, []);
  assert.deepStrictEqual(events.firstAsleep, []);
  assert.deepStrictEqual(events.firstAnyAwake, []);
});

// ---------------------------------------------------------------------------
// The last person to fall asleep, household-wide
// ---------------------------------------------------------------------------

test('the last person in the household to fall asleep is named', async () => {
  const status = fakeStatus([user('a', true, true), user('b', false, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  // b is out for the evening and turns in there: now everybody is asleep.
  status.users = [user('a', true, true), user('b', false, true)];
  await watcher.check();

  assert.strictEqual(events.everyoneAsleep, 1);
  assert.deepStrictEqual(events.everyoneAsleepWho, ['b']);
  assert.strictEqual(events.asleep, 0, 'the at-home card had already fired for a');
});

test('it does not fire while somebody is still awake anywhere', async () => {
  const status = fakeStatus([user('a', true, false), user('b', false, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  // Everybody at home is asleep, but b is out and up.
  status.users = [user('a', true, true), user('b', false, false)];
  await watcher.check();

  assert.strictEqual(events.everyoneAsleep, 0, 'b is still awake');
  assert.strictEqual(events.asleep, 1, 'while the at-home card does fire');
});

test('it fires once on the transition, not on every check', async () => {
  const status = fakeStatus([user('a', true, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, true)];
  await watcher.check();
  await watcher.check();
  await watcher.check();

  assert.strictEqual(events.everyoneAsleep, 1, 'level, not edge, would fire every poll');
});

test('it stays silent when the last awake person drops out of the count', async () => {
  const status = fakeStatus([user('a', true, true), user('b', true, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  // b goes on vacation, so only a is counted - and a was already asleep.
  status.users = [user('a', true, true), user('b', true, false)];
  status.counted = [user('a', true, true)];
  status.getCountedUsers = async function getCountedUsers() {
    return this.counted;
  };
  status.isEveryoneAsleep = async function isEveryoneAsleep() {
    return this.counted.length > 0 && this.counted.every((u) => u.asleep);
  };
  await watcher.check();

  assert.strictEqual(events.everyoneAsleep, 0, 'nobody went to bed, the count just shrank');
});

// ---------------------------------------------------------------------------
// The last person to wake up — the end of the night
// ---------------------------------------------------------------------------

test('the last sleeper at home waking is named', async () => {
  const status = fakeStatus([user('a', true, true), user('b', true, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, true)];
  await watcher.check();
  assert.deepStrictEqual(events.everyoneHomeAwake, [], 'b is still asleep');

  status.users = [user('a', true, false), user('b', true, false)];
  await watcher.check();
  assert.deepStrictEqual(events.everyoneHomeAwake, ['b'], 'b was last up');
});

test('the last sleeper leaving the house is not a waking', async () => {
  // a is up, b is asleep at home, then b goes out awake. "Everyone at home is
  // asleep" flips true->false, but nobody woke up in this house.
  const status = fakeStatus([user('a', true, false), user('b', true, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', false, false)];
  await watcher.check();

  assert.deepStrictEqual(events.everyoneHomeAwake, [], 'leaving is not waking');
});

test('the at-home waking does not fire again while everyone stays up', async () => {
  const status = fakeStatus([user('a', true, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false)];
  await watcher.check();
  await watcher.check();
  await watcher.check();

  assert.deepStrictEqual(events.everyoneHomeAwake, ['a'], 'level, not edge, would fire every poll');
});

test('somebody sleeping elsewhere holds the household waking back', async () => {
  const status = fakeStatus([user('a', true, true), user('b', false, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', false, true)];
  await watcher.check();
  assert.deepStrictEqual(events.everyoneHomeAwake, ['a'], 'at home everyone is up');
  assert.deepStrictEqual(events.everyoneAwake, [], 'but b is still asleep at the hotel');

  status.users = [user('a', true, false), user('b', false, false)];
  await watcher.check();
  assert.deepStrictEqual(events.everyoneAwake, ['b']);
});

// ---------------------------------------------------------------------------
// Everyone in, everyone out
// ---------------------------------------------------------------------------

test('everyone at home fires when the last one who counts arrives', async () => {
  const status = fakeStatus([user('a', true), user('b', false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true), user('b', true)];
  await watcher.check();
  assert.strictEqual(events.everyoneHome, 1);

  await watcher.check();
  assert.strictEqual(events.everyoneHome, 1, 'staying in is not arriving');
});

test('everyone out fires when the last one who counts leaves', async () => {
  const status = fakeStatus([user('a', true), user('b', true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', false), user('b', true)];
  await watcher.check();
  assert.strictEqual(events.everyoneLeft, 0, 'b is still in');

  status.users = [user('a', false), user('b', false)];
  await watcher.check();
  assert.strictEqual(events.everyoneLeft, 1);
});

test('the two presence cards can each fire again after the other', async () => {
  const status = fakeStatus([user('a', true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', false)];
  await watcher.check();
  status.users = [user('a', true)];
  await watcher.check();
  status.users = [user('a', false)];
  await watcher.check();

  assert.strictEqual(events.everyoneLeft, 2);
  assert.strictEqual(events.everyoneHome, 1);
});

test('everyone at home stays silent when only the count changed', async () => {
  // a is in, b is out and on vacation, so a alone counts and everyone is home.
  // b returning from vacation while still out makes "everyone is home" false and
  // then true again - without anybody walking through a door.
  const status = fakeStatus([user('a', true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true), user('b', false)];
  await watcher.check();
  assert.strictEqual(events.everyoneHome, 0, 'b joining the count is not an arrival');

  status.users = [user('a', true)];
  await watcher.check();
  assert.strictEqual(events.everyoneHome, 0, 'and b leaving the count is not one either');
});

test('everyone out stays silent when only the count changed', async () => {
  const status = fakeStatus([user('a', false), user('b', true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  // b drops out of the count - on vacation, or unticked - leaving only a, who is
  // out. The house is not suddenly empty; nobody went anywhere.
  status.users = [user('a', false)];
  await watcher.check();

  assert.strictEqual(events.everyoneLeft, 0, 'the count shrank, nobody left');
});

test('somebody coming home from vacation still counts as arriving', async () => {
  const status = fakeStatus([user('a', true), user('b', false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true), user('b', true)];
  await watcher.check();

  assert.strictEqual(events.everyoneHome, 1, 'b really did arrive');
});

// ---------------------------------------------------------------------------
// Anyone at home waking — the second and third riser too
// ---------------------------------------------------------------------------

test('every riser at home is reported, not just the first', async () => {
  const status = fakeStatus([user('a', true, true), user('b', true, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, true)];
  await watcher.check();
  status.users = [user('a', true, false), user('b', true, false)];
  await watcher.check();

  assert.deepStrictEqual(events.someoneHomeAwake, ['a', 'b'], 'both mornings, in order');
  assert.deepStrictEqual(events.firstAwake, ['a'], 'while the first-riser card fires once');
});

test('two waking in one poll is two people, not one household', async () => {
  const status = fakeStatus([user('a', true, true), user('b', true, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, false)];
  await watcher.check();

  assert.deepStrictEqual(events.someoneHomeAwake, ['a', 'b'], 'the card names a person, so it fires per person');
});

test('somebody waking elsewhere is not somebody waking at home', async () => {
  const status = fakeStatus([user('a', true, false), user('b', false, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', false, false)];
  await watcher.check();

  assert.deepStrictEqual(events.someoneHomeAwake, [], 'b woke at the hotel');
});

test('arriving home awake is not waking up at home', async () => {
  const status = fakeStatus([user('a', true, true), user('b', false, false)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.users = [user('a', true, true), user('b', true, false)];
  await watcher.check();

  assert.deepStrictEqual(events.someoneHomeAwake, [], 'b walked in, nobody woke');
});

test('an empty house cannot report a waking', async () => {
  const status = fakeStatus([user('a', true, true)]);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  // The last sleeper leaves and wakes up outside - the case the cooldown in the
  // Goedemorgen Flow was built to paper over.
  status.users = [user('a', false, false)];
  await watcher.check();

  assert.deepStrictEqual(events.someoneHomeAwake, [], 'waking outside is not waking here');
});
