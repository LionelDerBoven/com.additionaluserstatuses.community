'use strict';

/**
 * Checks for VacationStore and the vacation-aware parts of UserStatus.
 *
 * The interesting behaviour is not "can we store an id" but how vacation
 * interacts with the existing 'everyone' cards - who gets excluded, and what the
 * cards answer at the edges (nobody eligible, everybody away).
 */

const test = require('node:test');
const assert = require('node:assert');

const VacationStore = require('../lib/VacationStore');
const UserStatus = require('../lib/UserStatus');

/** A settings object backed by a plain map, as homey.settings behaves. */
function fakeHomey(initial = {}) {
  const store = { ...initial };
  return {
    settings: {
      get: (key) => store[key],
      set: async (key, value) => {
        store[key] = value;
      },
    },
    app: { log: () => {}, error: () => {} },
    __: (key) => key,
    _store: store,
  };
}

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

function makeStatus(homey, userList) {
  const vacation = new VacationStore({ homey });
  const api = { users: { getUsers: async () => userList } };
  const status = new UserStatus({ homey, getApi: async () => api, vacation });
  return { status, vacation };
}

// ---------------------------------------------------------------------------
// VacationStore
// ---------------------------------------------------------------------------

test('set() stores an id and reports that something changed', async () => {
  const homey = fakeHomey();
  const store = new VacationStore({ homey });

  assert.strictEqual(await store.set('a', true), true);
  assert.strictEqual(store.isOnVacation('a'), true);
});

test('setting the same value twice changes nothing the second time', async () => {
  const homey = fakeHomey();
  const store = new VacationStore({ homey });

  await store.set('a', true);
  // Matters because every change emits, and an emit fires Flow triggers.
  assert.strictEqual(await store.set('a', true), false);
});

test('a change emits exactly once, listing what moved', async () => {
  const homey = fakeHomey();
  const store = new VacationStore({ homey });
  const events = [];
  store.on('change', (payload) => events.push(payload));

  await store.setMany(['a', 'b'], []);

  assert.strictEqual(events.length, 1, 'a bulk change is one event, not two');
  assert.deepStrictEqual(events[0].added.sort(), ['a', 'b']);
  assert.deepStrictEqual(events[0].removed, []);
});

test('a garbled stored value does not take the app down', () => {
  // Settings can hold whatever was last written, including from an older version.
  const store = new VacationStore({ homey: fakeHomey({ vacation_user_ids: 'not-an-array' }) });
  assert.deepStrictEqual(store.getIds(), []);
  assert.strictEqual(store.isOnVacation('a'), false);
});

test('auto-return defaults to on', () => {
  const store = new VacationStore({ homey: fakeHomey() });
  assert.strictEqual(store.isAutoReturnEnabled(), true);
});

test('pruneUnknown drops ids for users who no longer exist', async () => {
  const homey = fakeHomey();
  const store = new VacationStore({ homey });
  await store.setMany(['a', 'ghost'], []);

  await store.pruneUnknown(['a']);
  assert.deepStrictEqual(store.getIds(), ['a']);
});

// ---------------------------------------------------------------------------
// Vacation x the 'everyone' cards
// ---------------------------------------------------------------------------

test('a user on vacation is left out of "everyone is at home"', async () => {
  const homey = fakeHomey();
  const { status, vacation } = makeStatus(homey, users(
    { id: 'a', present: true },
    { id: 'b', present: false },
  ));

  assert.strictEqual(await status.isEveryoneHome(), false);

  // This is the whole point: b is away on holiday, so a being home is enough.
  await vacation.set('b', true);
  assert.strictEqual(await status.isEveryoneHome(), true);
});

test('clearing vacation restores the literal reading', async () => {
  const homey = fakeHomey();
  const { status, vacation } = makeStatus(homey, users(
    { id: 'a', present: true },
    { id: 'b', present: false },
  ));
  await vacation.set('b', true);
  assert.strictEqual(await status.isEveryoneHome(), true);

  // Nobody on vacation is the whole "off switch" the feature needs: nothing is
  // excluded, so the cards read exactly as they did before vacation existed.
  await vacation.set('b', false);
  assert.strictEqual(await status.isEveryoneHome(), false);
});

