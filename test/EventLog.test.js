'use strict';

/**
 * Checks for lib/EventLog.js.
 *
 * The point of this class is that it cannot grow without bound, so most of these
 * are about the ceiling rather than the happy path.
 */

const test = require('node:test');
const assert = require('node:assert');

const EventLog = require('../lib/EventLog');

test('keeps entries newest first', () => {
  const log = new EventLog();
  log.add('first');
  log.add('second');

  assert.deepStrictEqual(log.list().map((e) => e.message), ['second', 'first']);
});

test('records the level, defaulting to info', () => {
  const log = new EventLog();
  log.add('plain');
  log.add('fired', 'trigger');

  const [newest, oldest] = log.list();
  assert.strictEqual(newest.level, 'trigger');
  assert.strictEqual(oldest.level, 'info');
});

test('never grows past the limit, however long the app runs', () => {
  const log = new EventLog({ limit: 10 });
  for (let i = 0; i < 1000; i += 1) log.add(`entry ${i}`);

  assert.strictEqual(log.list().length, 10, 'the ceiling is absolute');
  assert.strictEqual(log.list()[0].message, 'entry 999', 'and it keeps the newest');
});

test('a runaway message cannot bloat the buffer', () => {
  const log = new EventLog();
  log.add('x'.repeat(10000));

  const [only] = log.list();
  assert.ok(only.message.length < 250, `truncated to ${only.message.length} chars`);
  assert.ok(only.message.endsWith('…'), 'and says it was cut');
});

test('the whole buffer stays small at its worst case', () => {
  const log = new EventLog();
  // Fill every slot with a maximum-length message.
  for (let i = 0; i < 500; i += 1) log.add('y'.repeat(10000), 'error');

  const bytes = Buffer.byteLength(JSON.stringify(log.list()), 'utf8');
  assert.ok(bytes < 40 * 1024, `worst-case buffer is ${Math.round(bytes / 1024)} KB`);
});

test('clear empties it', () => {
  const log = new EventLog();
  log.add('something');
  log.clear();

  assert.deepStrictEqual(log.list(), []);
});

test('entries carry a timestamp', () => {
  const before = Date.now();
  const log = new EventLog();
  log.add('now');

  const [only] = log.list();
  assert.ok(only.at >= before && only.at <= Date.now());
});

test('list() returns a copy, so a caller cannot corrupt the buffer', () => {
  const log = new EventLog();
  log.add('one');

  log.list().push({ message: 'injected' });

  assert.strictEqual(log.list().length, 1);
});

// ---------------------------------------------------------------------------
// Persistence — opt-in, and debounced so a burst is one flash write
// ---------------------------------------------------------------------------

/** A Homey stand-in whose settings and timers the test drives by hand. */
function fakeHomey(initial = {}) {
  const store = { ...initial };
  const timers = [];
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
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    _store: store,
    _runTimers: () => {
      const due = timers.splice(0);
      due.forEach((fn) => fn());
    },
    _timerCount: () => timers.length,
  };
}

test('memory-only by default: nothing reaches settings', async () => {
  const homey = fakeHomey();
  const log = new EventLog({ homey });

  log.add('something');
  homey._runTimers();

  assert.strictEqual(homey._store.log_entries, undefined, 'no flash write');
});

test('with persistence on, a burst of events costs one write', async () => {
  const homey = fakeHomey({ log_persist: true });
  const log = new EventLog({ homey });

  log.add('one');
  log.add('two');
  log.add('three');

  assert.strictEqual(homey._timerCount(), 1, 'debounced into a single save');
  homey._runTimers();
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(homey._store.log_entries.length, 3);
});

test('a persisted log is restored on startup', () => {
  const homey = fakeHomey({
    log_persist: true,
    log_entries: [{ at: 1, level: 'info', message: 'from before' }],
  });

  const log = new EventLog({ homey });

  assert.deepStrictEqual(log.list().map((e) => e.message), ['from before']);
});

test('garbage in the stored log is ignored rather than shown', () => {
  const homey = fakeHomey({
    log_persist: true,
    log_entries: ['not an entry', { message: 'no timestamp' }, { at: 1, message: 'good' }],
  });

  const log = new EventLog({ homey });

  assert.deepStrictEqual(log.list().map((e) => e.message), ['good']);
});

test('turning persistence off removes the stored copy', async () => {
  const homey = fakeHomey({ log_persist: true, log_entries: [{ at: 1, message: 'x' }] });
  const log = new EventLog({ homey });

  homey._store.log_persist = false;
  await log.onPersistChanged(false);

  assert.strictEqual('log_entries' in homey._store, false, 'no orphan left in settings');
});

test('a restored log is still capped', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ at: i, level: 'info', message: `e${i}` }));
  const homey = fakeHomey({ log_persist: true, log_entries: many });

  const log = new EventLog({ homey, limit: 10 });

  assert.strictEqual(log.list().length, 10);
  assert.strictEqual(log.list()[0].message, 'e499', 'keeps the newest');
});
