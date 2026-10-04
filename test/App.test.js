'use strict';

/**
 * Checks for app.js, api.js and the status device.
 *
 * app.js and the drivers extend classes from the 'homey' module, which only
 * exists on a Homey. A minimal stand-in is slipped in while they load, so the
 * real classes run against fakes rather than being re-described in the test.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const EventEmitter = require('node:events');

class FakeApp {

  constructor() {
    this.logged = [];
    this.errored = [];
  }

  log(...args) {
    this.logged.push(args.join(' '));
  }

  error(...args) {
    this.errored.push(args.join(' '));
  }

}

const fakeHomeyModule = { App: FakeApp, Device: Object };

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') return fakeHomeyModule;
  return originalLoad.call(this, request, ...rest);
};

const App = require('../app');
const api = require('../api');
const StatusDevice = require('../drivers/status/device');
const StatusRegistry = require('../lib/StatusRegistry');

Module._load = originalLoad;

// Echoes the key and its placeholders, so a test can tell which translated
// message was used without depending on the English wording.
const translate = (key, tokens) => (tokens ? `${key} ${JSON.stringify(tokens)}` : key);

const ALICE = { id: 'u-alice', name: 'Alice Secret' };

/** An app with just the collaborators a test asks for. */
function makeApp(parts = {}) {
  const app = new App();
  const log = [];

  app.homey = {
    __: translate,
    settings: { get: () => undefined },
    i18n: { getLanguage: () => 'nl' },
    clock: { getTimezone: () => 'Europe/Brussels' },
    ...parts.homey,
  };
  app.eventLog = { add: (message, level) => log.push({ message, level }) };
  app.statusEdges = new Map();
  app.tokens = { refresh: async () => {} };
  app.userStatus = {
    getUser: async (id) => [ALICE].find((user) => user.id === id),
    getOverview: async () => ({ users: [ALICE] }),
    getEligibleUsers: async () => [ALICE],
    fetchUsers: async () => [ALICE],
    countUsers: async () => 1,
    ...parts.userStatus,
  };
  Object.assign(app, parts.app);

  return { app, log };
}

// ---------------------------------------------------------------------------
// Fix: ids that are not Homey users
// ---------------------------------------------------------------------------

test('setVacation refuses a user id that no Homey user has, and stores nothing', async () => {
  const writes = [];
  const { app } = makeApp({ app: { vacation: { set: async (...args) => writes.push(args) } } });

  await assert.rejects(() => app.setVacation('made-up-id', true), /^Error: error\.unknown_user$/);
  assert.deepStrictEqual(writes, []);

  await app.setVacation(ALICE.id, true);
  assert.deepStrictEqual(writes, [[ALICE.id, true]]);
});

test('setStatus refuses a user id that no Homey user has, and stores nothing', async () => {
  const writes = [];
  const store = { set: async (...args) => writes.push(args), getIds: () => [] };
  const { app } = makeApp({
    app: { statuses: { store: () => store, list: () => [] } },
  });

  await assert.rejects(() => app.setStatus('wfh', 'made-up-id', true), /^Error: error\.unknown_user$/);
  assert.deepStrictEqual(writes, []);

  await app.setStatus('wfh', ALICE.id, true);
  assert.deepStrictEqual(writes, [[ALICE.id, true]]);
});

test('setStatus still reports an unknown status before looking at the user', async () => {
  const { app } = makeApp({ app: { statuses: { store: () => null, list: () => [] } } });

  await assert.rejects(() => app.setStatus('gone', ALICE.id, true), /error\.no_such_status/);
});

test('the API refuses an id of the wrong shape with a translated error', async () => {
  const homey = { __: translate, app: { setVacation: async () => assert.fail('must not be reached') } };

  for (const userId of [undefined, 42, '', 'x'.repeat(65), { toString: () => 'a' }]) {
    await assert.rejects(
      () => api.setVacation({ homey, body: { userId, onVacation: true } }),
      /^Error: error\.invalid_request$/,
    );
  }
});

test('the API passes a well-formed id through to the app', async () => {
  const calls = [];
  const homey = { __: translate, app: { setVacation: async (...args) => calls.push(args) } };

  await api.setVacation({ homey, body: { userId: ALICE.id, onVacation: true } });
  assert.deepStrictEqual(calls, [[ALICE.id, true]]);
});

// ---------------------------------------------------------------------------
// Fix: counting cards with a count that is not a number
// ---------------------------------------------------------------------------

