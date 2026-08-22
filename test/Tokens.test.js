'use strict';

/**
 * Checks for lib/Tokens.js.
 *
 * The tags are what a Flow reads when no card fired, so the one thing that must
 * never happen is a tag disagreeing with the card that answers the same
 * question. These pin each tag to the same household the cards count.
 */

const test = require('node:test');
const assert = require('node:assert');

const { TOKENS } = require('../lib/Tokens');

const spec = (id) => TOKENS.find((t) => t.id === id);

/** counted = what the 'everyone' cards look at; all = every Homey user. */
function household() {
  const all = [
    {
      name: 'Alex', present: true, asleep: false, counted: true, onVacation: false,
    },
    {
      name: 'Sam', present: true, asleep: true, counted: true, onVacation: false,
    },
    {
      name: 'Robin', present: false, asleep: false, counted: false, onVacation: true,
    },
  ];

  return { all, counted: all.filter((user) => user.counted) };
}

const value = (id) => {
  const { all, counted } = household();
  return spec(id).of(counted, all);
};

test('every tag has an id and a type Homey accepts', () => {
  for (const token of TOKENS) {
    assert.match(token.id, /^[a-z_]+$/, `${token.id} must be a plain id`);
    assert.ok(['number', 'string'].includes(token.type), `${token.id} has type ${token.type}`);
    assert.strictEqual(typeof token.of, 'function');
  }
});

test('the counting tags describe the counted household', () => {
  assert.strictEqual(value('count_home'), 2);
  assert.strictEqual(value('count_away'), 0, 'Robin is on vacation, so does not count');
  assert.strictEqual(value('count_awake'), 1);
  assert.strictEqual(value('count_asleep'), 1);
});

test('the vacation tags count exactly the people the others leave out', () => {
  assert.strictEqual(value('count_vacation'), 1);
  assert.strictEqual(value('names_vacation'), 'Robin');
});

test('name tags read as a sentence, and are empty for nobody', () => {
  assert.strictEqual(value('names_home'), 'Alex, Sam');
  assert.strictEqual(value('names_awake'), 'Alex');
  assert.strictEqual(spec('names_home').of([], []), '', 'an empty house says nothing, not "undefined"');
});

test('an empty household gives zeroes, never undefined', () => {
  for (const token of TOKENS) {
    const result = token.of([], []);
    assert.strictEqual(typeof result, token.type === 'number' ? 'number' : 'string', token.id);
  }
});
