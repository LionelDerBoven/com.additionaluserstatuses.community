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
  const events = { arrived: [], asleep: 0 };
  watcher.on('arrived', (user) => events.arrived.push(user.id));
  watcher.on('everyone-home-asleep', () => {
    events.asleep += 1;
  });

  return { watcher, events };
}

const user = (id, present) => ({ id, name: `User ${id}`, present });

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
