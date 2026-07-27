'use strict';

/**
 * Logic checks for lib/UserStatus.js against a fake Homey Web API.
 *
 * These need no Homey and no network: run them with `npm test`. They exist
 * because the interesting part of this app is not the Flow plumbing but the
 * decisions about null statuses, disabled accounts and the empty set.
 */

const test = require('node:test');
const assert = require('node:assert');

const UserStatus = require('../lib/UserStatus');

/**
 * Builds a UserStatus wired to a fake API, and captures anything it logs.
 */
function makeStatus(users, excluded = []) {
  const warnings = [];
  const homey = {
    settings: { get: (key) => (key === 'excluded_user_ids' ? excluded : undefined) },
    app: { log: (msg) => warnings.push(msg) },
    __: (key) => key,
  };
  const api = { users: { getUsers: async () => users } };

  return { status: new UserStatus({ homey, getApi: async () => api }), warnings };
}

/**
 * Shaped like the real getUsers(): an id-keyed object. Homey reports null, not
 * false, for a status it has never been told, so that is the default here.
 */
function users(...list) {
  const out = {};
  list.forEach((user, i) => {
    const id = user.id || `u${i}`;
    out[id] = {
      id, name: `User ${i}`, role: 'user', enabled: true, present: null, asleep: null, ...user,
    };
  });
  return out;
}

test('everyone is at home when every counted user is present', async () => {
  const { status } = makeStatus(users({ present: true }, { present: true }));
  assert.strictEqual(await status.isEveryoneHome(), true);
});

test('one user away is enough to make it false', async () => {
  const { status } = makeStatus(users({ present: true }, { present: false }));
  assert.strictEqual(await status.isEveryoneHome(), false);
});

test('a user whose presence was never set blocks everyone-home', async () => {
  const { status } = makeStatus(users({ present: true }, { present: null }));
  assert.strictEqual(await status.isEveryoneHome(), false);
});

test('an account disabled in Homey is ignored, even while away', async () => {
  const { status } = makeStatus(users({ present: true }, { present: false, enabled: false }));
  assert.strictEqual(await status.isEveryoneHome(), true);
});

test('a user excluded in the settings is ignored, even while away', async () => {
  const { status } = makeStatus(users({ id: 'a', present: true }, { id: 'b', present: false }), ['b']);
  assert.strictEqual(await status.isEveryoneHome(), true);
});

test('an empty counted set is false, not vacuously true, and says why', async () => {
  const { status, warnings } = makeStatus(users({ id: 'a', present: true }), ['a']);
  assert.strictEqual(await status.isEveryoneHome(), false);
  assert.ok(warnings.some((w) => w.includes('No users are being counted')), 'expected an explanatory log line');
});

test('a Homey with no users at all is false', async () => {
  const { status } = makeStatus({});
  assert.strictEqual(await status.isEveryoneHome(), false);
});

test('everyone is asleep when every counted user is asleep', async () => {
  const { status } = makeStatus(users({ asleep: true }, { asleep: true }));
  assert.strictEqual(await status.isEveryoneAsleep(), true);
});

test('one user awake is enough to make it false', async () => {
  const { status } = makeStatus(users({ asleep: true }, { asleep: false }));
  assert.strictEqual(await status.isEveryoneAsleep(), false);
});

test('home and asleep are answered independently', async () => {
  const { status } = makeStatus(users({ present: true, asleep: false }, { present: true, asleep: false }));
  assert.strictEqual(await status.isEveryoneHome(), true);
  assert.strictEqual(await status.isEveryoneAsleep(), false);
});

test('an excluded id left over from a deleted user is harmless', async () => {
  const { status } = makeStatus(users({ id: 'a', present: true }), ['ghost']);
  assert.strictEqual(await status.isEveryoneHome(), true);
});

test('the settings overview reports counted flags, known-status flags and verdicts', async () => {
  const { status } = makeStatus(users(
    { id: 'a', present: true, asleep: true },
    { id: 'b', present: true, asleep: true },
    { id: 'c', present: false, enabled: false },
  ), ['b']);

  const overview = await status.getOverview();
  const byId = (id) => overview.users.find((user) => user.id === id);

  assert.strictEqual(overview.users.length, 3, 'every user is listed, counted or not');
  assert.strictEqual(overview.countedCount, 1);
  assert.strictEqual(overview.everyoneHome, true);
  assert.strictEqual(overview.everyoneAsleep, true);
  assert.strictEqual(byId('b').counted, false, 'excluded in settings');
  assert.strictEqual(byId('c').counted, false, 'disabled in Homey');
  assert.strictEqual(byId('a').presenceKnown, true);
  assert.strictEqual(byId('c').sleepKnown, false);
});

test('concurrent evaluations share a single API call', async () => {
  // Both cards in one Flow evaluate together. Caching the settled result is not
  // enough for that: the in-flight promise has to be shared too.
  let calls = 0;
  const homey = {
    settings: { get: () => [] },
    app: { log: () => {} },
    __: (key) => key,
  };
  const api = {
    users: {
      getUsers: async () => {
        calls += 1;
        return users({ present: true });
      },
    },
  };

  const status = new UserStatus({ homey, getApi: async () => api });
  await Promise.all([status.isEveryoneHome(), status.isEveryoneAsleep(), status.isEveryoneHome()]);

  assert.strictEqual(calls, 1, `expected 1 API call, got ${calls}`);
});

test('a failed read is not cached, so the next evaluation retries', async () => {
  let calls = 0;
  const homey = {
    settings: { get: () => [] },
    app: { log: () => {} },
    __: (key) => key,
  };
  const api = {
    users: {
      getUsers: async () => {
        calls += 1;
        if (calls === 1) throw new Error('Homey not ready');
        return users({ present: true });
      },
    },
  };

  const status = new UserStatus({ homey, getApi: async () => api });
  await assert.rejects(() => status.isEveryoneHome(), /Homey not ready/);
  assert.strictEqual(await status.isEveryoneHome(), true, 'the retry should succeed');
  assert.strictEqual(calls, 2);
});
