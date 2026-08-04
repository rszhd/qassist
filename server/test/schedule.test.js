// @ts-check
// Slot math (US-010). Pure unit tests: no db, no app, no clock — every case
// passes its own `from` instant. Dates are asserted as wall-clock readings in
// the schedule's own zone, which is the only thing the user ever sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextSlot,
  prevSlot,
  firesIntoNothing,
  validateSchedule,
  HOURLY_INTERVALS,
} from '../src/schedule.js';

const BERLIN = 'Europe/Berlin';

/** Wall-clock reading of an instant in a zone, as "YYYY-MM-DD HH:MM". */
function localOf(date, tz) {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return fmt.format(date).replace('T', ' ');
}

/** An instant from a wall-clock reading, for building `from` values. */
function at(iso, offset = '+02:00') {
  return new Date(`${iso}${offset}`).getTime();
}

test('daily fires at its time in its own zone', () => {
  const daily = { kind: 'daily', hour: 2, minute: 30, tz: BERLIN };
  const next = nextSlot(daily, at('2026-07-23T13:05'));
  assert.equal(localOf(next, BERLIN), '2026-07-24 02:30');
});

test('daily before the slot fires the same day', () => {
  const daily = { kind: 'daily', hour: 2, minute: 30, tz: BERLIN };
  const next = nextSlot(daily, at('2026-07-23T01:00'));
  assert.equal(localOf(next, BERLIN), '2026-07-23 02:30');
});

test('a slot is strictly in the future: standing on one returns the next', () => {
  const daily = { kind: 'daily', hour: 2, minute: 30, tz: BERLIN };
  const onTheSlot = at('2026-07-23T02:30');
  const next = nextSlot(daily, onTheSlot);
  assert.ok(next.getTime() > onTheSlot);
  assert.equal(localOf(next, BERLIN), '2026-07-24 02:30');
});

test('hourly slots are anchored to local midnight, not to when it was saved', () => {
  const every6 = { kind: 'hourly', interval_hours: 6, minute: 0, tz: BERLIN };
  assert.equal(localOf(nextSlot(every6, at('2026-07-23T13:05')), BERLIN), '2026-07-23 18:00');
  assert.equal(localOf(nextSlot(every6, at('2026-07-23T18:01')), BERLIN), '2026-07-24 00:00');
  assert.equal(localOf(nextSlot(every6, at('2026-07-23T00:01')), BERLIN), '2026-07-23 06:00');
});

test('every 3 hours with a minute offset', () => {
  const every3 = { kind: 'hourly', interval_hours: 3, minute: 15, tz: BERLIN };
  assert.equal(localOf(nextSlot(every3, at('2026-07-23T13:05')), BERLIN), '2026-07-23 15:15');
});

test('every 12 hours gives two slots a day', () => {
  const every12 = { kind: 'hourly', interval_hours: 12, minute: 0, tz: BERLIN };
  assert.equal(localOf(nextSlot(every12, at('2026-07-23T01:00')), BERLIN), '2026-07-23 12:00');
  assert.equal(localOf(nextSlot(every12, at('2026-07-23T13:00')), BERLIN), '2026-07-24 00:00');
});

test('weekly waits for its weekday', () => {
  // 2026-07-23 is a Thursday; weekday 2 = Tuesday.
  const weekly = { kind: 'weekly', weekday: 2, hour: 9, minute: 0, tz: BERLIN };
  const next = nextSlot(weekly, at('2026-07-23T13:05'));
  assert.equal(localOf(next, BERLIN), '2026-07-28 09:00');
  assert.equal(next.getUTCDay(), 2);
});

test('weekly on today, later today', () => {
  const weekly = { kind: 'weekly', weekday: 4, hour: 23, minute: 0, tz: BERLIN };
  assert.equal(localOf(nextSlot(weekly, at('2026-07-23T13:05')), BERLIN), '2026-07-23 23:00');
});

test('a daily slot keeps its wall-clock time across spring forward', () => {
  // Europe/Berlin springs forward 2026-03-29 at 02:00 local.
  const daily = { kind: 'daily', hour: 9, minute: 0, tz: BERLIN };
  const next = nextSlot(daily, at('2026-03-28T10:00', '+01:00'));
  assert.equal(localOf(next, BERLIN), '2026-03-29 09:00');
  // 23 h later in real time, not 24 — which is the whole reason for Intl here.
  assert.equal(next.getTime() - at('2026-03-29T09:00', '+01:00'), -3600 * 1000);
});

test('a daily slot keeps its wall-clock time across fall back', () => {
  // Europe/Berlin falls back 2026-10-25 at 03:00 local.
  const daily = { kind: 'daily', hour: 9, minute: 0, tz: BERLIN };
  const next = nextSlot(daily, at('2026-10-24T10:00'));
  assert.equal(localOf(next, BERLIN), '2026-10-25 09:00');
});

