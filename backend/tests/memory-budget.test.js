// The hosted instance has 512 MB for three Node processes. Measured on
// 2026-09-21: V8, left to size its heap from the memory it sees, kept 263 MB
// of heap after ten Common Data Sets were parsed in a row although 17 MB of
// it was live; with the old space capped and small semi-spaces it kept
// 44 MB. These tests pin the two things that came out of that: the children
// of the launcher get explicit heap budgets, and the server writes its
// memory to the log so a restart for memory can be read back.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { memoryLine, shouldLogMemory, startMemoryWatch } from "../server/memory-watch.js";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MB = 1024 * 1024;

test("the launcher starts the server and the sidecar with heap budgets", () => {
  const source = fs.readFileSync(path.join(BACKEND, "web-launcher.mjs"), "utf8");
  assert.ok(source.includes('nodeFlags("NODE_FLAGS_SERVER", "--max-old-space-size=192 --max-semi-space-size=8")'));
  assert.ok(source.includes('nodeFlags("NODE_FLAGS_SIDECAR", "--max-old-space-size=96 --max-semi-space-size=4")'));
  assert.ok(source.includes('spawn(process.execPath, [...SERVER_NODE_FLAGS, path.join(__dirname, "server.js")]'));
  assert.ok(source.includes('spawn(process.execPath, [...SIDECAR_NODE_FLAGS, path.join(__dirname, "simulation-sidecar.js")]'));
});

test("a memory line is written for a new high by a clear step, and hourly otherwise", () => {
  const base = { high: 200 * MB, lastLineAt: 1_000, stepBytes: 32 * MB, quietMs: 3_600_000 };
  assert.equal(shouldLogMemory({ ...base, rss: 210 * MB, now: 2_000 }), false, "a small rise is not a line");
  assert.equal(shouldLogMemory({ ...base, rss: 232 * MB, now: 2_000 }), true, "a new high by the step is");
  assert.equal(shouldLogMemory({ ...base, rss: 150 * MB, now: 1_000 + 3_600_000 }), true, "an hour of quiet is");
  assert.equal(
    memoryLine({ rss: 214 * MB, heapUsed: 41 * MB, heapTotal: 63 * MB, external: 22 * MB }, 214 * MB, 240 * MB),
    "[MEM] rss 214 MB (high 214) · heap 41/63 MB of 240 · external 22 MB",
  );
});

test("the watch writes its first line at once and does not keep the process alive", () => {
  const lines = [];
  const timer = startMemoryWatch({ log: (line) => lines.push(line) });
  try {
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[MEM\] rss \d+ MB \(high \d+\) · heap \d+\/\d+ MB of \d+ · external \d+ MB$/);
    assert.equal(timer.hasRef(), false);
  } finally {
    clearInterval(timer);
  }
});

test("server.js starts the watch outside the test runner", () => {
  const source = fs.readFileSync(path.join(BACKEND, "server.js"), "utf8");
  assert.ok(source.includes('if (NODE_ENV !== "test") startMemoryWatch();'));
});