/** Runs registerFlowCards() against cards that just remember their run listeners. */
function registerCards(app) {
  const listeners = {};
  const card = (id) => ({
    registerRunListener: (fn) => {
      listeners[id] = fn;
    },
    registerArgumentAutocompleteListener: () => {},
  });

  app.homey.flow = {
    getConditionCard: card,
    getActionCard: card,
    getTriggerCard: card,
  };
  app.registerFlowCards();

  return listeners;
}

test('the counting cards refuse a count that is not a number', async () => {
  const { app } = makeApp({
    app: {
      vacation: {},
      statuses: { store: () => ({ has: () => true }) },
    },
  });
  const listeners = registerCards(app);

  for (const count of [undefined, 'abc', NaN, Infinity]) {
    await assert.rejects(
      () => listeners.count_users({ state: 'home', operator: 'min', count }),
      /^Error: error\.invalid_request$/,
    );
    await assert.rejects(
      () => listeners.count_status({ status: { id: 'wfh' }, operator: 'min', count }),
      /^Error: error\.invalid_request$/,
    );
  }
});

test('the counting cards still compare a numeric count, including one typed as text', async () => {
  const { app } = makeApp({
    app: {
      vacation: {},
      statuses: { store: () => ({ has: () => true }) },
    },
  });
  const listeners = registerCards(app);

  // One user, who is counted and holds the status.
  assert.strictEqual(await listeners.count_users({ state: 'home', operator: 'min', count: '1' }), true);
  assert.strictEqual(await listeners.count_users({ state: 'home', operator: 'max', count: 0 }), false);
  assert.strictEqual(await listeners.count_status({ status: { id: 'wfh' }, operator: 'eq', count: '1' }), true);
  assert.strictEqual(await listeners.count_status({ status: { id: 'wfh' }, operator: 'eq', count: 0 }), false);
});

// ---------------------------------------------------------------------------
// Fix: household names stay out of Homey's diagnostic log
// ---------------------------------------------------------------------------

test('record() writes the diagnostic line to Homey\'s log and the message to the in-app log', () => {
  const { app, log } = makeApp();

  app.record('Alice Secret came home.', 'info', 'A user came home.');
  app.record('Alice Secret broke it.', 'error', 'Something broke.');

  assert.deepStrictEqual(app.logged, ['A user came home.']);
  assert.deepStrictEqual(app.errored, ['Something broke.']);
  assert.deepStrictEqual(log.map((entry) => entry.message), ['Alice Secret came home.', 'Alice Secret broke it.']);
});

test('record() without a diagnostic line logs the message itself', () => {
  const { app } = makeApp();
  app.record('App started.');

  assert.deepStrictEqual(app.logged, ['App started.']);
});

/** Everything wireWatcher() looks up on `this`, as cards that only count triggers. */
function stubTriggerCards(app) {
  const fired = [];
  for (const name of Object.keys(app).concat([
    'triggerEveryoneHomeAsleep', 'triggerEveryoneAsleep', 'triggerFirstHomeAwake', 'triggerFirstHomeAsleep',
    'triggerFirstAsleep', 'triggerFirstAwake', 'triggerSomeoneHomeAwake', 'triggerEveryoneHomeAwake',
    'triggerEveryoneAwake', 'triggerEveryoneHomeArrived', 'triggerEveryoneLeft', 'triggerFirstArrived',
    'triggerUserLeft', 'triggerUserArrived', 'triggerUserAsleep', 'triggerUserAwake',
    'triggerStatusStarted', 'triggerStatusEnded', 'triggerVacationStarted', 'triggerVacationEnded',
    'triggerEveryoneStatusStarted', 'triggerEveryoneStatusEnded',
    'triggerEveryoneVacationStarted', 'triggerEveryoneVacationEnded',
  ])) {
    if (name.startsWith('trigger')) app[name] = { trigger: async (...args) => fired.push([name, ...args]) };
  }
  return fired;
}

