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
	 * may contain lines already in head. we merge them.
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

		// overlap case: tail starts somewhere in head
		// find where tail's first line appears in head
		const tailStart = this.tail[0];
		const overlapIdx = this.head.indexOf(tailStart);

		if (overlapIdx === -1) {
			// no overlap (shouldn't happen, but handle gracefully)
			return [...this.head, ...this.tail];
		}

		// take head up to overlap, then all of tail
		const headPart = this.head.slice(0, overlapIdx);
		return [...headPart, ...this.tail];
	}

	/**
	 * get current buffer state for debugging.
	 */
	debug(): { head: string[]; tail: string[]; totalLines: number; pendingLine: string } {
		return {
			head: [...this.head],
			tail: [...this.tail],
			totalLines: this.totalLines,
			pendingLine: this.pendingLine,
		};
	}
}