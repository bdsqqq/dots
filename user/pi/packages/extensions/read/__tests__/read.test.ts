/**
 * SDK-backed integration tests for read tool execution.
 *
 * Tests tool execution outcomes with real tmpdir for file system operations.
 * Focuses on observable outcomes: error messages, content returned, etc.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createReadTool,
  NORMAL_LIMITS,
  isSecretFile,
} from "../index";

describe("read tool execution", () => {
  let testDir: string;
  const tmpdir = os.tmpdir();

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(tmpdir, "pi-read-tool-"));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe("secret file blocking", () => {
    it("refuses to read .env files", async () => {
      const tool = createReadTool(NORMAL_LIMITS);
      const envPath = path.join(testDir, ".env");
      fs.writeFileSync(envPath, "SECRET=value");

      const result = (await tool.execute!(
        "test-id",
        { path: envPath },
        undefined,
        undefined,
        { cwd: testDir } as any
      )) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("refused to read");
      expect(result.content[0].text).toContain("secrets");
    });

    it("refuses to read files matching secret patterns", () => {
      // Verify isSecretFile helper recognizes secret patterns
      expect(isSecretFile(path.join(testDir, ".env"))).toBe(true);
      expect(isSecretFile(path.join(testDir, ".env.local"))).toBe(true);
      expect(isSecretFile(path.join(testDir, ".env.production"))).toBe(true);
      // .env.example is explicitly allowed
      expect(isSecretFile(path.join(testDir, ".env.example"))).toBe(false);
      expect(isSecretFile(path.join(testDir, "secrets.yaml"))).toBe(false); // not blocked by pattern
      expect(isSecretFile(path.join(testDir, "normal.txt"))).toBe(false);
    });
  });

  describe("file not found", () => {
    it("returns error for non-existent file", async () => {
      const tool = createReadTool(NORMAL_LIMITS);

      const result = (await tool.execute!(
        "test-id",
        { path: path.join(testDir, "nonexistent.txt") },
        undefined,
        undefined,
        { cwd: testDir } as any
      )) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("file not found");
    });
  });

  describe("directory listing", () => {
    it("lists directory contents with trailing / for subdirs", async () => {
      const tool = createReadTool(NORMAL_LIMITS);
      fs.mkdirSync(path.join(testDir, "subdir"));
      fs.writeFileSync(path.join(testDir, "file.txt"), "content");

      const result = (await tool.execute!(
        "test-id",
        { path: testDir },
        undefined,
        undefined,
        { cwd: testDir } as any
      )) as any;

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("file.txt");
      expect(result.content[0].text).toContain("subdir/");
      expect(result.details.isDirectory).toBe(true);
    });
  });

  describe("text file reading", () => {
    it("reads file with line numbers", async () => {
      const tool = createReadTool(NORMAL_LIMITS);
      const filePath = path.join(testDir, "test.txt");
      fs.writeFileSync(filePath, "first line\nsecond line\nthird line");

      const result = (await tool.execute!(
        "test-id",
        { path: filePath },
        undefined,
        undefined,
        { cwd: testDir } as any
      )) as any;

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe("1: first line\n2: second line\n3: third line");
      expect(result.details.filePath).toBe(filePath);
    });

    it("respects read_range parameter", async () => {
      const tool = createReadTool(NORMAL_LIMITS);
      const filePath = path.join(testDir, "test.txt");
      fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5");

      const result = (await tool.execute!(
        "test-id",
        { path: filePath, read_range: [2, 4] },
        undefined,
        undefined,
        { cwd: testDir } as any
      )) as any;

      // Notice is appended when not all lines are shown
      expect(result.content[0].text).toContain("2: line2\n3: line3\n4: line4");
      expect(result.details.notice).toContain("showing lines 2-4 of 5");
    });

    it("shows notice when file has more lines than shown", async () => {
      const tool = createReadTool({ ...NORMAL_LIMITS, maxLines: 2 });
      const filePath = path.join(testDir, "test.txt");
      fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5");

      const result = (await tool.execute!(
        "test-id",
        { path: filePath },
        undefined,
        undefined,
        { cwd: testDir } as any
      )) as any;

      expect(result.content[0].text).toContain("showing lines 1-2 of 5");
      expect(result.details.notice).toContain("showing lines");
    });

    it("expands ~ to home directory", async () => {
      const tool = createReadTool(NORMAL_LIMITS);
      const homeFile = path.join(os.homedir(), ".test-pi-read-tmp.txt");
      fs.writeFileSync(homeFile, "home content");

      try {
        const result = (await tool.execute!(
          "test-id",
          { path: "~/.test-pi-read-tmp.txt" },
          undefined,
          undefined,
          { cwd: testDir } as any
        )) as any;

        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain("home content");
      } finally {
        fs.unlinkSync(homeFile);
      }
    });
  });

  describe("image file reading", () => {
    it("returns base64 encoded image with mime type", async () => {
      const tool = createReadTool(NORMAL_LIMITS);
      const imagePath = path.join(testDir, "test.png");
      // Minimal valid PNG (1x1 transparent)
      const pngBuffer = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64"
      );
      fs.writeFileSync(imagePath, pngBuffer);

      const result = (await tool.execute!(
        "test-id",
        { path: imagePath },
        undefined,
        undefined,
        { cwd: testDir } as any
      )) as any;

      expect(result.isError).toBeUndefined();
      expect(result.content[0].type).toBe("image");
      expect(result.content[0].mimeType).toBe("image/png");
      expect(result.content[0].data).toBeDefined();
    });
  });
});
