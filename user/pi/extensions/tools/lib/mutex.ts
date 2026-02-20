/**
 * per-path async mutex for file operations.
 *
 * amp serializes concurrent edits to the same file path to prevent
 * partial writes and race conditions. pi's built-in edit tool doesn't.
 * this mutex is keyed by resolved absolute path — two relative paths
 * pointing to the same file share one lock.
 */

import * as path from "node:path";

const locks = new Map<string, Promise<void>>();

/**
 * execute `fn` while holding an exclusive lock on `filePath`.
 * concurrent calls for the same resolved path queue sequentially.
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const key = path.resolve(filePath);

	while (locks.has(key)) {
		await locks.get(key);
	}

	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	locks.set(key, promise);

	try {
		return await fn();
	} finally {
		locks.delete(key);
		resolve();
	}
}
