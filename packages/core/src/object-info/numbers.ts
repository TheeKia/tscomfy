import type { JsonValue } from "../json/value.ts";
import type { IntValue } from "../schema/types.ts";

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
 * accept is also within the backend's bound.
 */
export function toIntBound(value: JsonValue, side: "min" | "max"): IntValue | undefined {
  if (typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value)) {
    return toIntValue(side === "max" ? Math.floor(value) : Math.ceil(value));
  }
  return toIntValue(value);
}

/**
 * A FLOAT bound. The backend compares floats against the bound exactly, and some servers write
 * FLOAT bounds as integers beyond 2^53. Such a bound becomes the nearest double on the inside
 * (`max` rounds down, `min` up), so every value we accept is within the backend's bound.
 */
export function toFloatBound(value: JsonValue, side: "min" | "max"): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "bigint") return undefined;
  const nearest = Number(value);
  const exact = BigInt(nearest);
  if (side === "max" && exact > value) return nextDouble(nearest, -1);
  if (side === "min" && exact < value) return nextDouble(nearest, 1);
  return nearest;
}

/**
 * A FLOAT default or list element. Integers beyond 2^53 become the nearest double, which is what
 * the backend's `float()` coercion produces too.
 */
export function toFloat(value: JsonValue): number | undefined {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The adjacent double towards `direction` (±1). Only used for finite, non-zero integers. */
function nextDouble(value: number, direction: 1 | -1): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  // For positive doubles a larger bit pattern is a larger value; for negative ones, a smaller one.
  const step = value > 0 === direction > 0 ? 1n : -1n;
  view.setBigUint64(0, bits + step);
  return view.getFloat64(0);
}
