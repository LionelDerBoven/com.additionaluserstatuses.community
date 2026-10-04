'use strict';

/**
 * Checks for lib/StatusRegistry.js and lib/StatusStore.js.
 *
 * Vacation shipped eight releases before statuses existed, and its cards, device
 * and settings key are in people's Flows. So the thing worth proving here is not
 * that a status can be stored, but that generalising did not move vacation: same
 * key, same behaviour, same exclusion from the 'everyone' cards.
 */

const test = require('node:test');
const assert = require('node:assert');

const StatusRegistry = require('../lib/StatusRegistry');
const StatusStore = require('../lib/StatusStore');
const VacationStore = require('../lib/VacationStore');
const UserStatus = require('../lib/UserStatus');

function fakeHomey(initial = {}) {
  const store = { ...initial };
  return {
    settings: {
      get: (key) => store[key],
      set: async (key, value) => {
        store[key] = value;
      },
      unset: async (key) => {
        delete store[key];
      },
    },
    app: { log: () => {}, error: () => {} },
    __: (key) => key,
    _store: store,
  };
}

function makeRegistry(initial = {}) {
  const homey = fakeHomey(initial);
  const vacation = new VacationStore({ homey });
  return { homey, vacation, registry: new StatusRegistry({ homey, vacation }) };
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

// ---------------------------------------------------------------------------
// Vacation must not have moved
// ---------------------------------------------------------------------------

test('vacation still reads and writes the key it always had', async () => {
  const { homey, registry } = makeRegistry();

  await registry.store('vacation').set('a', true);

  assert.deepStrictEqual(homey._store.vacation_user_ids, ['a'], 'the old key, untouched');
  assert.strictEqual(homey._store.status_vacation_user_ids, undefined, 'and no second home for it');
});

test('the registry hands back the very vacation store it was given', () => {
  const { vacation, registry } = makeRegistry();
  assert.strictEqual(registry.store('vacation'), vacation);
});

test('a settings file written before statuses existed still works', () => {
  const { registry } = makeRegistry({ vacation_user_ids: ['a', 'b'] });

  assert.strictEqual(registry.has('vacation', 'a'), true);
  assert.deepStrictEqual([...registry.excludedUserIds()].sort(), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

test('two statuses come with the app, and vacation is the excluding one', () => {
  const { registry } = makeRegistry();
  const list = registry.list();

  assert.deepStrictEqual(list.map((s) => s.id), ['vacation', 'dnd']);
  assert.strictEqual(list[0].excludeFromEveryone, true, 'vacation excludes, as it always did');
  assert.strictEqual(list[1].excludeFromEveryone, false, 'do not disturb says nothing about the household');
  assert.ok(list.every((s) => s.builtin));
});

test('custom statuses get their own settings key', async () => {
  const { homey, registry } = makeRegistry();
  await registry.saveCustom([{ id: 'wfh', name: 'Working from home' }]);

  await registry.store('wfh').set('a', true);

  assert.deepStrictEqual(homey._store.status_wfh_user_ids, ['a']);
  assert.deepStrictEqual(registry.list().map((s) => s.id), ['vacation', 'dnd', 'wfh']);
});

test('a status nobody defined has no store, so a stale card fails loudly', () => {
  const { registry } = makeRegistry();

  assert.strictEqual(registry.store('gone'), null);
  assert.strictEqual(registry.get('gone'), null);
  assert.strictEqual(registry.has('gone', 'a'), false);
});

test('rubbish in the settings is ignored rather than believed', () => {
  const { registry } = makeRegistry({
    custom_statuses: [
      null,
      { id: 'Not Valid!', name: 'x' },
      { id: 'ok', name: 'Fine' },
      { id: 'vacation', name: 'Hijack' },
    ],
  });

  assert.deepStrictEqual(registry.getCustom().map((s) => s.id), ['ok']);
  assert.strictEqual(registry.list()[0].excludeFromEveryone, true, 'the real vacation survives');
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

test('deleting a status forgets who held it', async () => {
  const { homey, registry } = makeRegistry();
  await registry.saveCustom([{ id: 'wfh', name: 'Working from home' }]);
  await registry.store('wfh').set('a', true);

  await registry.saveCustom([]);

  assert.strictEqual(homey._store.status_wfh_user_ids, undefined, 'no holders left behind to come back');
  assert.strictEqual(registry.store('wfh'), null);
});

test('a status cannot be defined twice, or steal a built-in id', async () => {
  const { registry } = makeRegistry();

  const invalid = /^Error: error\.invalid_request$/;

  await assert.rejects(() => registry.saveCustom([{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }]), invalid);
  await assert.rejects(() => registry.saveCustom([{ id: 'vacation', name: 'X' }]), invalid);
  await assert.rejects(() => registry.saveCustom([{ id: 'no spaces', name: 'X' }]), invalid);
  await assert.rejects(() => registry.saveCustom('not a list'), invalid);
});

test('the limits on a custom status come back as translated errors that name the limit', async () => {
  // __ echoes the key here, so the placeholders are checked through a fake
  // that appends them.
  const { homey, registry } = makeRegistry();
  homey.__ = (key, tokens) => (tokens ? `${key} ${JSON.stringify(tokens)}` : key);

  await assert.rejects(() => registry.saveCustom([{ id: 'ok', name: '  ' }]), /^Error: error\.status_name_missing$/);
  await assert.rejects(
    () => registry.saveCustom([{ id: 'ok', name: 'x'.repeat(StatusRegistry.MAX_NAME + 1) }]),
    new RegExp(`^Error: error\\.status_name_too_long \\{"max":${StatusRegistry.MAX_NAME}\\}$`),
  );

  const tooMany = Array.from({ length: StatusRegistry.MAX_CUSTOM + 1 }, (_, i) => ({ id: `s${i}`, name: `S${i}` }));
  await assert.rejects(
    () => registry.saveCustom(tooMany),
    new RegExp(`^Error: error\\.too_many_statuses \\{"max":${StatusRegistry.MAX_CUSTOM}\\}$`),
  );

  // Exactly at the limit is fine.
  await registry.saveCustom(tooMany.slice(0, StatusRegistry.MAX_CUSTOM));
});

test('saving announces itself, so tokens and devices can follow', async () => {
  const { registry } = makeRegistry();
  let announced = 0;
  registry.on('statuses-changed', () => {
    announced += 1;
  });

  await registry.saveCustom([{ id: 'wfh', name: 'Working from home' }]);

  assert.strictEqual(announced, 1);
});

// ---------------------------------------------------------------------------
// What the 'everyone' cards see
// ---------------------------------------------------------------------------

test('a custom status can be told to exclude, and then it does', async () => {
  const { homey, registry } = makeRegistry();
  await registry.saveCustom([{ id: 'away', name: 'Away for a month', excludeFromEveryone: true }]);
  await registry.store('away').set('a', true);

  const api = { users: { getUsers: async () => users({ id: 'a', present: false }, { id: 'b', present: true }) } };
  const status = new UserStatus({ homey, getApi: async () => api, statuses: registry });

  assert.deepStrictEqual((await status.getCountedUsers()).map((u) => u.id), ['b']);
  assert.strictEqual(await status.isEveryoneHome(), true, 'b is home, and a no longer counts');
});

test('do not disturb leaves the household exactly as it was', async () => {
  const { homey, registry } = makeRegistry();
  await registry.store('dnd').set('a', true);

  const api = { users: { getUsers: async () => users({ id: 'a', present: false }, { id: 'b', present: true }) } };
  const status = new UserStatus({ homey, getApi: async () => api, statuses: registry });

  assert.strictEqual(await status.isEveryoneHome(), false, 'a still counts, and is out');
});

test('auto-return lists only the statuses that asked for it', async () => {
  const { registry } = makeRegistry({ vacation_auto_return: false });
  await registry.saveCustom([{ id: 'walk', name: 'Out with the dog', autoReturn: true }]);

  assert.deepStrictEqual(registry.autoReturning().map((s) => s.id), ['walk']);
});

// ---------------------------------------------------------------------------
// The store itself
// ---------------------------------------------------------------------------

test('a bulk change is one write and one announcement', async () => {
  const homey = fakeHomey();
  const store = new StatusStore({ homey, settingKey: 'status_x_user_ids' });

  let announcements = 0;
  store.on('change', () => {
    announcements += 1;
  });

  await store.setMany(['a', 'b', 'c'], []);

  assert.strictEqual(announcements, 1, 'three people, one bedtime');
  assert.deepStrictEqual(store.getIds(), ['a', 'b', 'c']);
});

test('setting what is already set changes nothing and says so', async () => {
  const homey = fakeHomey();
  const store = new StatusStore({ homey, settingKey: 'status_x_user_ids' });
  await store.set('a', true);

  let announcements = 0;
  store.on('change', () => {
    announcements += 1;
  });

  assert.strictEqual(await store.set('a', true), false);
  assert.strictEqual(announcements, 0);
});

test('the overview counts the same household the cards do', async () => {
  // A page that says somebody counts while the cards leave them out is worse
  // than no page at all, so both must read the same rule.
  const { homey, registry } = makeRegistry();
  await registry.saveCustom([{ id: 'away', name: 'Away for a month', excludeFromEveryone: true }]);
  await registry.store('away').set('a', true);

  const api = { users: { getUsers: async () => users({ id: 'a', present: true }, { id: 'b', present: true }) } };
  const status = new UserStatus({ homey, getApi: async () => api, statuses: registry });

  const overview = await status.getOverview();
  const counted = await status.getCountedUsers();

  assert.strictEqual(overview.countedCount, counted.length);
  assert.deepStrictEqual(overview.users.filter((u) => u.counted).map((u) => u.id), ['b']);
  assert.strictEqual(overview.users.find((u) => u.id === 'a').onVacation, false, 'excluded, but not by vacation');
});
