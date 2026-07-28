# BUG-008: `isUniqueViolation` matches on the message, so any error saying "unique" becomes a 409

**Status:** ✅ Fixed 2026-07-28
**Reported:** 2026-07-28 (found while fixing
[BUG-007](BUG-007-server-suite-fails-intermittently.md))
**Area:** server (`server/src/routes/sessions.js`, `server/src/routes/fixtures.js`)

## Symptom

Any database error whose text happens to contain "unique" or "duplicate" is
reported to the user as a name clash, with a message naming a resource they
have never created:

```
409  this project already has a session called pasted in — rename or replace it
```

BUG-007 hit exactly this. pg-mem's SQL parse errors enumerate the tokens they
expected, and one of them is `A "kw_unique" token`, so a parse failure on the
paste route came back as a conflict on a name nothing in the database had ever
held. On a real server the same shape is reachable by any error mentioning
either word — a `duplicate_object`, a constraint message quoted inside a
trigger's error, a connection error carrying a query string that says "unique".

The wrong status is the smaller half. The message *asserts a fact about the
user's data* that is false, and it points them at a fix (rename it) that cannot
work.

## Root cause

Both copies classify the error twice, and the second test is a guess:

```js
function isUniqueViolation(err) {
  const e = /** @type {any} */ (err);
  return e?.code === '23505' || /unique|duplicate/i.test(String(e?.message || ''));
}
```

`23505` is exact. The regex is a substring match on a human-readable string
that no engine promises anything about.

## Why the regex is there, and why that reason has expired

It is deliberate and documented — `routes/fixtures.js` says pg-mem "raises a
plain Error whose message names the constraint, so matching on the code alone
would turn the duplicate case into a 500 in exactly the place the tests run."

That is no longer true, and may never have been true of the pinned version.
**pg-mem 3.0.14 sets `code = '23505'`** on a unique violation, alongside a
message beginning `duplicate key value violates unique constraint`. Verified
directly against both an inline `unique` column and a named table constraint.

So the fallback no longer catches anything it was written to catch. The only
errors it can still match are the ones it was never meant to.

## Why it was worth fixing

It is small, but it is the kind of small that costs a support conversation:
the product states something about the user's data that is not so, and both
the status code and the remedy it suggests are wrong. It also cost real time
once already — the 409 was one of the five names in BUG-007 and read as a
completely separate defect from the timeout it shared a cause with.

## The fix

`isUniqueViolation` is now `err?.code === '23505'` and nothing else, and there
is now one of it: it moved to `routes/helpers.js`, which both routes import.
Two copies of the same four lines was the other half of the defect — fixtures'
carried the rationale and sessions' pointed at it, so the stale premise was
only ever written down once and only ever checked never.

`test/unique-violation.test.js` guards it, as a unit test over a hand-made
error rather than through a route. Neither engine can be made to raise the
misclassifying error on demand: pg-mem produced it only by failing to parse a
query, at a rate set by a random IV, and real Postgres would need a different
error again. So the input has to be hand-made, and the rule then states itself
— a `23505` is a conflict, and no quantity of the word "unique" in a message
makes anything else into one.

Full suite green at 634 (632 + the two new cases), `npm run check` clean. That
includes `fixture-whitelist.test.js`'s D12 assertion that a duplicate filename
is a 409 rather than a silent replace, which is the pg-mem test the deleted
fallback was believed to be keeping green.

## The lesson, which is not about `unique`

**An engine's error *message* is not an interface; its error *code* is.** The
fallback was written from a belief about pg-mem that was either wrong when
written or expired quietly afterwards, and nothing could ever fail to tell us:
the OR meant the exact half carried every case that mattered, so the guess
sat behind it for a year doing nothing but widening. A defensive `||` over a
string is invisible until the day it fires on the wrong thing.
