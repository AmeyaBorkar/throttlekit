/**
 * Dependency-free proleptic-Gregorian civil-date math (Howard Hinnant's `days_from_civil` /
 * `civil_from_days`), used by {@link quota} to compute calendar-period boundaries. It is pure
 * integer arithmetic — no `Date`, no `Intl`, no timezone database — so the exact same boundary is
 * reproducible in the Redis Lua form (which cannot call `os.date`), keeping the two execution paths
 * bit-identical.
 *
 * Boundaries are computed at a **fixed UTC offset** (`offsetMs`). True IANA/DST-aware zones are
 * intentionally out of scope: a DST transition cannot be reproduced in Redis Lua without bundling a
 * tz database, which would break the bit-identity guarantee. Pick the offset of your billing
 * timezone (most billing runs in UTC or a fixed offset anyway). See {@link quota}'s doc comment.
 */

export const MS_PER_DAY = 86_400_000;

/** Floor division matching Lua's `math.floor(a / b)` for every sign of `a`. */
function fdiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Non-negative modulo (Lua's `%` is already floored for a positive divisor; JS's is not). */
function fmod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** Days since 1970-01-01 for a civil date `(y, m, d)`, `m` in `[1,12]`. Hinnant `days_from_civil`. */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = fdiv(yy >= 0 ? yy : yy - 399, 400);
  const yoe = yy - era * 400; // [0, 399]
  const doy = fdiv(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1; // [0, 365]
  const doe = yoe * 365 + fdiv(yoe, 4) - fdiv(yoe, 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** Civil date `(y, m, d)` for `z` days since 1970-01-01. Hinnant `civil_from_days`. */
export function civilFromDays(z: number): { y: number; m: number; d: number } {
  const zz = z + 719468;
  const era = fdiv(zz >= 0 ? zz : zz - 146096, 146097);
  const doe = zz - era * 146097; // [0, 146096]
  const yoe = fdiv(doe - fdiv(doe, 1460) + fdiv(doe, 36524) - fdiv(doe, 146096), 365); // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + fdiv(yoe, 4) - fdiv(yoe, 100)); // [0, 365]
  const mp = fdiv(5 * doy + 2, 153); // [0, 11]
  const d = doy - fdiv(153 * mp + 2, 5) + 1; // [1, 31]
  const m = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
  return { y: m <= 2 ? y + 1 : y, m, d };
}

/** A calendar cadence whose period boundary lands on a civil-calendar edge. */
export type CalendarCadence = "calendar-month" | "calendar-week" | "calendar-day";

/**
 * The half-open `[start, reset)` epoch-ms boundary of the calendar period containing `now`,
 * evaluated at the fixed UTC offset `offsetMs`. For `calendar-week`, `weekStartsOn` is the weekday
 * the week begins on (`0`=Sun … `6`=Sat). Mirrors the Lua branch in {@link quota} exactly.
 */
export function calendarPeriod(
  cadence: CalendarCadence,
  now: number,
  offsetMs: number,
  weekStartsOn: number,
): { start: number; reset: number } {
  const local = now + offsetMs;
  const day = fdiv(local, MS_PER_DAY);

  if (cadence === "calendar-day") {
    return { start: day * MS_PER_DAY - offsetMs, reset: (day + 1) * MS_PER_DAY - offsetMs };
  }

  if (cadence === "calendar-week") {
    const dow = fmod(day + 4, 7); // 1970-01-01 is a Thursday → (day+4) mod 7 gives 0=Sun … 6=Sat
    const shift = fmod(dow - weekStartsOn, 7);
    const startDay = day - shift;
    return {
      start: startDay * MS_PER_DAY - offsetMs,
      reset: (startDay + 7) * MS_PER_DAY - offsetMs,
    };
  }

  // calendar-month: the 1st of this month → the 1st of next month.
  const { y, m } = civilFromDays(day);
  const startDay = daysFromCivil(y, m, 1);
  const resetDay = daysFromCivil(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1);
  return { start: startDay * MS_PER_DAY - offsetMs, reset: resetDay * MS_PER_DAY - offsetMs };
}
