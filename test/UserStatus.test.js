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

test('the watcher gets a fresh list, however recently one was read', async () => {
  // The whole response time of every trigger card rests on this. The watcher
  // polls faster than the list cache lives, so a cached answer would mean it
  // spent half its passes diffing a list it had already seen - detection would
  // silently run at the cache's speed rather than the poll's, and the fix for
  // the slow cards would be undone without a single test going red.
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

  // A condition card has just asked, so the cache is warm and well inside its TTL.
  await status.isEveryoneHome();
  assert.strictEqual(calls, 1);

  await status.snapshot({ fresh: true });
  assert.strictEqual(calls, 2, 'the watcher must not be handed the cached list');

  // And the poll refills the cache on its way past, so the condition cards that
  // follow it are both cheap and no more than one poll behind.
  await status.isEveryoneHome();
  assert.strictEqual(calls, 2, 'the fresh read should have refreshed the cache');
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

// ---------------------------------------------------------------------------
// The empty house, and counting
// ---------------------------------------------------------------------------

test('nobody home is true only when every counted user is out', async () => {
  const { status } = makeStatus(users({ present: false }, { present: false }));
  assert.strictEqual(await status.isNobodyHome(), true);
});

test('one person still in makes nobody-home false', async () => {
  const { status } = makeStatus(users({ present: false }, { present: true }));
  assert.strictEqual(await status.isNobodyHome(), false);
});

test('a presence Homey never set counts as out', async () => {
  const { status } = makeStatus(users({ present: null }));
  assert.strictEqual(await status.isNobodyHome(), true, 'not present is not present');
});

test('nobody home and everyone home are both false for an empty count', async () => {
  // Every user unticked: saying "the house is empty" would fire away-automations
  // at a full house, so both questions fail closed.
  const { status } = makeStatus(users({ id: 'a', present: false }), ['a']);
  assert.strictEqual(await status.isNobodyHome(), false);
  assert.strictEqual(await status.isEveryoneHome(), false);
});

test('counting covers each state a Flow can pick', async () => {
  const { status } = makeStatus(users(
    { present: true, asleep: true },
    { present: true, asleep: false },
    { present: false, asleep: false },
  ));

  assert.strictEqual(await status.countUsers('home'), 2);
  assert.strictEqual(await status.countUsers('away'), 1);
  assert.strictEqual(await status.countUsers('asleep'), 1);
  assert.strictEqual(await status.countUsers('awake'), 2);
  assert.strictEqual(await status.countUsers('home_awake'), 1);
  assert.strictEqual(await status.countUsers('home_asleep'), 1);
});

test('counting leaves out anyone who does not count', async () => {
  const { status } = makeStatus(users(
    { id: 'a', present: true },
    { id: 'b', present: true },
    { id: 'c', present: true, enabled: false },
  ), ['b']);

  assert.strictEqual(await status.countUsers('home'), 1, 'b is unticked, c is disabled');
});

test('an unknown state is a mistake worth reporting, not a zero', async () => {
  const { status } = makeStatus(users({ present: true }));
  await assert.rejects(() => status.countUsers('elsewhere'), /^Error: error\.invalid_request$/);
});

test('a state name that is only on the prototype is not a state', async () => {
  // A plain object lookup resolves these to functions, and filter() would then
  // happily count with Object's own methods.
  const { status } = makeStatus(users({ present: true }));

  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    await assert.rejects(() => status.countUsers(name), /^Error: error\.invalid_request$/, name);
  }
});

// ---------------------------------------------------------------------------
// One user at a time
// ---------------------------------------------------------------------------

test('a named user is at home only when Homey says so outright', async () => {
  const { status } = makeStatus(users(
    { id: 'home', present: true },
    { id: 'away', present: false },
    { id: 'unknown' },
  ));

  assert.strictEqual(await status.isUserHome('home'), true);
  assert.strictEqual(await status.isUserHome('away'), false);
  // Homey has never been told where this one is, so we cannot claim they are in.
  assert.strictEqual(await status.isUserHome('unknown'), false);
});

test('a named user is asleep wherever they are', async () => {
  const { status } = makeStatus(users(
    { id: 'hotel', present: false, asleep: true },
    { id: 'up', present: true, asleep: false },
    { id: 'unknown', present: true },
  ));

  assert.strictEqual(await status.isUserAsleep('hotel'), true, 'asleep elsewhere is still asleep');
  assert.strictEqual(await status.isUserAsleep('up'), false);
  assert.strictEqual(await status.isUserAsleep('unknown'), false, 'never set counts as awake');
});

test('a card naming a deleted user answers false rather than throwing', async () => {
  const { status } = makeStatus(users({ id: 'a', present: true }));

  // The card is the right place to complain about a user who no longer exists;
  // a condition that throws takes the whole Flow down with it.
  assert.strictEqual(await status.isUserHome('gone'), false);
  assert.strictEqual(await status.isUserAsleep('gone'), false);
  assert.strictEqual(await status.getUser('gone'), undefined);
});

test('excluded and disabled users can still be asked about by name', async () => {
  // These cards name one person, so they answer for anybody Homey knows. Who
  // counts towards the household is a different question, asked by other cards.
  const { status } = makeStatus(
    users({ id: 'off', present: true }, { id: 'disabled', present: true, enabled: false }),
    ['off'],
  );

  assert.strictEqual(await status.isUserHome('off'), true);
  assert.strictEqual(await status.isUserHome('disabled'), true);
});
