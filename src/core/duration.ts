import { requirePositive } from "./validate";

/**
 * Parse a duration into milliseconds. A number is treated as already-ms; a string is
 * `"<n><unit>"` where `unit ∈ ms|s|m|h|d` (default `ms` if absent). Used by the NestJS
 * `@RateLimit` decorator and the `.throttlekit.yaml` config loader.
 */
export function parseDuration(period: string | number): number {
  if (typeof period === "number") {
    requirePositive("period", period);
    return period;
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(period);
  if (m === null) {
    throw new RangeError(
      `period: cannot parse ${JSON.stringify(period)} (use e.g. "30s", "1m", "1h", or a number of ms)`,
    );
  }
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  const mult =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  const ms = n * mult;
  requirePositive("period", ms);
  return ms;
}
