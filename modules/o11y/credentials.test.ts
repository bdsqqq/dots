import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("./default.nix", import.meta.url), "utf8");
// Exercise the native wiring without reading credentials or starting a collector.
const startups = [...source.matchAll(
  /(export AXIOM_URL="\$\{edgeUrl\}"[\s\S]*?)(?=\n\s+(?:exec )?\$\{pkgs\.opentelemetry-collector-contrib\}\/bin\/otelcol-contrib)/g,
)].map((match) => match[1]!);
assert.equal(startups.length, 2, "darwin and linux startup wiring must both be exercised");

for (const [index, startup] of startups.entries()) {
  const platform = index === 0 ? "darwin" : "linux";
  for (const [label, logs, metrics, expected] of [
    ["missing logs", undefined, "fixture-metrics", 1],
    ["missing metrics", "fixture-logs", undefined, 1],
    ["empty logs", "", "fixture-metrics", 1],
    ["empty metrics", "fixture-logs", "", 1],
    ["ready credentials", "fixture-logs", "fixture-metrics", 0],
  ] as const) {
    test(`${platform}: ${label}`, () => {
      const directory = mkdtempSync(join(tmpdir(), "o11y-credentials-"));
      try {
        const logsPath = join(directory, "logs");
        const metricsPath = join(directory, "metrics");
        if (logs !== undefined) writeFileSync(logsPath, logs);
        if (metrics !== undefined) writeFileSync(metricsPath, metrics);
        const script = startup
          .replaceAll("${edgeUrl}", "https://example.invalid")
          .replaceAll('${secret "papertrail_token"}', JSON.stringify(logsPath))
          .replaceAll('${secret "host_metrics_token"}', JSON.stringify(metricsPath));
        const result = spawnSync("bash", ["-c", `${script}
          bash -c 'test "$AXIOM_TOKEN_LOGS" = fixture-logs && test "$AXIOM_TOKEN_METRICS" = fixture-metrics' || exit 2
          printf started
        `], { encoding: "utf8", timeout: 5000 });
        assert.equal(result.status, expected, result.stderr);
        assert.equal(result.stdout, expected === 0 ? "started" : "");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
