import type { Subprocess } from "bun";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { bunEnv, bunExe, isDebug, isFlaky, isLinux } from "harness";
import { join } from "path";

const payload = Buffer.alloc(512 * 1024, "1").toString("utf-8"); // decent size payload to test memory leak
const batchSize = 40;
const totalCount = 10_000;
const zeroCopyPayload = new Blob([payload]);
const zeroCopyJSONPayload = new Blob([JSON.stringify({ bun: payload })]);

let url: URL;
let process: Subprocess<"ignore", "pipe", "inherit"> | null = null;
beforeEach(async () => {
  if (process) {
    process?.kill();
  }

  let defer = Promise.withResolvers();
  process = Bun.spawn([bunExe(), "--smol", join(import.meta.dirname, "body-leak-test-fixture.ts")], {
    env: bunEnv,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    ipc(message) {
      defer.resolve(message);
    },
  });
  url = new URL(await defer.promise);
  process.unref();
  await warmup();
});
afterEach(() => {
  process?.kill();
});

async function getMemoryUsage(): Promise<number> {
  return (await fetch(`${url.origin}/report`).then(res => res.json())) as number;
}

async function warmup() {
  var remaining = totalCount;

  while (remaining > 0) {
    const batch = new Array(batchSize);
    for (let j = 0; j < batchSize; j++) {
      // warmup the server with streaming requests, because is the most memory intensive
      batch[j] = fetch(`${url.origin}/streaming`, {
        method: "POST",
        body: zeroCopyPayload,
      });
    }
    await Promise.all(batch);
    remaining -= batchSize;
  }
  // clean up memory before first test
  await getMemoryUsage();
}

async function callBuffering() {
  const result = await fetch(`${url.origin}/buffering`, {
    method: "POST",
    body: zeroCopyPayload,
  }).then(res => res.text());
  expect(result).toBe("Ok");
}
async function callJSONBuffering() {
  const result = await fetch(`${url.origin}/json-buffering`, {
    method: "POST",
    body: zeroCopyJSONPayload,
  }).then(res => res.text());
  expect(result).toBe("Ok");
}

async function callBufferingBodyGetter() {
  const result = await fetch(`${url.origin}/buffering+body-getter`, {
    method: "POST",
    body: zeroCopyPayload,
  }).then(res => res.text());
  expect(result).toBe("Ok");
}
async function callStreaming() {
  const result = await fetch(`${url.origin}/streaming`, {
    method: "POST",
    body: zeroCopyPayload,
  }).then(res => res.text());
  expect(result).toBe("Ok");
}
async function callIncompleteStreaming() {
  const result = await fetch(`${url.origin}/incomplete-streaming`, {
    method: "POST",
    body: zeroCopyPayload,
  }).then(res => res.text());
  expect(result).toBe("Ok");
}
async function callStreamingEcho() {
  const result = await fetch(`${url.origin}/streaming-echo`, {
    method: "POST",
    body: zeroCopyPayload,
  }).then(res => res.text());
  expect(result).toBe(payload);
}
async function callIgnore() {
  const result = await fetch(url, {
    method: "POST",
    body: zeroCopyPayload,
  }).then(res => res.text());
  expect(result).toBe("Ok");
}

async function calculateMemoryLeak(fn: () => Promise<void>) {
  const start_memory = await getMemoryUsage();
  const memory_examples: Array<number> = [];
  let peak_memory = start_memory;

  var remaining = totalCount;
  while (remaining > 0) {
    const batch = new Array(batchSize);
    for (let j = 0; j < batchSize; j++) {
      batch[j] = fn();
    }
    await Promise.all(batch);
    remaining -= batchSize;

    // garbage collect and check memory usage every 1000 requests
    if (remaining > 0 && remaining % 1000 === 0) {
      const report = await getMemoryUsage();
      if (report > peak_memory) {
        peak_memory = report;
      }
      memory_examples.push(report);
    }
  }

  // wait for the last memory usage to be stable
  const end_memory = await getMemoryUsage();
  if (end_memory > peak_memory) {
    peak_memory = end_memory;
  }
  // use first example as a reference if is a memory leak this should keep increasing and not be stable
  const consumption = end_memory - memory_examples[0];
  // memory leak in MB
  const leak = Math.floor(consumption > 0 ? consumption / 1024 / 1024 : 0);
  return { leak, start_memory, peak_memory, end_memory, memory_examples };
}

// Since the payload size is 512 KB
// If it was leaking the body, the memory usage would be at least 512 KB * 10_000 = 5 GB
// If it ends up around 280 MB, it's probably not leaking the body.
for (const test_info of [
  ["#10265 should not leak memory when ignoring the body", callIgnore, false, 64],
  ["should not leak memory when buffering the body", callBuffering, false, 64],
  ["should not leak memory when buffering a JSON body", callJSONBuffering, false, 64],
  ["should not leak memory when buffering the body and accessing req.body", callBufferingBodyGetter, false, 64],
  ["should not leak memory when streaming the body", callStreaming, isFlaky && isLinux, 64],
  ["should not leak memory when streaming the body incompletely", callIncompleteStreaming, false, 64],
  ["should not leak memory when streaming the body and echoing it back", callStreamingEcho, false, 64],
] as const) {
  const [testName, fn, skip, maxMemoryGrowth] = test_info;
  it.todoIf(skip)(
    testName,
    async () => {
      const report = await calculateMemoryLeak(fn);
      // peak memory is too high
      expect(report.peak_memory).not.toBeGreaterThan(report.start_memory * 2.5);
      // acceptable memory leak
      expect(report.leak).toBeLessThanOrEqual(maxMemoryGrowth);
      expect(report.end_memory).toBeLessThanOrEqual(512 * 1024 * 1024);
    },
    isDebug ? 60_000 : 40_000,
  );
}
