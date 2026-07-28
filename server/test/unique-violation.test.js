// @ts-check
// BUG-008 — `isUniqueViolation` classifies on the code and nothing else.
//
// A unit test rather than a route test, and deliberately so: the defect was an
// error being MISclassified, and neither engine can be made to raise the
// misclassifying error on demand. pg-mem produced it only by failing to parse a
// query, at a rate set by a random IV; real Postgres would need a different
// error again. So the input is hand-made, which is the only way to state the
// rule — a `23505` is a conflict, and no amount of the word "unique" in a
// message makes anything else into one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUniqueViolation } from '../src/routes/helpers.js';

test('a 23505 is a conflict, whatever it says', () => {
  assert.equal(isUniqueViolation({ code: '23505' }), true);
  assert.equal(
    isUniqueViolation(
      Object.assign(new Error('duplicate key value violates unique constraint "fixtures_key"'), {
        code: '23505',
      })
    ),
    true,
    'the shape both engines actually raise'
  );
});

test('nothing else is, however much it sounds like one', () => {
  // The one that cost a day: pg-mem answers a query it cannot parse with the
  // list of tokens it expected, and `kw_unique` is on that list. Read as a
  // conflict, it told the user their project already had a session under a name
  // nothing in the database had ever held.
  const parseError = new Error(
    'Unexpected input (lexer error). Instead, I was expecting to see one of the following:\n' +
      '    - A "kw_unique" token\n    - A "kw_primary" token\n'
  );
  assert.equal(isUniqueViolation(parseError), false);

  assert.equal(isUniqueViolation(new Error('duplicate object')), false);
  assert.equal(isUniqueViolation({ code: '23503' }), false, 'a foreign key is not a name clash');
  assert.equal(isUniqueViolation({ code: 23505 }), false, 'the code is a string, as node-pg sends it');
  assert.equal(isUniqueViolation(null), false);
  assert.equal(isUniqueViolation(undefined), false);
});