test('hourly slots stay ordered and inside the day across a DST transition', () => {
  const every6 = { kind: 'hourly', interval_hours: 6, minute: 0, tz: BERLIN };
  let cursor = at('2026-10-24T23:59');
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const next = nextSlot(every6, cursor);
    assert.ok(next.getTime() > cursor, 'each slot must advance');
    seen.push(localOf(next, BERLIN));
    cursor = next.getTime();
  }
  assert.deepEqual(seen, [
    '2026-10-25 00:00',
    '2026-10-25 06:00',
    '2026-10-25 12:00',
    '2026-10-25 18:00',
    '2026-10-26 00:00',
  ]);
});

test('zones differ: the same preset fires at different instants', () => {
  const berlin = nextSlot({ kind: 'daily', hour: 2, minute: 0, tz: BERLIN }, at('2026-07-23T00:00'));
  const tokyo = nextSlot(
    { kind: 'daily', hour: 2, minute: 0, tz: 'Asia/Tokyo' },
    at('2026-07-23T00:00')
  );
  assert.notEqual(berlin.getTime(), tokyo.getTime());
  assert.equal(localOf(berlin, BERLIN), '2026-07-23 02:00');
  // Same instant, but Tokyo is already at 07:00 that morning, so its 02:00 has
  // gone — the preset reads in local time on both sides.
  assert.equal(localOf(tokyo, 'Asia/Tokyo'), '2026-07-24 02:00');
});

test('no tz falls back to the server zone', () => {
  const next = nextSlot({ kind: 'daily', hour: 3, minute: 0 }, Date.now());
  const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.match(localOf(next, serverZone), /03:00$/);
});

test('validate rejects what the columns would reject', () => {
  assert.match(validateSchedule({ kind: 'yearly' }).error, /kind must be/);
  assert.match(validateSchedule({}).error, /kind must be/);
  assert.match(validateSchedule({ kind: 'hourly', interval_hours: 5 }).error, /interval_hours/);
  assert.match(validateSchedule({ kind: 'weekly' }).error, /weekday/);
  assert.match(validateSchedule({ kind: 'weekly', weekday: 7 }).error, /weekday/);
  assert.match(validateSchedule({ kind: 'daily', hour: 24 }).error, /hour/);
  assert.match(validateSchedule({ kind: 'daily', minute: 60 }).error, /minute/);
  assert.match(validateSchedule({ kind: 'daily', tz: 'Mars/Olympus' }).error, /unknown timezone/);
});

test('validate settles the fields the kind does not use', () => {
  const hourly = validateSchedule({ kind: 'hourly', hour: 14, minute: 30 }).schedule;
  // 14 would read as "fires at 14:00", which an hourly schedule never does.
  assert.deepEqual(hourly, {
    kind: 'hourly',
    interval_hours: 1,
    hour: 0,
    minute: 30,
    weekday: null,
    tz: null,
  });
  const daily = validateSchedule({ kind: 'daily', hour: 2, weekday: 3 }).schedule;
  assert.equal(daily.weekday, null);
  assert.equal(daily.interval_hours, null);
});

test('every allowed interval divides the day evenly', () => {
  for (const hours of HOURLY_INTERVALS) {
    assert.equal(24 % hours, 0, `${hours} h must divide 24`);
    const schedule = { kind: 'hourly', interval_hours: hours, minute: 0, tz: BERLIN };
    let cursor = at('2026-07-23T00:00');
    const first = nextSlot(schedule, cursor);
    // Midnight-anchored means the day's slot count is exactly 24 / interval.
    let count = 0;
    cursor = at('2026-07-22T23:59');
    for (;;) {
      const next = nextSlot(schedule, cursor);
      if (localOf(next, BERLIN).slice(0, 10) !== '2026-07-23') break;
      count++;
      cursor = next.getTime();
    }
    assert.equal(count, 24 / hours, `${hours} h should fire ${24 / hours}× a day`);
    assert.ok(first);
  }
});

// --- US-069: the slot behind, and the row tag that reads it -----------------

test('the previous slot is strictly in the past: standing on one returns the one before', () => {
  const daily = { kind: 'daily', hour: 2, minute: 30, tz: BERLIN };
  assert.equal(localOf(prevSlot(daily, at('2026-07-23T02:30')), BERLIN), '2026-07-22 02:30');
  assert.equal(localOf(prevSlot(daily, at('2026-07-23T02:29')), BERLIN), '2026-07-22 02:30');
  assert.equal(localOf(prevSlot(daily, at('2026-07-23T02:31')), BERLIN), '2026-07-23 02:30');
});

