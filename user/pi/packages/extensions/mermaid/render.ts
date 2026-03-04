import { renderMermaidASCII } from "beautiful-mermaid";
import { visibleWidth } from "@mariozechner/pi-tui";
import { createHash } from "node:crypto";

export type MermaidPreset = {
  key: string;
  paddingX: number;
  boxBorderPadding: number;
};

export type RenderedDiagram = {
  ansi: string;
  lines: string[];
  maxWidth: number;
  lineCount: number;
};

export type RenderCache = {
  map: Map<string, RenderedDiagram>;
  maxEntries: number;
};

export const PRESETS: MermaidPreset[] = [
  { key: "roomy", paddingX: 4, boxBorderPadding: 2 },
  { key: "normal", paddingX: 2, boxBorderPadding: 1 },
  { key: "tight", paddingX: 1, boxBorderPadding: 1 },
  { key: "tighter", paddingX: 1, boxBorderPadding: 0 },
  { key: "tightest", paddingX: 0, boxBorderPadding: 0 },
];

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex").slice(0, 8);
}

export function createCache(maxEntries = 128): RenderCache {
  return { map: new Map(), maxEntries };
}

export function renderWithCache(
  cache: RenderCache,
  code: string,
  preset: MermaidPreset,
): RenderedDiagram {
  const key = `${hashCode(code)}|${preset.key}`;
  const existing = cache.map.get(key);

  if (existing) {
    // touch for LRU — move to end of insertion order
    cache.map.delete(key);
    cache.map.set(key, existing);
    return existing;
  }

  /** colorMode "none" — pi-tui handles theming; we don't want beautiful-mermaid's ANSI colors fighting pi's theme */
  const raw = renderMermaidASCII(code, {
    paddingX: preset.paddingX,
    boxBorderPadding: preset.boxBorderPadding,
    colorMode: "none",
  });

  const ansi = raw.trimEnd();
  const lines = ansi.split("\n");
  let maxWidth = 0;
  for (const line of lines) {
    const w = visibleWidth(line);
    if (w > maxWidth) maxWidth = w;
  }

  const rendered: RenderedDiagram = {
    ansi,
    lines,
    maxWidth,
    lineCount: lines.length,
  };

  cache.map.set(key, rendered);

  if (cache.map.size > cache.maxEntries) {
    // evict oldest (first key in Map iteration order)
    const oldest = cache.map.keys().next().value!;
    cache.map.delete(oldest);
  }

  return rendered;
}

export function pickBestPreset(
  cache: RenderCache,
  code: string,
  width: number,
): { preset: MermaidPreset; rendered: RenderedDiagram; overflowed: boolean } {
  let last: { preset: MermaidPreset; rendered: RenderedDiagram } | undefined;

  for (const preset of PRESETS) {
    const rendered = renderWithCache(cache, code, preset);
    last = { preset, rendered };

    if (rendered.maxWidth <= width) {
      return { preset, rendered, overflowed: false };
    }
  }

  return { ...last!, overflowed: true };
}
