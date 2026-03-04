# tools extension

custom tool implementations for pi. replaces built-in tools with versions that add file mutex locking, change tracking, and cheerio-based HTML→markdown conversion.

## deps

```bash
bun install
```

pi doesn't auto-install deps for local extensions — only for packages added via `pi install`. run this after cloning or updating `package.json`.
