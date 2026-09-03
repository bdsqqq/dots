import assert from "node:assert/strict";
import test from "node:test";

import {
  CalendarDateV1Schema,
  MoneyV1Schema,
  parseMinorUnits,
} from "./money.ts";

test("money and dates are exact observational values", () => {
  const money = {
    kind: "company-money.money",
    version: 1,
    currency: "BRL",
    minorUnits: 1234,
  };
  assert.equal(MoneyV1Schema.assert(money), money);
  assert.throws(() => MoneyV1Schema.assert({ ...money, extra: true }), /extra/);
  assert.throws(() => MoneyV1Schema.assert({ ...money, minorUnits: 1.5 }), /integer/);
  assert.throws(() => MoneyV1Schema.assert({ ...money, minorUnits: 0 }), /positive/);
  assert.throws(
    () => MoneyV1Schema.assert({ ...money, minorUnits: 2 ** 53 }),
    /at most 9007199254740991/,
  );
  assert.throws(() => MoneyV1Schema.assert({ ...money, currency: "ZZZ" }), /ISO 4217/);
});

test("calendar and provider-native minor-unit parsing are semantic", () => {
  assert.equal(CalendarDateV1Schema.assert("2024-02-29"), "2024-02-29");
  assert.throws(() => CalendarDateV1Schema.assert("2025-02-29"), /semantic/);
  assert.equal(parseMinorUnits("12.34", "BRL"), 1234);
  assert.equal(parseMinorUnits("12,3", "EUR"), 1230);
  assert.equal(parseMinorUnits("12", "JPY"), 12);
  assert.throws(() => parseMinorUnits("12.1", "JPY"), /decimal places/);
  assert.throws(() => parseMinorUnits("0", "USD"), /positive/);
});
