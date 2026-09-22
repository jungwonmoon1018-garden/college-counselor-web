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
import v8 from "node:v8";

const MB = (bytes) => Math.round(bytes / (1024 * 1024));

export function memoryLine(usage, high, heapLimit) {
  return `[MEM] rss ${MB(usage.rss)} MB (high ${MB(high)}) · heap ${MB(usage.heapUsed)}/${MB(usage.heapTotal)} MB of ${MB(heapLimit)} · external ${MB(usage.external)} MB`;
}

// Whether a sample deserves a line: a new high by at least `stepBytes`, or
// `quietMs` since the last line.
export function shouldLogMemory({ rss, high, lastLineAt, now, stepBytes, quietMs }) {
  return rss >= high + stepBytes || now - lastLineAt >= quietMs;
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
