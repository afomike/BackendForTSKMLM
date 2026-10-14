import test from "node:test";
import assert from "node:assert/strict";
import { rateLimit } from "./rate-limit.js";
import { validateDownloadUrl, fetchDownload } from "./download-source.js";

test("rate limits isolate clients, set retry time and expire", () => {
  let now = 1000;
  const middleware = rateLimit(2, 1000, () => now);
  function attempt(ip: string) {
    let passed = false;
    const response: any = { headers: {}, set(key: string, value: string) { this.headers[key] = value; return this; },
      status(value: number) { this.code = value; return this; }, json(value: unknown) { this.body = value; return this; } };
    middleware({ ip } as any, response, () => { passed = true; });
    return { passed, response };
  }
  assert.equal(attempt("client-a").passed, true);
  assert.equal(attempt("client-a").passed, true);
  const blocked = attempt("client-a");
  assert.equal(blocked.passed, false);
  assert.equal(blocked.response.code, 429);
  assert.equal(blocked.response.headers["Retry-After"], "1");
  assert.equal(attempt("client-b").passed, true);
  now += 1000;
  assert.equal(attempt("client-a").passed, true);
});

test("download URLs allow trusted HTTPS providers and reject arbitrary destinations", () => {
  for (const url of ["https://res.cloudinary.com/demo/file.pdf", "https://drive.usercontent.google.com/file", "https://doc-123.googleusercontent.com/file"]) {
    assert.equal(validateDownloadUrl(url).protocol, "https:");
  }
  for (const url of ["http://res.cloudinary.com/file", "https://res.cloudinary.com.evil.example/file", "https://localhost/file",
    "https://127.0.0.1/file", "https://169.254.169.254/file", "https://example.com/file", "file:///etc/passwd",
    "https://user:password@res.cloudinary.com/file", "https://res.cloudinary.com:8443/file"]) {
    assert.throws(() => validateDownloadUrl(url));
  }
});

test("download redirects cannot escape allowed providers", async () => {
  let calls = 0;
  const fake: typeof fetch = async (_url, options) => {
    calls += 1;
    assert.equal(options?.redirect, "manual");
    assert.ok(options?.signal);
    return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } });
  };
  await assert.rejects(fetchDownload("https://res.cloudinary.com/file", fake), /not allowed/);
  assert.equal(calls, 1);
});

test("valid redirects stream content and remove stale compressed-content headers", async () => {
  let calls = 0;
  const fake: typeof fetch = async () => ++calls === 1
    ? new Response(null, { status: 302, headers: { location: "https://drive.usercontent.google.com/file" } })
    : new Response("file bytes", { headers: { "content-type": "application/pdf", "content-length": "5", "content-encoding": "gzip" } });
  const response = await fetchDownload("https://res.cloudinary.com/file", fake);
  assert.equal(await response.text(), "file bytes");
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(calls, 2);
});

test("download redirects and declared file sizes are bounded", async () => {
  let calls = 0;
  await assert.rejects(fetchDownload("https://res.cloudinary.com/file", async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "/again" } });
  }), /redirects/);
  assert.equal(calls, 6);
  await assert.rejects(fetchDownload("https://res.cloudinary.com/file", async () =>
    new Response("file", { headers: { "content-length": String(513 * 1024 * 1024) } })), /512 MB/);
});
