// @ts-check
// Slot math for scheduled runs (US-010): validate a preset, and answer "when
// does this fire next?". Pure — no db, no clock of its own — so the scheduler
// tick and the API layer can both use it and the tests can drive it at any
// date they like.
//
// Everything here works in the schedule's own timezone via Intl rather than by
// adding milliseconds, because the two cases that matter are exactly the ones
// arithmetic gets wrong: "daily at 02:00" must stay 02:00 across a DST change,
// and the hourly slots are anchored to local midnight.

/** Divisors of 24 only — see the note on slotsOfDay. */
export const HOURLY_INTERVALS = [1, 2, 3, 4, 6, 8, 12];
export const KINDS = ['hourly', 'daily', 'weekly'];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{ kind: string, interval_hours?: number|null, hour?: number|null,
 *             minute?: number|null, weekday?: number|null, tz?: string|null }} Schedule
 */

/** @param {string|null|undefined} tz */
function zoneOf(tz) {
  return tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** @param {string} tz @param {Date} date */
function partsIn(tz, date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23', // hour12:false still yields 24 for midnight on some ICU builds
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  /** @type {Record<string, number>} */
  const parts = {};
  for (const { type, value } of fmt.formatToParts(date)) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return parts;
}

/** How far `tz`'s wall clock is ahead of UTC at this instant. @param {string} tz @param {number} ms */
function offsetAt(tz, ms) {
  const p = partsIn(tz, new Date(ms));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which `tz`'s wall clock reads the given date and time.
 * Two passes: the first guess uses the offset at the *UTC* reading of that
 * wall clock, which is wrong by up to a day's worth of DST either side of a
 * transition; re-measuring at the guessed instant lands it.
 * @param {string} tz
 */
function instantOf(tz, year, month, day, hour, minute) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const guess = naive - offsetAt(tz, naive);
  return naive - offsetAt(tz, guess);
}

/**
 * The wall-clock times a schedule fires at on any given day, ascending.
 * Hourly intervals are restricted to divisors of 24 so this list is the same
 * every day — "every 6 hours" means 00/06/12/18, not "6 h after whenever the
 * schedule was saved", which is what makes a slot predictable enough to put
 * in the UI.
 * @param {Schedule} schedule
 */
function slotsOfDay(schedule) {
  const minute = schedule.minute || 0;
  if (schedule.kind !== 'hourly') return [{ hour: schedule.hour || 0, minute }];
  const step = schedule.interval_hours || 1;
  const slots = [];
  for (let hour = 0; hour < 24; hour += step) slots.push({ hour, minute });
  return slots;
}

/**
 * The first instant strictly after `from` at which the schedule fires.
 * @param {Schedule} schedule
 * @param {number|Date} [from]
 * @returns {Date|null} null only for a schedule validateSchedule would reject
 */
export function nextSlot(schedule, from = Date.now()) {
  const tz = zoneOf(schedule.tz);
  const fromMs = from instanceof Date ? from.getTime() : from;
  const start = partsIn(tz, new Date(fromMs));
  const slots = slotsOfDay(schedule);

  // Walk local calendar days rather than adding 24 h: a DST day is 23 or 25
  // hours long. Eight is enough for the longest gap any preset can have (a
  // weekly schedule, plus one day of slack for a transition).
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day) + dayOffset * DAY_MS);
    if (schedule.kind === 'weekly' && day.getUTCDay() !== schedule.weekday) continue;
    for (const slot of slots) {
      const ms = instantOf(
        tz,
        day.getUTCFullYear(),
        day.getUTCMonth() + 1,
        day.getUTCDate(),
        slot.hour,
        slot.minute
      );
      if (ms > fromMs) return new Date(ms);
    }
  }
  return null;
}

/** @param {unknown} value */
function knownZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: /** @type {string} */ (value) });
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} value */
function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * Check and normalize a schedule from a request body. Returns `{ error }` or
 * `{ schedule }` with every field settled, so callers can insert it directly.
 * Fields the kind doesn't use are zeroed rather than passed through: an hourly
 * schedule carrying `hour: 14` would read as if it fired at 14:00.
 * @param {any} input
 */
export function validateSchedule(input) {
  const body = input || {};
  const kind = String(body.kind || '');
  if (!KINDS.includes(kind)) return { error: `kind must be one of: ${KINDS.join(', ')}` };

  const minute = intOrNull(body.minute) ?? 0;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return { error: 'minute must be an integer between 0 and 59' };
  }
  const hour = intOrNull(body.hour) ?? 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return { error: 'hour must be an integer between 0 and 23' };
  }

  let intervalHours = null;
  if (kind === 'hourly') {
    intervalHours = intOrNull(body.interval_hours) ?? 1;
    if (!HOURLY_INTERVALS.includes(intervalHours)) {
      return { error: `interval_hours must be one of: ${HOURLY_INTERVALS.join(', ')}` };
    }
  }

  let weekday = null;
  if (kind === 'weekly') {
    weekday = intOrNull(body.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { error: 'weekly needs a weekday: an integer 0 (Sunday) to 6' };
    }
  }

  const tz = body.tz ? String(body.tz) : null;
  if (tz && !knownZone(tz)) return { error: `unknown timezone: ${tz}` };

  return {
    schedule: {
      kind,
      interval_hours: intervalHours,
      hour: kind === 'hourly' ? 0 : hour,
      minute,
      weekday,
      tz,
    },
  };
}
