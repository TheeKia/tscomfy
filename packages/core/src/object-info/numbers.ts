import type { JsonValue } from "../json/value.ts";
import type { IntValue } from "../schema/types.ts";

/** Which bound a value is: rounding always goes towards the inside of the range. */
export type Side = "min" | "max";

/**
 * The canonical form of an integer: a `number` when it is safe, else a `bigint`. Returns
 * `undefined` for anything that isn't an integer.
 */
export function toIntValue(value: JsonValue): IntValue | undefined {
  if (typeof value === "bigint") {
    // A bigint in the safe range converts exactly; outside it, Number() is never a safe integer.
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return Number.isSafeInteger(value) ? value : BigInt(value);
}

/**
 * An INT bound. A fractional bound is rounded inward (`max` down, `min` up), so every integer we
 * accept is also within the backend's bound. `inexact` means the parser may have rounded integer
 * literals beyond 2^53 (no source-text access); such a bound moves inward by one double, which
 * covers any rounding.
 */
export function toIntBound(value: JsonValue, side: Side, inexact: boolean): IntValue | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (!Number.isInteger(value)) {
      return toIntValue(side === "max" ? Math.floor(value) : Math.ceil(value));
    }
    if (inexact && !Number.isSafeInteger(value)) return toIntValue(nextDouble(value, side));
  }
  return toIntValue(value);
}

/**
 * A FLOAT bound. The backend compares floats against the bound exactly, and some servers write
 * FLOAT bounds as integers beyond 2^53. Such a bound becomes the nearest double on the inside
 * (`max` rounds down, `min` up), so every value we accept is within the backend's bound.
 * Returns `undefined` when no finite double lies on the inside.
 */
export function toFloatBound(value: JsonValue, side: Side, inexact: boolean): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return inexact && Number.isInteger(value) && !Number.isSafeInteger(value)
      ? finite(nextDouble(value, side))
      : value;
  }
  if (typeof value !== "bigint") return undefined;
  const nearest = Number(value);
  if (!Number.isFinite(nearest)) {
    // Beyond the double range. A max far above (or a min far below) admits every double, so the
    // extreme finite double is inside; on the other side no finite double is.
    const admitsAllDoubles = (side === "max") === value > 0n;
    if (!admitsAllDoubles) return undefined;
    return value > 0n ? Number.MAX_VALUE : -Number.MAX_VALUE;
  }
  const exact = BigInt(nearest);
  if (side === "max" && exact > value) return finite(nextDouble(nearest, "max"));
  if (side === "min" && exact < value) return finite(nextDouble(nearest, "min"));
  return nearest;
}

/**
 * A FLOAT default or list element. Integers beyond 2^53 become the nearest double, which is what
 * the backend's `float()` coercion produces too.
 */
export function toFloat(value: JsonValue): number | undefined {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

/** Whether a default (or every element of a list default) lies within the bounds. */
export function withinBounds(
  value: IntValue | number | readonly (IntValue | number)[],
  min: IntValue | undefined,
  max: IntValue | undefined,
): boolean {
  const values = typeof value === "object" ? value : [value];
  return values.every(
    (item) => (min === undefined || item >= min) && (max === undefined || item <= max),
  );
}

function finite(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The adjacent double on the inside of a bound: below for `max`, above for `min`. Only used for
 * finite, non-zero values.
 */
function nextDouble(value: number, side: Side): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  // For positive doubles a larger bit pattern is a larger value; for negative ones, a smaller one.
  const step = value > 0 === (side === "min") ? 1n : -1n;
  view.setBigUint64(0, bits + step);
  return view.getFloat64(0);
}