test('everyone on vacation empties the counted set, so the cards are false', async () => {
  const homey = fakeHomey();
  const { status, vacation } = makeStatus(homey, users({ id: 'a', present: true }));

  await vacation.set('a', true);
  assert.strictEqual(await status.isEveryoneHome(), false);
});

test('excluded users are not asked about vacation at all', async () => {
  const homey = fakeHomey({ excluded_user_ids: ['b'] });
  const { status, vacation } = makeStatus(homey, users(
    { id: 'a', present: true },
    { id: 'b', present: true },
  ));

  await vacation.set('a', true);
  // Only 'a' is eligible, and 'a' is on vacation, so everyone eligible is away.
  assert.strictEqual(await status.isEveryoneOnVacation(), true);
});

// ---------------------------------------------------------------------------
// The vacation conditions
// ---------------------------------------------------------------------------

test('everyone / nobody on vacation answer independently', async () => {
  const homey = fakeHomey();
  const { status, vacation } = makeStatus(homey, users({ id: 'a' }, { id: 'b' }));

  assert.strictEqual(await status.isNobodyOnVacation(), true);
  assert.strictEqual(await status.isEveryoneOnVacation(), false);

  await vacation.set('a', true);
  assert.strictEqual(await status.isNobodyOnVacation(), false, 'someone is away');
  assert.strictEqual(await status.isEveryoneOnVacation(), false, 'but not everyone');

  await vacation.set('b', true);
  assert.strictEqual(await status.isEveryoneOnVacation(), true);
});

test('a Homey with no eligible users is never "everyone on vacation"', async () => {
  const homey = fakeHomey();
  const { status } = makeStatus(homey, {});
  assert.strictEqual(await status.isEveryoneOnVacation(), false);
});

// ---------------------------------------------------------------------------
// Everyone at home is asleep
// ---------------------------------------------------------------------------

test('everyone at home is asleep ignores whoever is out', async () => {
  const homey = fakeHomey();
  const { status } = makeStatus(homey, users(
    { id: 'a', present: true, asleep: true },
    { id: 'b', present: false, asleep: false },
  ));

  // The plain card cannot be true while b is out; this one can, which is the
  // entire reason it exists.
  assert.strictEqual(await status.isEveryoneAsleep(), false);
  assert.strictEqual(await status.isEveryoneHomeAsleep(), true);
});

test('one person at home still awake makes it false', async () => {
  const homey = fakeHomey();
  const { status } = makeStatus(homey, users(
    { id: 'a', present: true, asleep: true },
    { id: 'b', present: true, asleep: false },
  ));
  assert.strictEqual(await status.isEveryoneHomeAsleep(), false);
});

test('an empty house is false, not vacuously true', async () => {
  const homey = fakeHomey();
  const { status } = makeStatus(homey, users(
    { id: 'a', present: false, asleep: false },
  ));
  // Otherwise bedtime automations would fire at a house with nobody in it.
  assert.strictEqual(await status.isEveryoneHomeAsleep(), false);
});

test('someone at home whose sleep was never set blocks it', async () => {
  const homey = fakeHomey();
  const { status } = makeStatus(homey, users(
    { id: 'a', present: true, asleep: true },
    { id: 'b', present: true, asleep: null },
  ));
  assert.strictEqual(await status.isEveryoneHomeAsleep(), false);
});

test('a vacationing user who still reads as present is ignored', async () => {
  const homey = fakeHomey();
  const { status, vacation } = makeStatus(homey, users(
    { id: 'a', present: true, asleep: true },
    { id: 'b', present: true, asleep: false },
  ));

  await vacation.set('b', true);
  assert.strictEqual(await status.isEveryoneHomeAsleep(), true);
});

// ---------------------------------------------------------------------------
// Settings overview
// ---------------------------------------------------------------------------