test('the previous hourly slot is the one below, anchored to local midnight', () => {
  const hourly = { kind: 'hourly', interval_hours: 6, minute: 15, tz: BERLIN };
  assert.equal(localOf(prevSlot(hourly, at('2026-07-23T13:00')), BERLIN), '2026-07-23 12:15');
  // Across local midnight, which is where a naive "subtract the interval"
  // walks off the anchor.
  assert.equal(localOf(prevSlot(hourly, at('2026-07-23T00:10')), BERLIN), '2026-07-22 18:15');
});

test('the previous weekly slot is a week back, not a day', () => {
  const weekly = { kind: 'weekly', weekday: 1, hour: 9, minute: 0, tz: BERLIN };
  // Wednesday 22 July 2026 → the Monday before it.
  assert.equal(localOf(prevSlot(weekly, at('2026-07-22T12:00')), BERLIN), '2026-07-20 09:00');
});

test('a previous daily slot keeps its wall-clock time across fall back', () => {
  const daily = { kind: 'daily', hour: 2, minute: 0, tz: BERLIN };
  // 25 October 2026 is the transition; the night before it is still 02:00.
  const previous = prevSlot(daily, at('2026-10-25T12:00', '+01:00'));
  assert.equal(localOf(previous, BERLIN), '2026-10-25 02:00');
  assert.equal(localOf(prevSlot(daily, previous.getTime()), BERLIN), '2026-10-24 02:00');
});

test('nextSlot and prevSlot bracket the same instant', () => {
  for (const schedule of [
    { kind: 'daily', hour: 2, minute: 30, tz: BERLIN },
    { kind: 'hourly', interval_hours: 4, minute: 0, tz: BERLIN },
    { kind: 'weekly', weekday: 3, hour: 22, minute: 45, tz: 'America/New_York' },
  ]) {
    const from = at('2026-03-29T07:13'); // Berlin's spring-forward morning
    const before = prevSlot(schedule, from);
    const after = nextSlot(schedule, from);
    assert.ok(before.getTime() < from, `${schedule.kind}: previous is behind`);
    assert.ok(after.getTime() > from, `${schedule.kind}: next is ahead`);
    // Nothing fires between them: the slot after the previous one is the next.
    assert.equal(nextSlot(schedule, before).getTime(), after.getTime());
  }
});

// The tag exists because a strip drawn over `runs` shows a schedule that has
// been claiming slots and starting nothing as blank — which reads as "quiet",
// not as "broken". Every case below is one where the strip is empty and the
// truth differs.
test('a schedule whose claimed slot started nothing is marked', () => {
  const nightly = {
    kind: 'daily',
    hour: 2,
    minute: 0,
    tz: BERLIN,
    enabled: true,
    created_at: new Date(at('2026-07-01T09:00')),
    next_run_at: new Date(at('2026-07-24T02:00')),
  };
  assert.equal(
    firesIntoNothing({ ...nightly, last_run_at: new Date(at('2026-07-23T02:00:04')) }),
    false,
    'the slot the claim consumed did start something'
  );
  assert.equal(
    firesIntoNothing({ ...nightly, last_run_at: new Date(at('2026-07-20T02:00:04')) }),
    true,
    'three nights of claims, and the last thing that started was on the 20th'
  );
  assert.equal(
    firesIntoNothing({ ...nightly, last_run_at: null }),
    true,
    'claimed since the day it was made, and has never started anything'
  );
});

test('a schedule that has never been due is not marked', () => {
  const madeThisAfternoon = {
    kind: 'daily',
    hour: 2,
    minute: 0,
    tz: BERLIN,
    enabled: true,
    created_at: new Date(at('2026-07-23T15:00')),
    next_run_at: new Date(at('2026-07-24T02:00')),
    last_run_at: null,
  };
  // 02:00 this morning is behind next_run_at, but it is also behind the
  // schedule — nobody missed it. This is the case the tag must not shout at,
  // because it is every schedule on the day it is created.
  assert.equal(firesIntoNothing(madeThisAfternoon), false);
});

test('a disabled or undated schedule is not marked', () => {
  const base = {
    kind: 'daily',
    hour: 2,
    minute: 0,
    tz: BERLIN,
    created_at: new Date(at('2026-07-01T09:00')),
    last_run_at: null,
  };
  assert.equal(
    firesIntoNothing({ ...base, enabled: false, next_run_at: new Date(at('2026-07-24T02:00')) }),
    false,
    'a schedule that was switched off is not failing'
  );
  assert.equal(
    firesIntoNothing({ ...base, enabled: true, next_run_at: null }),
    false,
    'an undated one has claimed nothing yet'
  );
});
