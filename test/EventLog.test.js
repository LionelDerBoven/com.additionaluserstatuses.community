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
