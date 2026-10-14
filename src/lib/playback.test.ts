import test from "node:test";
import assert from "node:assert/strict";
import { SavePlaybackBody, mergePlayback } from "./playback.js";

const revision = "2026-10-14T10:00:00.000Z";

test("30 minutes of a two-hour recording is preserved for resume", () => {
  const state = mergePlayback({}, "video", { positionSeconds: 1800, durationSeconds: 7200, capturedAt: revision }, new Date(revision));
  assert.equal(state.video.positionSeconds, 1800);
  assert.equal(state.video.durationSeconds, 7200);
  assert.equal(state.video.furthestSeconds, 1800);
});

test("rewinding changes the resume point without losing the furthest position", () => {
  const first = mergePlayback({}, "video", { positionSeconds: 1800, durationSeconds: 7200, capturedAt: revision });
  const rewound = mergePlayback(first, "video", { positionSeconds: 1200, durationSeconds: 7200, capturedAt: "2026-10-14T10:01:00.000Z" });
  assert.equal(rewound.video.positionSeconds, 1200);
  assert.equal(rewound.video.furthestSeconds, 1800);
  const audio = mergePlayback(rewound, "audio", { positionSeconds: 30, durationSeconds: 300, capturedAt: revision });
  assert.equal(audio.video.positionSeconds, 1200);
  assert.equal(audio.audio.positionSeconds, 30);
});

test("a delayed older request cannot overwrite newer progress", () => {
  const latest = mergePlayback({}, "video", { positionSeconds: 1800, durationSeconds: 7200, capturedAt: "2026-10-14T10:01:00.000Z" });
  assert.equal(mergePlayback(latest, "video", { positionSeconds: 100, durationSeconds: 7200, capturedAt: revision }), latest);
});

test("playback validates bounded finite times and requires the lesson revision", () => {
  const valid = { positionSeconds: 1800, durationSeconds: 7200, capturedAt: revision, lessonUpdatedAt: revision };
  assert.equal(SavePlaybackBody.safeParse(valid).success, true);
  for (const change of [{ positionSeconds: -1 }, { positionSeconds: Infinity }, { positionSeconds: NaN },
    { positionSeconds: 7201 }, { durationSeconds: 0 }, { durationSeconds: 604801 }, { lessonUpdatedAt: undefined }, { capturedAt: "invalid" }])
    assert.equal(SavePlaybackBody.safeParse({ ...valid, ...change }).success, false);
});
