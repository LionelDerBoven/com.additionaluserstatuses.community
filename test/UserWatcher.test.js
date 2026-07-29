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
    arrived: [], asleep: 0, asleepWho: [], firstAwake: [],
  };
  watcher.on('arrived', (user) => events.arrived.push(user.id));
  watcher.on('everyone-home-asleep', (user) => {
    events.asleep += 1;
    events.asleepWho.push(user.id);
  });
  watcher.on('first-home-awake', (user) => events.firstAwake.push(user.id));

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