test('the overview reports vacation flags and the feature toggles', async () => {
  const homey = fakeHomey();
  const { status, vacation } = makeStatus(homey, users(
    { id: 'a', present: true, asleep: true },
    { id: 'b', present: true, asleep: false },
  ));
  await vacation.set('b', true);

  const overview = await status.getOverview();
  const byId = (id) => overview.users.find((user) => user.id === id);

  assert.strictEqual(byId('b').onVacation, true);
  assert.strictEqual(byId('b').counted, false);
  assert.strictEqual(byId('a').counted, true);
  assert.strictEqual(overview.countedCount, 1);
  assert.strictEqual(overview.everyoneHomeAsleep, true);
  assert.strictEqual(overview.autoReturnEnabled, true);
});

// ---------------------------------------------------------------------------
// Exactly one at home is awake
//
// The first six cases are the truth table from the HomeyScript this card
// replaces, so the card is verified to behave the way that script intended.
// ---------------------------------------------------------------------------

test('nobody home -> false', async () => {
  const { status } = makeStatus(fakeHomey(), users(
    { id: 'a', present: false, asleep: false },
  ));
  assert.strictEqual(await status.isExactlyOneHomeAwake(), false);
});

test('one home and asleep -> false', async () => {
  const { status } = makeStatus(fakeHomey(), users(
    { id: 'a', present: true, asleep: true },
  ));
  assert.strictEqual(await status.isExactlyOneHomeAwake(), false);
});

test('one home and awake -> true (the whole point of the card)', async () => {
  const { status } = makeStatus(fakeHomey(), users(
    { id: 'a', present: true, asleep: false },
  ));
  assert.strictEqual(await status.isExactlyOneHomeAwake(), true);
});

test('two home, both asleep -> false', async () => {
  const { status } = makeStatus(fakeHomey(), users(
    { id: 'a', present: true, asleep: true },
    { id: 'b', present: true, asleep: true },
  ));
  assert.strictEqual(await status.isExactlyOneHomeAwake(), false);
});

test('two home, one awake -> true (first up, or last still awake)', async () => {
  const { status } = makeStatus(fakeHomey(), users(
    { id: 'a', present: true, asleep: false },
    { id: 'b', present: true, asleep: true },
  ));
  assert.strictEqual(await status.isExactlyOneHomeAwake(), true);
});

test('two home, both awake -> false', async () => {
  const { status } = makeStatus(fakeHomey(), users(
    { id: 'a', present: true, asleep: false },
    { id: 'b', present: true, asleep: false },
  ));
  assert.strictEqual(await status.isExactlyOneHomeAwake(), false);
});

test('someone awake but away does not count', async () => {
  const { status } = makeStatus(fakeHomey(), users(
    { id: 'a', present: true, asleep: false },
    { id: 'b', present: false, asleep: false },
  ));
  // b is awake but out, so a is still the only one awake at home.
  assert.strictEqual(await status.isExactlyOneHomeAwake(), true);
});

test('a never-set sleep status counts as awake', async () => {
  const { status } = makeStatus(fakeHomey(), users(
    { id: 'a', present: true, asleep: null },
  ));
  assert.strictEqual(await status.isExactlyOneHomeAwake(), true);
});

test('a second awake person on vacation is ignored', async () => {
  const homey = fakeHomey();
  const { status, vacation } = makeStatus(homey, users(
    { id: 'a', present: true, asleep: false },
    { id: 'b', present: true, asleep: false },
  ));
  assert.strictEqual(await status.isExactlyOneHomeAwake(), false);

  await vacation.set('b', true);
  assert.strictEqual(await status.isExactlyOneHomeAwake(), true);
});

test('an excluded awake person is ignored', async () => {
  const { status } = makeStatus(fakeHomey({ excluded_user_ids: ['b'] }), users(
    { id: 'a', present: true, asleep: false },
    { id: 'b', present: true, asleep: false },
  ));
  assert.strictEqual(await status.isExactlyOneHomeAwake(), true);
});