test('no watcher event puts a household member\'s name in Homey\'s log', async () => {
  const watcher = new EventEmitter();
  const store = { has: () => true, set: async () => {} };
  const { app, log } = makeApp({
    app: {
      watcher,
      statuses: {
        autoReturning: () => [{ id: 'wfh', name: 'Working from home' }, { id: StatusRegistry.VACATION }],
        store: () => store,
      },
    },
  });
  stubTriggerCards(app);
  app.wireWatcher();

  const named = [
    'everyone-home-asleep', 'everyone-asleep', 'first-home-awake', 'someone-home-awake', 'first-home-asleep',
    'first-asleep', 'first-awake', 'everyone-home-awake', 'everyone-awake', 'first-arrived',
  ];
  for (const event of named) watcher.emit(event, ALICE);
  for (const event of ['user-left', 'user-arrived', 'user-asleep', 'user-awake', 'arrived']) watcher.emit(event, ALICE);
  for (const [field, value] of [['present', true], ['present', false], ['asleep', true], ['asleep', false]]) {
    watcher.emit('user-changed', { ...ALICE, field, value });
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(app.logged.length > 0, 'something is still logged for diagnostics');
  assert.ok(!app.logged.concat(app.errored).some((line) => line.includes('Alice')), 'no name in Homey\'s log');
  assert.ok(log.some((entry) => entry.message.includes('Alice Secret')), 'the in-app log keeps the name');
});

test('status changes put no name in Homey\'s log either', async () => {
  const store = { has: () => true };
  const { app, log } = makeApp({
    homey: { drivers: { getDriver: () => ({ getDevices: () => [] }) } },
    app: {
      statuses: {
        get: (id) => ({ id, name: 'Working from home' }),
        store: () => store,
      },
    },
  });
  stubTriggerCards(app);

  await app.onStatusChanged('wfh', { added: [ALICE.id], removed: [] });
  await app.onStatusChanged(StatusRegistry.VACATION, { added: [], removed: [ALICE.id] });

  assert.ok(app.logged.length >= 2);
  assert.ok(!app.logged.concat(app.errored).some((line) => line.includes('Alice')));
  assert.ok(log.some((entry) => entry.message.includes('Alice Secret')));
});

// ---------------------------------------------------------------------------
// Fix: log times and limits for the settings page
// ---------------------------------------------------------------------------

test('the log preferences carry the Homey\'s own timezone', () => {
  const { app } = makeApp();

  assert.strictEqual(app.getLogPrefs().timezone, 'Europe/Brussels');
});

test('the status list tells the settings page the limits it has to respect', async () => {
  const { app } = makeApp({ app: { statuses: { list: () => [] } } });

  assert.deepStrictEqual((await app.getStatuses()).limits, {
    maxStatuses: StatusRegistry.MAX_CUSTOM,
    maxNameLength: StatusRegistry.MAX_NAME,
  });
});

// ---------------------------------------------------------------------------
// Fix: a deleted status takes its tiles and its edge with it
// ---------------------------------------------------------------------------

test('deleting a status marks every status tile for a re-check and drops its edge', async () => {
  let statuses = [{ id: 'keep' }, { id: 'gone' }];
  const registry = new EventEmitter();
  registry.list = () => statuses;
  registry.store = () => ({ listenerCount: () => 1, on: () => {} });

  const checked = [];
  const device = (name) => ({ checkStillValid: async () => checked.push(name) });
  const { app } = makeApp({
    homey: { drivers: { getDriver: () => ({ getDevices: () => [device('a'), device('b')] }) } },
    app: { statuses: registry },
  });

  app.wireStatusTriggers();
  app.statusEdges.set('keep', { everyone: true, nobody: false });
  app.statusEdges.set('gone', { everyone: true, nobody: false });

  statuses = [{ id: 'keep' }];
  registry.emit('statuses-changed');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(checked, ['a', 'b']);
  assert.deepStrictEqual([...app.statusEdges.keys()], ['keep']);
});

test('a tile that cannot be re-checked does not stop the others or the event', async () => {
  const registry = new EventEmitter();
  registry.list = () => [];

  const checked = [];
  const broken = {
    checkStillValid: async () => {
      throw new Error('boom');
    },
  };
  const fine = { checkStillValid: async () => checked.push('fine') };
  const { app } = makeApp({
    homey: { drivers: { getDriver: () => ({ getDevices: () => [broken, fine] }) } },
    app: { statuses: registry },
  });

  app.wireStatusTriggers();
  registry.emit('statuses-changed');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(checked, ['fine']);
  assert.ok(app.errored.some((line) => line.includes('boom')));
});

// ---------------------------------------------------------------------------
// Status device
// ---------------------------------------------------------------------------

test('a status tile says its status is gone, not that the app is slow', async () => {
  const device = new StatusDevice();
  device.statusId = 'gone';
  device.homey = { __: translate, app: { statuses: { store: () => null } } };

  await assert.rejects(() => device.getStore(), /^Error: device\.status_gone$/);
});

test('a status tile hands back the store of a status that exists', async () => {
  const store = {};
  const device = new StatusDevice();
  device.statusId = 'wfh';
  device.homey = { __: translate, app: { statuses: { store: () => store } } };

  assert.strictEqual(await device.getStore(), store);
});

test('a status tile times out as "not ready" when the app never appears', async () => {
  const device = new StatusDevice();
  device.statusId = 'wfh';
  device.homey = { __: translate, app: undefined, setTimeout: (fn) => setTimeout(fn, 1) };

  assert.strictEqual(await device.getStore(20), null);
});
