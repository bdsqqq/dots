/**
 * output buffer with fixed head + rolling tail.
 *
 * maintains constant memory regardless of output size by keeping:
 * - first N lines (head, fill once then lock)
 * - last M lines (tail, ring buffer, always rolling)
 * - total line count (for truncation message)
 *
 * used by bash tool to show beginning + end of long outputs,
 * rather than only the tail.
 */

const DEFAULT_HEAD_LINES = 50;
const DEFAULT_TAIL_LINES = 50;

/**
 * truncate an array to head + tail, returning formatted result.
 * simpler than OutputBuffer — for when you have all items upfront (not streaming).
 *
 * @param items - array to truncate
 * @param maxItems - total items to show (split evenly between head/tail)
 * @returns { head, tail, truncated, truncatedCount }
 */
export function headTail<T>(
  items: T[],
  maxItems: number = 100,
): { head: T[]; tail: T[]; truncated: T[]; truncatedCount: number } {
  const total = items.length;
  if (total <= maxItems) {
    return { head: items, tail: [], truncated: [], truncatedCount: 0 };
  }

  const half = Math.floor(maxItems / 2);
  const head = items.slice(0, half);
  const tail = items.slice(-half);
  const truncated = items.slice(half, -half);

  return { head, tail, truncated, truncatedCount: truncated.length };
}

/**
 * format head+tail arrays with truncation marker.
 * returns a single string with items joined by newlines.
 */
export function formatHeadTail<T>(
  items: T[],
  maxItems: number = 100,
  truncatedMsg: (count: number) => string = (n) =>
    `... [${n} lines truncated] ...`,
): string {
  const { head, tail, truncatedCount } = headTail(items, maxItems);

  if (truncatedCount === 0) {
    return head.map(String).join("\n");
  }

  const parts = [
    ...head.map(String),
    "",
    truncatedMsg(truncatedCount),
    "",
    ...tail.map(String),
  ];

  return parts.join("\n");
}

/**
 * truncate raw text to head + tail by characters.
 * for when you have a single string (not lines) that needs truncation.
 */
