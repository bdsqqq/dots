import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parsePreference, parsePreferences, preferenceTier, PreferenceSyntaxError } from "./preferences.ts";

const defaults = `language: en, pt-BR > pt > *
format: pdf, epub > * > mobi`;

test("the proposed config preserves sibling groups and tier order", () => {
  const rules = parsePreferences(defaults);
  assert.deepEqual(rules.language, [["en", "pt-br"], ["pt"], ["*"]]);
  assert.deepEqual(rules.format, [["pdf", "epub"], ["*"], ["mobi"]]);
  assert.equal(rules.missing, undefined);
  const format = rules.format!;
  assert.equal(preferenceTier(format, "pdf"), 0);
  assert.equal(preferenceTier(format, "EPUB"), 0);
  assert.equal(preferenceTier(format, "azw3"), 1);
  assert.equal(preferenceTier(format, "mobi"), 2);
});

test("whitespace, comments, normalized names, and all documented line endings work", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const source = [
      "# defaults", "", "  LANGUAGE : EN , pt-BR > pt > *  # accepted languages",
      "\tFormat:\tPDF,EPUB > * > MOBI", "", "# done",
    ].join(newline);
    assert.deepEqual(parsePreferences(source), parsePreferences(defaults));
  }
  assert.deepEqual(parsePreference(" \tPDF, epub > * > mobi # fallback"), [["pdf", "epub"], ["*"], ["mobi"]]);
  assert.deepEqual(parsePreference("azw3, cbz.zip, c++, x_private, pt-BR"), [["azw3", "cbz.zip", "c++", "x_private", "pt-br"]]);
});

test("empty documents are valid; empty expressions are not", () => {
  for (const source of ["", " \n\t", "# nothing\r\n# configured"]) {
    assert.equal(Object.keys(parsePreferences(source)).length, 0);
  }
  for (const source of ["", "   ", "# nothing"]) assert.throws(() => parsePreference(source), PreferenceSyntaxError);
  assert.throws(() => parsePreferences("format: # nothing"), PreferenceSyntaxError);
});

test("explicit values cannot be swallowed by a wildcard in any tier", () => {
  const cases = [
    { source: "* > pdf > mobi", pdf: 1, mobi: 2, other: 0 },
    { source: "pdf > * > mobi", pdf: 0, mobi: 2, other: 1 },
    { source: "pdf > mobi > *", pdf: 0, mobi: 1, other: 2 },
  ];
  for (const entry of cases) {
    const preference = parsePreference(entry.source);
    assert.equal(preferenceTier(preference, "PDF"), entry.pdf);
    assert.equal(preferenceTier(preference, "mobi"), entry.mobi);
    assert.equal(preferenceTier(preference, "other"), entry.other);
  }
  const siblings = parsePreference("*, pdf > mobi");
  assert.equal(preferenceTier(siblings, "pdf"), 0);
  assert.equal(preferenceTier(siblings, "azw3"), 0);
  assert.equal(preferenceTier(siblings, "mobi"), 1);
});

test("omitted values have no implicit tier; lookup does not invent domain meaning", () => {
  const preference = parsePreference("en, pt-BR > pt");
  assert.equal(preferenceTier(preference, " PT-br "), 0);
  assert.equal(preferenceTier(preference, "pt"), 1);
  for (const value of ["en-US", "pt-PT", "pt_BR", "", "english"]) {
    assert.equal(preferenceTier(preference, value), null);
  }
  const withRemainder = parsePreference("en > *");
  assert.equal(preferenceTier(withRemainder, "en-US"), 1);
  assert.equal(preferenceTier(withRemainder, ""), 1);
  assert.equal(preferenceTier(parsePreference("*"), "anything"), 0);
});

test("empty tiers, empty comma entries, and case-only duplicates are rejected", () => {
  for (const source of [
    "> pdf", "pdf >", "pdf >> epub", "pdf > > epub", ",pdf", "pdf,", "pdf,,epub",
    "pdf, PDF", "pdf > epub > PDF", "* > pdf > *",
  ]) assert.throws(() => parsePreference(source), PreferenceSyntaxError, source);
});

test("the grammar rejects quoting, escaping, partial globs, punctuation, and non-ASCII tokens", () => {
  for (const source of [
    '"pdf"', "'epub'", "en-*", "*.pdf", ".pdf", "pdf epub", "pdf:epub", "pdf;epub",
    "pdf\\,epub", "français", "K", "pdf\nepub", "pdf\rep ub",
  ]) assert.throws(() => parsePreference(source), PreferenceSyntaxError, source);
  for (const source of [
    "format pdf", ": pdf", "1format: pdf", "format name: pdf", "format.name: pdf", "K: pdf",
    "format: pdf\nFORMAT: epub", "format: pdf\n  > epub", "format: pdf\nnot a rule",
  ]) assert.throws(() => parsePreferences(source), PreferenceSyntaxError, source);
});

test("diagnostics point to the original line and offending token", () => {
  const duplicate = "  format: pdf, EPUB > * > PDF";
  assert.throws(() => parsePreferences(`# defaults\nlanguage: en\n${duplicate}`), error => {
    assert(error instanceof PreferenceSyntaxError);
    assert(error instanceof SyntaxError);
    assert.equal(error.name, "PreferenceSyntaxError");
    assert.equal(error.line, 3);
    assert.equal(error.column, duplicate.indexOf("PDF") + 1);
    assert.match(error.message, /^line 3, column \d+: duplicate value 'pdf'$/);
    return true;
  });
  assert.throws(() => parsePreference("pdf >"), error => {
    assert(error instanceof PreferenceSyntaxError);
    assert.equal(error.line, 1);
    assert.equal(error.column, 6);
    return true;
  });
  assert.throws(() => parsePreferences("format: pdf\n  format: epub"), error => {
    assert(error instanceof PreferenceSyntaxError);
    assert.equal(error.line, 2);
    assert.equal(error.column, 3);
    return true;
  });
});

test("parsed data cannot be changed and names do not inherit object properties", () => {
  const rules = parsePreferences("constructor: pdf\nToString: epub\nformat: pdf, epub > * > mobi");
  assert.equal(Object.getPrototypeOf(rules), null);
  assert.equal(rules.hasOwnProperty, undefined);
  assert.deepEqual(rules.constructor, [["pdf"]]);
  assert.deepEqual(rules.tostring, [["epub"]]);
  assert(Object.isFrozen(rules));
  assert(Object.isFrozen(rules.format));
  assert(Object.isFrozen(rules.format![0]));
  assert.throws(() => { (rules as Record<string, unknown>).format = []; }, TypeError);
  assert.throws(() => { (rules.format as string[][]).push(["mobi"]); }, TypeError);
  assert.throws(() => { (rules.format![0] as string[]).push("mobi"); }, TypeError);
});

test("the implementation works as a single file outside the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "portable-preferences-"));
  try {
    const module = join(root, "preferences.mts");
    copyFileSync(new URL("./preferences.ts", import.meta.url), module);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {parsePreferences, preferenceTier} from ${JSON.stringify(new URL("file://" + module).href)};
      const {format} = parsePreferences("format: pdf, epub > * > mobi");
      if (preferenceTier(format, "epub") !== 0 || preferenceTier(format, "mobi") !== 2) process.exit(1);
    `], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
