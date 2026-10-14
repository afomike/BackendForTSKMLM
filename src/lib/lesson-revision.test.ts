import test from "node:test";
import assert from "node:assert/strict";
import { reconcileParts, revisionProgress } from "./lesson-revision.js";

const before = [
  { partId: "intro", title: "Introduction", contentType: "video", fileUrl: "https://example.com/intro.mp4" },
  { partId: "reading", title: "Reading", contentType: "pdf", fileUrl: "https://example.com/reading.pdf", description: "Read chapter one" },
];

test("adding content reopens completion while retaining unchanged part progress", () => {
  const after = reconcileParts(before, [...before, { title: "New reading", contentType: "pdf", fileUrl: "https://example.com/new.pdf" }]);
  const revision = revisionProgress(before, after);
  assert.equal(revision.requiresCompletion, true);
  assert.deepEqual([...revision.unchanged], ["intro", "reading"]);
  assert.ok(after[2].partId);
});

test("replacing a file or changing learning instructions invalidates that part", () => {
  for (const changed of [{ ...before[1], fileUrl: "https://example.com/revised.pdf" }, { ...before[1], description: "Read chapter two" }]) {
    const revision = revisionProgress(before, [before[0], changed]);
    assert.equal(revision.requiresCompletion, true);
    assert.deepEqual([...revision.unchanged], ["intro"]);
  }
});

test("older clients can rename and reorder unchanged files without losing their IDs", () => {
  const incoming = [before[1], before[0]].map(({ partId: _id, ...part }) => ({ ...part, title: "Renamed", duration: 30 }));
  const after = reconcileParts(before, incoming);
  assert.deepEqual(after.map(part => part.partId), ["reading", "intro"]);
  assert.equal(revisionProgress(before, after).requiresCompletion, false);
});

test("removing a part cleans stale part references without reopening completed work", () => {
  const revision = revisionProgress(before, [before[0]]);
  assert.equal(revision.requiresCompletion, false);
  assert.deepEqual(["intro", "reading"].filter(id => revision.unchanged.has(id)), ["intro"]);
});

test("duplicate file URLs keep distinct stable part identities", () => {
  const repeated = [{ ...before[0], partId: "one" }, { ...before[0], partId: "two" }];
  const incoming = repeated.map(({ partId: _id, ...part }) => part);
  assert.deepEqual(reconcileParts(repeated, incoming).map(part => part.partId), ["one", "two"]);
});
