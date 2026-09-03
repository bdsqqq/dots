import { type } from "arktype";

export const ISO_CURRENCY_MINOR_UNITS = {
  BRL: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  USD: 2,
} as const;

export type IsoCurrency = keyof typeof ISO_CURRENCY_MINOR_UNITS;

export const IsoCurrencyV1Schema = type("string").narrow(
  (value, context) =>
    Object.hasOwn(ISO_CURRENCY_MINOR_UNITS, value) ||
    context.mustBe("a supported ISO 4217 currency"),
);

export const PositiveMinorUnitsV1Schema = type(
  "number.safe & number.integer",
).narrow(
  (value, context) => value > 0 || context.mustBe("a positive safe integer"),
);

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const CalendarDateV1Schema = type("string").narrow(
  (value, context) =>
    isCalendarDate(value) || context.mustBe("a semantic YYYY-MM-DD calendar date"),
);

export const MoneyV1Schema = type({
  "+": "reject",
  kind: "'company-money.money'",
  version: "1",
  currency: IsoCurrencyV1Schema,
  minorUnits: PositiveMinorUnitsV1Schema,
});

export type CalendarDate = typeof CalendarDateV1Schema.infer;
export type MoneyV1 = typeof MoneyV1Schema.infer;

export const moneySchemaCatalog = {
  "company-money.money": { 1: MoneyV1Schema },
} as const;

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function calendarDayDistance(left: CalendarDate, right: CalendarDate): number {
  return Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) /
    86_400_000;
}

export function parseMinorUnits(decimal: string, currency: IsoCurrency): number {
  const exponent = ISO_CURRENCY_MINOR_UNITS[currency];
  const match = /^(0|[1-9]\d*)(?:[.,](\d+))?$/.exec(decimal.trim());
  if (!match) throw new TypeError("amount must be an unsigned decimal");
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) {
    throw new TypeError("amount has too many currency decimal places");
  }
  const units = Number(`${match[1]}${fraction.padEnd(exponent, "0")}`);
  if (!Number.isSafeInteger(units) || units <= 0) {
    throw new TypeError("amount must produce positive safe minor units");
  }
  return units;
}
