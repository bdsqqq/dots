// Failure injection is confined to a fresh verification process and an on-disk copy.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const source = realpathSync(
  new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js",
    import.meta.url,
  ),
);
const original = readFileSync(source, "utf8");
const needle =
  'this.sharedFrame.setFooterMarker(this.result ? this.theme.fg("muted", "╰────") : undefined);';
assert.equal(
  original.split(needle).length,
  2,
  "negative control source contract changed",
);
const broken = original.replace(
  needle,
  "this.sharedFrame.setFooterMarker(undefined);",
);
writeFileSync(process.env.PI_RENDER_NEGATIVE_SOURCE, broken);
registerHooks({
  load(url, context, nextLoad) {
    if (url === pathToFileURL(source).href)
      return {
        format: "module",
        source: readFileSync(process.env.PI_RENDER_NEGATIVE_SOURCE, "utf8"),
        shortCircuit: true,
      };
    return nextLoad(url, context);
  },
});
