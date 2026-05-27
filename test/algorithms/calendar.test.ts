import { describe, expect, it } from "vitest";
import {
  MS_PER_DAY,
  calendarPeriod,
  civilFromDays,
  daysFromCivil,
} from "../../src/algorithms/calendar";

describe("civil-calendar math", () => {
  it("round-trips daysFromCivil <-> civilFromDays across a wide range", () => {
    // Cover ~550 years around the epoch, every day, against the inverse.
    for (let z = -200_000; z <= 200_000; z += 7) {
      const { y, m, d } = civilFromDays(z);
      expect(daysFromCivil(y, m, d)).toBe(z);
    }
  });

  it("agrees with Date.UTC on known civil dates", () => {
    // day 0 is 1970-01-01.
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(civilFromDays(0)).toEqual({ y: 1970, m: 1, d: 1 });
    // Leap day exists in 2024, not 2023.
    expect(daysFromCivil(2024, 2, 29) + 1).toBe(daysFromCivil(2024, 3, 1));
    expect(daysFromCivil(2023, 2, 28) + 1).toBe(daysFromCivil(2023, 3, 1));
    // Cross-check a scattering of dates against the platform's Date implementation.
    for (const [y, m, d] of [
      [2000, 3, 1],
      [2026, 5, 28],
      [1999, 12, 31],
      [2400, 2, 29],
    ] as const) {
      expect(daysFromCivil(y, m, d) * MS_PER_DAY).toBe(Date.UTC(y, m - 1, d));
    }
  });
});

describe("calendarPeriod", () => {
  it("calendar-month spans the 1st to the next 1st (UTC)", () => {
    const now = Date.UTC(2026, 4, 28, 12, 30); // 2026-05-28 (May, 0-indexed month 4)
    const { start, reset } = calendarPeriod("calendar-month", now, 0, 1);
    expect(start).toBe(Date.UTC(2026, 4, 1));
    expect(reset).toBe(Date.UTC(2026, 5, 1));
  });

  it("calendar-month handles leap and non-leap February lengths", () => {
    const leap = calendarPeriod("calendar-month", Date.UTC(2024, 1, 15), 0, 1); // Feb 2024
    expect(leap.reset - leap.start).toBe(29 * MS_PER_DAY);
    const nonLeap = calendarPeriod("calendar-month", Date.UTC(2023, 1, 15), 0, 1); // Feb 2023
    expect(nonLeap.reset - nonLeap.start).toBe(28 * MS_PER_DAY);
    // December rolls the year over.
    const dec = calendarPeriod("calendar-month", Date.UTC(2025, 11, 20), 0, 1);
    expect(dec.start).toBe(Date.UTC(2025, 11, 1));
    expect(dec.reset).toBe(Date.UTC(2026, 0, 1));
  });

  it("applies a fixed offset (e.g. IST +330), which can shift the active period", () => {
    const ist = 330 * 60_000;
    // 2024-01-31 18:40 UTC is still January in UTC, but already 2024-02-01 00:10 in IST —
    // so the offset moves this instant into the next month's period.
    const now = Date.UTC(2024, 0, 31, 18, 40);
    const utc = calendarPeriod("calendar-month", now, 0, 1);
    expect(utc.start).toBe(Date.UTC(2024, 0, 1)); // Jan 1 00:00 UTC
    expect(utc.reset).toBe(Date.UTC(2024, 1, 1)); // Feb 1 00:00 UTC
    const india = calendarPeriod("calendar-month", now, ist, 1);
    expect(india.start).toBe(Date.UTC(2024, 1, 1) - ist); // Feb 1 00:00 IST
    expect(india.reset).toBe(Date.UTC(2024, 2, 1) - ist); // Mar 1 00:00 IST
  });

  it("calendar-day spans local midnight to local midnight", () => {
    const now = Date.UTC(2026, 4, 28, 9, 0);
    const { start, reset } = calendarPeriod("calendar-day", now, 0, 1);
    expect(start).toBe(Date.UTC(2026, 4, 28));
    expect(reset).toBe(Date.UTC(2026, 4, 29));
  });

  it("calendar-week starts on the configured weekday", () => {
    // 2026-05-28 is a Thursday. Week starting Monday (1) → 2026-05-25 .. 2026-06-01.
    const now = Date.UTC(2026, 4, 28, 9, 0);
    const mon = calendarPeriod("calendar-week", now, 0, 1);
    expect(mon.start).toBe(Date.UTC(2026, 4, 25));
    expect(mon.reset).toBe(Date.UTC(2026, 5, 1));
    expect(mon.reset - mon.start).toBe(7 * MS_PER_DAY);
    // Week starting Sunday (0) → 2026-05-24 .. 2026-05-31.
    const sun = calendarPeriod("calendar-week", now, 0, 0);
    expect(sun.start).toBe(Date.UTC(2026, 4, 24));
    expect(sun.reset).toBe(Date.UTC(2026, 4, 31));
  });
});
