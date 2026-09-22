// server/memory-watch.js — the process's memory in the log, so that a restart
// for memory on the host can be read back afterwards. The instance has
// 512 MB for the launcher, this server and the simulation sidecar; when the
// owner asked on 2026-09-21 why memory overflowed, nothing in the log said
// how much the server had been using or what it was doing at the time, and
// the causes had to be found by measurement on another machine.
//
// A line is written when the resident size sets a new high by a clear step,
// and once an hour otherwise:
//   [MEM] rss 214 MB (high 214) · heap 41/63 MB of 240 · external 22 MB
// Most of what the heavy paths use (pdf.js, rasterized pages, the OCR
// worker) is outside the V8 heap, so rss is the number to compare with the
// instance's limit, not heap.
import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";

const MB_BYTES = 1024 * 1024;
const MB = (bytes) => Math.round(bytes / MB_BYTES);

export function memoryLine(usage, high, heapLimit) {
  return `[MEM] rss ${MB(usage.rss)} MB (high ${MB(high)}) · heap ${MB(usage.heapUsed)}/${MB(usage.heapTotal)} MB of ${MB(heapLimit)} · external ${MB(usage.external)} MB`;
}

// Whether a sample deserves a line: a new high by at least `stepBytes`, or
// `quietMs` since the last line.
export function shouldLogMemory({ rss, high, lastLineAt, now, stepBytes, quietMs }) {
  return rss >= high + stepBytes || now - lastLineAt >= quietMs;
}

// The data directory's size by top-level entry, once at boot: the disk is
// 1 GB, and nothing said how much the document cache, the attachments, the
// backups and the databases take of it.
//   [DISK] data 612 MB: cds-cache 54 MB, counselor.db 9 MB, backups 3 MB
export function dataDirUsage(dir) {
  const sizeOf = (p) => {
    let stat;
    try { stat = fs.statSync(p); } catch { return 0; }
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    let entries = [];
    try { entries = fs.readdirSync(p); } catch { return 0; }
    for (const name of entries) total += sizeOf(path.join(p, name));
    return total;
  };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { totalBytes: 0, entries: [] }; }
  const entries = names.map((name) => ({ name, bytes: sizeOf(path.join(dir, name)) })).sort((a, b) => b.bytes - a.bytes);
  return { totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0), entries };
}

export function dataDirUsageLine(dir) {
  const { totalBytes, entries } = dataDirUsage(dir);
  const top = entries.filter((e) => e.bytes >= MB_BYTES).slice(0, 6).map((e) => `${e.name} ${MB(e.bytes)} MB`);
  return `[DISK] data ${MB(totalBytes)} MB${top.length ? `: ${top.join(", ")}` : ""}`;
}

export function startMemoryWatch({
  sampleMs = 10_000,
  stepBytes = 32 * 1024 * 1024,
  quietMs = 60 * 60 * 1000,
  log = console.log,
} = {}) {
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  let high = 0;
  let lastLineAt = 0;
  const sample = () => {
    const usage = process.memoryUsage();
    const now = Date.now();
    if (!shouldLogMemory({ rss: usage.rss, high, lastLineAt, now, stepBytes, quietMs })) return;
    high = Math.max(high, usage.rss);
    lastLineAt = now;
    log(memoryLine(usage, high, heapLimit));
  };
  sample();
  const timer = setInterval(sample, sampleMs);
  timer.unref();
  return timer;
}
