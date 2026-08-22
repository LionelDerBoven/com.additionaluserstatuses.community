'use strict';

/**
 * Systematic edge cases, written by walking the state space rather than by
 * following the happy path: a house emptying, users vanishing mid-run, two
 * things happening inside one poll, a settings write racing another, and
 * malformed stored data.
 *
 * Two of these found real bugs and are the reason the file exists:
 *   E5 - an early riser leaving as a sleeper wakes used to behave differently
 *        from the same two events one poll apart.
 *   E9 - two vacation writes landing together silently lost one, because
 *        read-modify-write against an async settings store races itself.
 */

const test = require('node:test');
const assert = require('node:assert');

const UserWatcher = require('../lib/UserWatcher');
const VacationStore = require('../lib/VacationStore');
const UserStatus = require('../lib/UserStatus');

const user = (id, present, asleep = false) => ({
  id, name: `User ${id}`, present, asleep,
});

/** Settings whose write is genuinely asynchronous, as Homey's is. */
function slowHomey(initial = {}) {
  const store = { ...initial };
  return {
    settings: {
      get: (key) => store[key],
      set: async (key, value) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        store[key] = value;
      },
    },
    app: { log: () => {}, error: () => {} },
    __: (key) => key,
  };
}

function makeWatcher(users, counted = null) {
  const status = {
    users,
    counted,
    async fetchUsers() {
      return this.users;
    },
    async getCountedUsers() {
      return this.counted || this.users;
    },
    async isEveryoneHomeAsleep() {
      const atHome = (this.counted || this.users).filter((u) => u.present);
      return atHome.length > 0 && atHome.every((u) => u.asleep);
    },
    async isEveryoneAsleep() {
      const all = this.counted || this.users;
      return all.length > 0 && all.every((u) => u.asleep);
    },
    async isEveryoneHome() {
      const all = this.counted || this.users;
      return all.length > 0 && all.every((u) => u.present);
    },
    async isNobodyHome() {
      const all = this.counted || this.users;
      return all.length > 0 && all.every((u) => !u.present);
    },
  };

  const homey = {
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
  const events = { awake: [], asleep: [], arrived: [] };
  watcher.on('first-home-awake', (u) => events.awake.push(u.id));
  watcher.on('everyone-home-asleep', (u) => events.asleep.push(u.id));
  watcher.on('arrived', (u) => events.arrived.push(u.id));

  return { watcher, events, status };
}

function makeStatus(homey, usersById) {
  const api = { users: { getUsers: async () => usersById } };
  return new UserStatus({ homey, getApi: async () => api, vacation: new VacationStore({ homey }) });
}

// ---------------------------------------------------------------------------
// The watcher, at the edges of the state space
// ---------------------------------------------------------------------------

test('E1 the house emptying is neither a bedtime nor a waking', async () => {
  const { watcher, events, status } = makeWatcher([user('a', true, false)]);
  await watcher.check({ silent: true });

  status.users = [user('a', false, false)];
  await watcher.check();

  assert.deepStrictEqual([events.awake, events.asleep], [[], []]);
});

test('E2 a sleeping house emptying is not a bedtime either', async () => {
  const { watcher, events, status } = makeWatcher([user('a', true, true)]);
  await watcher.check({ silent: true });

  status.users = [user('a', false, true)];
  await watcher.check();

  assert.deepStrictEqual([events.awake, events.asleep], [[], []]);
});

test('E3 a user deleted from Homey mid-run neither crashes nor triggers', async () => {
  const { watcher, events, status } = makeWatcher([user('a', true, true), user('b', true, false)]);
  await watcher.check({ silent: true });

  status.users = [user('a', true, true)];
  await watcher.check();

  assert.deepStrictEqual(events.asleep, [], 'b vanishing is not b going to bed');
});

test('E4 someone who becomes counted while awake is not a first riser', async () => {
  // For instance returning from vacation: never observed asleep at home.
  const { watcher, events, status } = makeWatcher([user('a', true, true)], [user('a', true, true)]);
  await watcher.check({ silent: true });

  status.users = [user('a', true, true), user('b', true, false)];
  status.counted = [user('a', true, true), user('b', true, false)];
  await watcher.check();

  assert.deepStrictEqual(events.awake, []);
});

test('E5 an early riser leaving as a sleeper wakes still counts as a rise', async () => {
  // The same two events one poll apart already fired. Where the poll boundary
  // happens to fall must not change the answer.
  const { watcher, events, status } = makeWatcher([user('a', true, true), user('b', true, false)]);
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', false, false)];
  await watcher.check();

  assert.deepStrictEqual(events.awake, ['a']);
});

test('E6 a failed read leaves the snapshot intact for the next check', async () => {
  const { watcher, events, status } = makeWatcher([user('a', true, true)]);
  await watcher.check({ silent: true });

  const good = status.fetchUsers;
  status.fetchUsers = async () => {
    throw new Error('homey down');
  };
  await assert.rejects(() => watcher.check());

  status.fetchUsers = good;
  status.users = [user('a', true, false)];
  await watcher.check();

  assert.deepStrictEqual(events.awake, ['a'], 'the transition survived the outage');
});

test('E7 bedtime still fires when the last awake sleeps as another leaves', async () => {
  const { watcher, events, status } = makeWatcher([user('a', true, false), user('b', true, false)]);
  await watcher.check({ silent: true });

  status.users = [user('a', false, false), user('b', true, true)];
  await watcher.check();

  assert.deepStrictEqual(events.asleep, ['b'], 'b really did go to bed');
});

test('E8 stop() before start() is harmless', () => {
  const { watcher } = makeWatcher([]);
  assert.doesNotThrow(() => watcher.stop());
});

// ---------------------------------------------------------------------------
// Storage and malformed data
// ---------------------------------------------------------------------------

test('E9 two vacation writes landing together do not lose one', async () => {
  const store = new VacationStore({ homey: slowHomey() });

  await Promise.all([store.set('x', true), store.set('y', true)]);

  assert.deepStrictEqual(store.getIds().sort(), ['x', 'y']);
});

test('E10 a corrupt excluded_user_ids does not break the cards', async () => {
  const homey = slowHomey({ excluded_user_ids: 'oops-not-an-array' });
  const status = makeStatus(homey, {
    a: {
      id: 'a', name: 'A', enabled: true, present: true, asleep: false,
    },
  });

  assert.strictEqual(await status.isEveryoneHome(), true);
});

test('E11 a user with no name falls back rather than showing undefined', async () => {
  const homey = slowHomey();
  const status = makeStatus(homey, {
    a: {
      id: 'a', name: '', enabled: true, present: true, asleep: false,
    },
  });

  const [only] = await status.fetchUsers();
  assert.strictEqual(only.name, 'unnamed_user');
});

// ---------------------------------------------------------------------------
// The conditions, at the edges
// ---------------------------------------------------------------------------

test('E12 never-set statuses read as away and awake', async () => {
  const homey = slowHomey();
  const status = makeStatus(homey, {
    a: {
      id: 'a', name: 'A', enabled: true, present: null, asleep: null,
    },
  });

  assert.strictEqual(await status.isEveryoneHome(), false);
  assert.strictEqual(await status.isEveryoneHomeAsleep(), false, 'nobody is home');
  assert.strictEqual(await status.isExactlyOneHomeAwake(), false, 'not present');
});

test('E13 a Homey with no users at all answers everything false', async () => {
  const homey = slowHomey();
  const status = makeStatus(homey, {});

  const overview = await status.getOverview();
  assert.deepStrictEqual([overview.users, overview.countedCount], [[], 0]);
  assert.strictEqual(overview.everyoneHome, false);
  assert.strictEqual(overview.everyoneHomeAsleep, false);
  assert.strictEqual(overview.oneHomeAwake, false);
});

// ---------------------------------------------------------------------------
// Raw status changes, for the settings log
// ---------------------------------------------------------------------------

test('E14 every presence and sleep change is reported', async () => {
  const { watcher, status } = makeWatcher([user('a', true, false), user('b', false, false)]);
  const changes = [];
  watcher.on('user-changed', (c) => changes.push(`${c.id}:${c.field}=${c.value}`));
  await watcher.check({ silent: true });

  status.users = [user('a', true, true), user('b', true, false)];
  await watcher.check();

  assert.deepStrictEqual(changes.sort(), ['a:asleep=true', 'b:present=true']);
});

test('E15 the seeding check reports no changes', async () => {
  const { watcher } = makeWatcher([user('a', true, true)]);
  const changes = [];
  watcher.on('user-changed', (c) => changes.push(c.id));

  await watcher.check({ silent: true });

  assert.deepStrictEqual(changes, []);
});

test('E16 a user Homey has only just mentioned is not a change', async () => {
  const { watcher, status } = makeWatcher([user('a', true, false)]);
  const changes = [];
  watcher.on('user-changed', (c) => changes.push(c.id));
  await watcher.check({ silent: true });

  status.users = [user('a', true, false), user('b', true, true)];
  await watcher.check();

  assert.deepStrictEqual(changes, [], 'no previous value means no transition');
});

test('E17 an unchanged status is not reported again', async () => {
  const { watcher, status } = makeWatcher([user('a', true, false)]);
  const changes = [];
  watcher.on('user-changed', (c) => changes.push(c.id));
  await watcher.check({ silent: true });

  status.users = [user('a', true, true)];
  await watcher.check();
  await watcher.check();
  await watcher.check();

  assert.deepStrictEqual(changes, ['a'], 'edge, not level');
});