export function headTailChars(
  text: string,
  maxChars: number = 64_000,
): { text: string; truncated: boolean; totalChars: number } {
  const total = text.length;
  if (total <= maxChars) {
    return { text, truncated: false, totalChars: total };
  }

  const half = Math.floor(maxChars / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  const truncated = total - maxChars;

  return {
    text: `${head}\n\n... [${truncated} characters truncated] ...\n\n${tail}`,
    truncated: true,
    totalChars: total,
  };
}

export class OutputBuffer {
  private head: string[] = [];
  private tail: string[] = [];
  private headComplete = false;
  private pendingLine = "";
  totalLines = 0;

  constructor(
    private maxHead: number = DEFAULT_HEAD_LINES,
    private maxTail: number = DEFAULT_TAIL_LINES,
  ) {}

  /**
   * add a chunk of output. handles partial lines at boundaries.
   * chunks may end mid-line, so we buffer the incomplete part.
   */
  add(chunk: string): void {
    // prepend any pending partial line from previous chunk
    const text = this.pendingLine + chunk;
    const lines = text.split("\n");

    // last element might be incomplete (no trailing newline)
    // keep it for the next chunk
    this.pendingLine = lines.pop() ?? "";

    for (const line of lines) {
      this.totalLines++;
      this.addLine(line);
    }
  }

  /**
   * add a complete line to the appropriate buffer.
   * fills head first, then rolls tail.
   */
  private addLine(line: string): void {
    if (!this.headComplete && this.head.length < this.maxHead) {
      this.head.push(line);
      if (this.head.length === this.maxHead) {
        this.headComplete = true;
      }
    }

    // always add to tail (handles small-output dedupe in format())
    this.tail.push(line);
    if (this.tail.length > this.maxTail) {
      this.tail.shift();
    }
  }

  /**
   * finalize and format the output.
   * returns the formatted text and count of truncated lines.
   *
   * small output (<= head + tail): dedupes overlap, no truncation marker
   * large output: head + marker + tail
   */
  format(): { text: string; truncatedLines: number } {
    // flush any remaining pending line
    if (this.pendingLine) {
      this.totalLines++;
      this.addLine(this.pendingLine);
      this.pendingLine = "";
    }

    const allLines = this.totalLines;

    // no truncation needed: output fits in head + tail combined
    if (allLines <= this.maxHead + this.maxTail) {
      // dedupe: when output is small, tail contains head entirely
      // or tail starts within head region
      const uniqueLines = this.dedupe(allLines);
      return { text: uniqueLines.join("\n"), truncatedLines: 0 };
    }

    // truncation: head + marker + tail
    const truncated = allLines - this.head.length - this.tail.length;
    const parts = [
      ...this.head,
      "",
      `... [${truncated} lines truncated] ...`,
      "",
      ...this.tail,
    ];

    return { text: parts.join("\n"), truncatedLines: truncated };
  }

  /**
   * deduplicate overlapping head/tail for small outputs.
   *
   * when total lines <= maxHead + maxTail, the tail buffer
   * may contain lines already in head. we merge them using
   * positional overlap (not value matching) to avoid dropping
   * legitimate lines when content has duplicates.
   */
  private dedupe(totalLines: number): string[] {
    // output smaller than head: head has everything
    if (totalLines <= this.maxHead) {
      return this.head;
    }

    // output smaller than tail: tail has everything
    if (totalLines <= this.maxTail) {
      return this.tail;
    }

    // overlap case: compute how many lines head and tail share
    // by position, not by value matching
    const overlapLen = Math.max(
      0,
      this.head.length + this.tail.length - totalLines,
    );

    if (overlapLen === 0) {
      // no overlap — concatenate directly
      return [...this.head, ...this.tail];
    }

    // take head up to the overlap boundary, then all of tail
    const headPart = this.head.slice(0, this.head.length - overlapLen);
    return [...headPart, ...this.tail];
  }

  /**
   * get current buffer state for debugging.
   */
  debug(): {
    head: string[];
    tail: string[];
    totalLines: number;
    pendingLine: string;
  } {
    return {
      head: [...this.head],
      tail: [...this.tail],
      totalLines: this.totalLines,
      pendingLine: this.pendingLine,
    };
  }
}

// inline tests
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("OutputBuffer", () => {
    describe("small output (no truncation)", () => {
      it("returns all lines when output < head + tail", () => {
        const buf = new OutputBuffer(50, 50);
        buf.add("line1\nline2\nline3\n");
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(0);
        expect(text).toBe("line1\nline2\nline3");
      });

      it("handles empty output", () => {
        const buf = new OutputBuffer(50, 50);
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(0);
        expect(text).toBe("");
      });

      it("handles single line", () => {
        const buf = new OutputBuffer(50, 50);
        buf.add("only line\n");
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(0);
        expect(text).toBe("only line");
      });

      it("handles single line without trailing newline", () => {
        const buf = new OutputBuffer(50, 50);
        buf.add("no newline here");
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(0);
        expect(text).toBe("no newline here");
      });

      it("counts empty lines", () => {
        const buf = new OutputBuffer(50, 50);
        buf.add("a\n\nb\n");
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(0);
        expect(buf.totalLines).toBe(3);
        expect(text).toBe("a\n\nb");
      });
    });

    describe("medium output (overlap dedup)", () => {
      it("dedupes when output smaller than head", () => {
        const buf = new OutputBuffer(3, 3);
        buf.add("1\n2\n"); // 2 lines, head=3
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(0);
        expect(text.split("\n")).toEqual(["1", "2"]);
      });

      it("dedupes when head and tail overlap exactly", () => {
        const buf = new OutputBuffer(3, 3);
        buf.add("1\n2\n3\n"); // 3 lines, head=3, tail=3
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(0);
        expect(text.split("\n")).toEqual(["1", "2", "3"]);
      });

      it("dedupes when tail starts in head region", () => {
        const buf = new OutputBuffer(3, 3);
        buf.add("1\n2\n3\n4\n"); // 4 lines, head=[1,2,3], tail=[2,3,4]
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(0);
        expect(text.split("\n")).toEqual(["1", "2", "3", "4"]);
      });

      it("dedupes when output smaller than tail capacity", () => {
        const buf = new OutputBuffer(50, 50);
        buf.add("a\nb\nc\n"); // 3 lines, tail has all
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(0);
        expect(text).toBe("a\nb\nc");
      });

      it("does not drop lines when content has duplicates (regression)", () => {
        // old value-based overlap used indexOf(tail[0]) and would
        // match the first "A", dropping middle lines.
        const buf = new OutputBuffer(3, 3);
        buf.add("A\nB\nA\nC\n"); // 4 lines, head=[A,B,A], tail=[B,A,C]
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(0);
        expect(text.split("\n")).toEqual(["A", "B", "A", "C"]);
      });

      it("handles all-identical lines without dropping (regression)", () => {
        const buf = new OutputBuffer(3, 3);
        buf.add("x\nx\nx\nx\nx\n"); // 5 lines, head=[x,x,x], tail=[x,x,x]
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(0);
        const lines = text.split("\n");
        expect(lines).toHaveLength(5);
        expect(lines.every((l) => l === "x")).toBe(true);
      });
    });

    describe("large output (truncation)", () => {
      it("shows head + marker + tail when truncated", () => {
        const buf = new OutputBuffer(2, 2);
        for (let i = 1; i <= 10; i++) {
          buf.add(`line${i}\n`);
        }
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(6); // 10 - 2 - 2

        expect(text).toContain("line1");
        expect(text).toContain("line2");
        expect(text).toContain("line9");
        expect(text).toContain("line10");
        expect(text).toContain("6 lines truncated");

        // verify ordering: head before marker before tail
        const idx1 = text.indexOf("line1");
        const idxMarker = text.indexOf("truncated");
        const idx10 = text.indexOf("line10");
        expect(idx1).toBeLessThan(idxMarker);
        expect(idxMarker).toBeLessThan(idx10);
      });

      it("tracks totalLines correctly", () => {
        const buf = new OutputBuffer(5, 5);
        buf.add("a\nb\nc\nd\ne\nf\ng\nh\n");
        expect(buf.totalLines).toBe(8);
      });

      it("shows exact truncated count", () => {
        const buf = new OutputBuffer(5, 5);
        for (let i = 1; i <= 100; i++) {
          buf.add(`line${i}\n`);
        }
        const { truncatedLines } = buf.format();
        expect(truncatedLines).toBe(90); // 100 - 5 - 5
      });

      it("handles output exactly at head+tail boundary", () => {
        const buf = new OutputBuffer(5, 5);
        for (let i = 1; i <= 10; i++) {
          buf.add(`line${i}\n`);
        }
        const { text, truncatedLines } = buf.format();
        // 10 lines exactly = 5 head + 5 tail, no truncation
        expect(truncatedLines).toBe(0);
        expect(text.split("\n")).toHaveLength(10);
      });

      it("handles output just over head+tail boundary", () => {
        const buf = new OutputBuffer(5, 5);
        for (let i = 1; i <= 11; i++) {
          buf.add(`line${i}\n`);
        }
        const { text, truncatedLines } = buf.format();
        // 11 lines = 5 head + 1 truncated + 5 tail
        expect(truncatedLines).toBe(1);
        expect(text).toContain("line1");
        expect(text).toContain("line11");
      });
    });

    describe("streaming (chunk handling)", () => {
      it("handles partial lines at chunk boundaries", () => {
        const buf = new OutputBuffer(5, 5);
        buf.add("hel"); // partial
        buf.add("lo\nworld"); // completes "hello", partial "world"
        buf.add("\n"); // completes "world"
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(0);
        expect(text).toBe("hello\nworld");
      });

      it("handles multiple chunks without newlines", () => {
        const buf = new OutputBuffer(5, 5);
        buf.add("abc");
        buf.add("def");
        buf.add("ghi\n");
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(0);
        expect(text).toBe("abcdefghi");
      });

      it("handles empty chunks", () => {
        const buf = new OutputBuffer(5, 5);
        buf.add("");
        buf.add("test\n");
        buf.add("");
        const { text } = buf.format();
        expect(text).toBe("test");
      });

      it("handles chunk ending with newline then more data", () => {
        const buf = new OutputBuffer(5, 5);
        buf.add("line1\n");
        buf.add("line2\n");
        buf.add("line3\n");
        const { text } = buf.format();
        expect(text).toBe("line1\nline2\nline3");
      });
    });

    describe("reversion guards (fail on old behavior)", () => {
      it("shows FIRST lines, not just tail", () => {
        // OLD BEHAVIOR: only tail (last N chars)
        // NEW BEHAVIOR: head (first N lines) + tail
        const buf = new OutputBuffer(5, 5);
        for (let i = 1; i <= 100; i++) {
          buf.add(`line ${i}\n`);
        }
        const { text } = buf.format();

        // CRITICAL: this FAILS on old tail-only truncation
        expect(text).toContain("line 1");
        expect(text).toContain("line 5");

        // AND still has tail
        expect(text).toContain("line 96");
        expect(text).toContain("line 100");
      });

      it("head comes BEFORE tail in output", () => {
        const buf = new OutputBuffer(5, 5);
        for (let i = 1; i <= 100; i++) {
          buf.add(`line ${i}\n`);
        }
        const { text } = buf.format();

        // verify ordering: head lines before tail lines
        const firstHeadIdx = text.indexOf("line 1");
        const lastHeadIdx = text.indexOf("line 5");
        const firstTailIdx = text.indexOf("line 96");
        const lastTailIdx = text.indexOf("line 100");

        // all head indices < all tail indices
        expect(lastHeadIdx).toBeLessThan(firstTailIdx);
        expect(firstHeadIdx).toBeLessThan(lastTailIdx);
      });

      it("truncation marker between head and tail", () => {
        const buf = new OutputBuffer(5, 5);
        for (let i = 1; i <= 100; i++) {
          buf.add(`line ${i}\n`);
        }
        const { text } = buf.format();

        // marker must be between head and tail
        const lastHeadIdx = text.indexOf("line 5");
        const markerIdx = text.indexOf("truncated");
        const firstTailIdx = text.indexOf("line 96");

        expect(lastHeadIdx).toBeLessThan(markerIdx);
        expect(markerIdx).toBeLessThan(firstTailIdx);
      });
    });

    describe("edge cases", () => {
      it("handles very long single line (no newlines)", () => {
        const buf = new OutputBuffer(50, 50);
        buf.add("x".repeat(100000));
        const { text, truncatedLines } = buf.format();
        // single line, no truncation (it fits in head)
        expect(truncatedLines).toBe(0);
        expect(text.length).toBe(100000);
      });

      it("handles many short lines", () => {
        const buf = new OutputBuffer(5, 5);
        for (let i = 0; i < 1000; i++) {
          buf.add("x\n");
        }
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(990); // 1000 - 5 - 5
        // should have 5 head + 5 tail + marker lines
        const lines = text.split("\n");
        expect(lines.filter((l) => l === "x").length).toBe(10);
      });

      it("handles mixed empty and non-empty lines", () => {
        const buf = new OutputBuffer(50, 50);
        buf.add("a\n\nb\n\nc\n");
        const { text, truncatedLines } = buf.format();
        expect(truncatedLines).toBe(0);
        expect(text).toBe("a\n\nb\n\nc");
        expect(buf.totalLines).toBe(5);
      });

      it("handles carriage returns (treats as part of line)", () => {
        const buf = new OutputBuffer(50, 50);
        buf.add("line1\r\nline2\r\n");
        const { text } = buf.format();
        // \r is kept as part of the line content
        expect(text).toBe("line1\r\nline2\r");
      });
    });
  });

  // ============================================================
  // headTail and formatHeadTail helpers
  // ============================================================

  describe("headTail helper", () => {
    it("returns all items when under limit", () => {
      const items = [1, 2, 3, 4, 5];
      const { head, tail, truncated, truncatedCount } = headTail(items, 10);
      expect(head).toEqual([1, 2, 3, 4, 5]);
      expect(tail).toEqual([]);
      expect(truncated).toEqual([]);
      expect(truncatedCount).toBe(0);
    });

    it("splits evenly at limit", () => {
      const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const { head, tail, truncatedCount } = headTail(items, 10);
      expect(head).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(tail).toEqual([]);
      expect(truncatedCount).toBe(0);
    });

    it("splits into head + tail when over limit", () => {
      const items = Array.from({ length: 100 }, (_, i) => i + 1);
      const { head, tail, truncated, truncatedCount } = headTail(items, 20);
      expect(head).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(tail).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 100]);
      expect(truncatedCount).toBe(80);
      expect(truncated.length).toBe(80);
    });

    it("uses even split for head and tail", () => {
      const items = Array.from({ length: 100 }, (_, i) => i + 1);
      const { head, tail, truncatedCount } = headTail(items, 21);
      expect(head.length).toBe(10); // floor(21/2)
      expect(tail.length).toBe(10); // floor(21/2)
      expect(truncatedCount).toBe(80);
    });
  });

  describe("formatHeadTail helper", () => {
    it("joins items when under limit", () => {
      const items = ["a", "b", "c"];
      const result = formatHeadTail(items, 10);
      expect(result).toBe("a\nb\nc");
    });

    it("formats with truncation marker when over limit", () => {
      const items = Array.from({ length: 100 }, (_, i) => `item ${i + 1}`);
      const result = formatHeadTail(items, 20);
      expect(result).toContain("item 1");
      expect(result).toContain("item 10");
      expect(result).toContain("item 91");
      expect(result).toContain("item 100");
      expect(result).toContain("80 lines truncated");
      // verify ordering
      expect(result.indexOf("item 10")).toBeLessThan(
        result.indexOf("truncated"),
      );
      expect(result.indexOf("truncated")).toBeLessThan(
        result.indexOf("item 91"),
      );
    });

    it("uses custom truncation message", () => {
      const items = Array.from({ length: 50 }, () => `x`);
      const result = formatHeadTail(items, 10, (n) => `-- ${n} hidden --`);
      expect(result).toContain("-- 40 hidden --");
    });
  });
}
