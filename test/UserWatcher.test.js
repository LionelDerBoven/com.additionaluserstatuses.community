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
function fakeStatus(initialUsers, initialHomeAsleep = false) {
  return {
    users: initialUsers,
    homeAsleep: initialHomeAsleep,
    async fetchUsers() {
      return this.users;
    },
    // The watcher reads arrivals from the full list and the awake logic from the
    // counted one; these tests use no exclusions, so both return the same users.
    async getCountedUsers() {
      return this.users;
    },
    async isEveryoneHomeAsleep() {
      return this.homeAsleep;
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
  const events = { arrived: [], asleep: 0, firstAwake: [] };
  watcher.on('arrived', (user) => events.arrived.push(user.id));
  watcher.on('everyone-home-asleep', () => {
    events.asleep += 1;
  });
  watcher.on('first-home-awake', (user) => events.firstAwake.push(user.id));

  return { watcher, events };
}

const user = (id, present, asleep = false) => ({
  id, name: `User ${id}`, present, asleep,
});

test('the first check only seeds, so starting the app fires nothing', async () => {
  const status = fakeStatus([user('a', true)], true);
  const { watcher, events } = makeWatcher(status);

  await watcher.check({ silent: true });

  assert.strictEqual(events.asleep, 0, 'an app restart must not look like bedtime');
  assert.strictEqual(events.arrived.length, 0);
});

test('everyone-home-asleep fires once on the transition, not on every check', async () => {
  const status = fakeStatus([user('a', true)], false);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.homeAsleep = true;
  await watcher.check();
  assert.strictEqual(events.asleep, 1);

  // Still asleep three checks later: the Flow should not run again.
  await watcher.check();
  await watcher.check();
  assert.strictEqual(events.asleep, 1, 'level, not edge, would fire every poll');
});

test('it can fire again after everyone wakes up', async () => {
  const status = fakeStatus([user('a', true)], false);
  const { watcher, events } = makeWatcher(status);
  await watcher.check({ silent: true });

  status.homeAsleep = true;
  await watcher.check();
  status.homeAsleep = false;
  await watcher.check();
  status.homeAsleep = true;
  await watcher.check();

  assert.strictEqual(events.asleep, 2);
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
