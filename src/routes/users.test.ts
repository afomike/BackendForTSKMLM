import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import bcrypt from "bcryptjs";

// Exercise real HTTP routes and authentication without contacting a live DB.
process.env.SESSION_SECRET = "test-only-session-secret-never-use-in-production";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
const { db, pool, userProgressTable, lessonsTable, assignmentSubmissionsTable, quizAttemptsTable } = await import("../lib/db.js");
const { signToken, optionalAuth, credentialKey, verifyToken } = await import("../lib/auth.js");
const { default: usersRouter } = await import("./users.js");
const { default: authRouter } = await import("./auth.js");
const { default: quizRouter } = await import("./quizzes.js");
const { default: progressRouter } = await import("./progress.js");
const { default: lessonRouter } = await import("./lessons.js");
const { default: courseRouter } = await import("./courses.js");
const { isLessonLocked } = await import("../lib/lesson-access.js");
const { withLessonRevision } = await import("../lib/course-revision.js");
const adminId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const admin = { id: adminId, fullname: "Admin", email: "admin@example.com", role: "admin", status: "active", createdAt: new Date(), passwordHash: "secret-hash", avatarUrl: null };
const student = { ...admin, id: targetId, fullname: "Student", email: "student@example.com", role: "student" };
let selections: unknown[][] = [];
let inserted: Record<string, unknown> | undefined;
let mutations: string[] = [];
let returned: unknown[] = [];
let updateValues: Array<{ table: unknown; values: Record<string, unknown> }> = [];
let insertResults: unknown[][] | null = null;
let deletedTables: unknown[] = [];

function chain(rows: unknown[]) {
  const query: any = { then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject) };
  for (const method of ["from", "where", "orderBy", "limit", "offset", "groupBy", "onConflictDoNothing", "onConflictDoUpdate", "returning", "set", "for"]) query[method] = () => query;
  query.values = (values: Record<string, unknown>) => { inserted = values; return query; };
  return query;
}

test("account administration HTTP behavior", async t => {
  const original = { select: db.select, insert: db.insert, update: db.update, delete: db.delete, transaction: db.transaction };
  (db as any).select = () => {
    assert.ok(selections.length, "Unexpected database select");
    return chain(selections.shift()!);
  };
  (db as any).insert = () => { mutations.push("insert"); return chain(insertResults ? insertResults.shift() ?? [] : returned); };
  (db as any).update = (table: unknown) => {
    mutations.push("update");
    const query = chain(returned);
    query.set = (values: Record<string, unknown>) => { updateValues.push({ table, values }); return query; };
    return query;
  };
  (db as any).delete = (table: unknown) => { mutations.push("delete"); deletedTables.push(table); return chain(returned); };
  (db as any).transaction = async (callback: any) => callback({ ...db, select: db.select, insert: db.insert, update: db.update, delete: db.delete, execute: async () => { mutations.push("lock"); } });
  const app = express();
  app.use(express.json());
  app.use(usersRouter, authRouter, quizRouter, progressRouter, lessonRouter, courseRouter);
  app.get("/optional", optionalAuth, (req, res) => res.json({ userId: req.userId ?? null }));
  app.use((err: unknown, _req: any, res: any, _next: any) => res.status(typeof err === "object" && err && "status" in err ? Number(err.status) : 500).json({ error: "Request failed" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const token = signToken({ userId: adminId, role: "admin", credential: credentialKey(admin.passwordHash) });
  const request = (path: string, method = "GET", body?: unknown, auth: string | null = token) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const reset = (rows: unknown[][], result: unknown[] = []) => { selections = rows; returned = result; mutations = []; inserted = undefined; updateValues = []; insertResults = null; deletedTables = []; };
  try {
    await t.test("anonymous and malformed tokens cannot create accounts", async () => {
      reset([]);
      for (const auth of [null, "invalid"]) assert.equal((await request("/admin/users", "POST", {}, auth)).status, 401);
      assert.deepEqual(mutations, []);
    });
    await t.test("database role overrides stale admin token", async () => {
      reset([[student]]);
      assert.equal((await request("/admin/users", "POST", {})).status, 403);
      assert.deepEqual(mutations, []);
    });
    await t.test("suspended and deleted users lose access with an existing token", async () => {
      for (const rows of [[{ ...admin, status: "suspended" }], []]) {
        reset([rows]);
        assert.equal((await request("/admin/users")).status, 401);
      }
    });
    await t.test("creates students and admins with normalized emails and hashed passwords", async () => {
      for (const role of ["student", "admin"]) {
        reset([[admin], []], [{ ...student, role }]);
        const res = await request("/admin/users", "POST", { fullname: " New Account ", email: " NEW@Example.com ", password: "secret123", role });
        assert.equal(res.status, 201);
        const user = await res.json();
        assert.equal(user.role, role);
        assert.equal(user.passwordHash, undefined);
        assert.equal(inserted?.email, "new@example.com");
        assert.equal(inserted?.fullname, "New Account");
        assert.equal(inserted?.role, role);
        assert.ok(await bcrypt.compare("secret123", String(inserted?.passwordHash)));
      }
    });
    await t.test("invalid roles and passwords never insert", async () => {
      for (const body of [{ role: "owner", password: "secret123" }, { role: "admin", password: "short" }, { role: "student", password: "💚".repeat(19) }]) {
        reset([[admin]]);
        assert.equal((await request("/admin/users", "POST", { fullname: "Name", email: "new@example.com", ...body })).status, 400);
        assert.deepEqual(mutations, []);
      }
    });
    await t.test("duplicate email and insert conflict return 409", async () => {
      for (const rows of [[[admin], [student]], [[admin], []]]) {
        reset(rows);
        assert.equal((await request("/admin/users", "POST", { fullname: "Name", email: "student@example.com", password: "secret123" })).status, 409);
      }
    });
    await t.test("self deletion and self suspension are blocked", async () => {
      for (const method of ["DELETE", "PATCH"]) {
        reset([[admin], [admin], [admin]]);
        const path = `/admin/users/${adminId}${method === "PATCH" ? "/status" : ""}`;
        assert.equal((await request(path, method, { status: "suspended" })).status, 409);
        assert.deepEqual(mutations, ["lock"]);
      }
    });
    await t.test("deletes a student and another admin", async () => {
      for (const target of [student, { ...student, role: "admin" }]) {
        reset([[admin], [admin], [target], ...(target.role === "admin" ? [[{ value: 2 }]] : [])]);
        assert.equal((await request(`/admin/users/${targetId}`, "DELETE")).status, 204);
        assert.deepEqual(mutations, ["lock", "delete"]);
      }
    });
    await t.test("final active admin and concurrent actor deactivation are guarded", async () => {
      reset([[admin], [admin], [{ ...student, role: "admin" }], [{ value: 1 }]]);
      assert.equal((await request(`/admin/users/${targetId}`, "DELETE")).status, 409);
      assert.deepEqual(mutations, ["lock"]);
      reset([[admin], [{ ...admin, status: "suspended" }]]);
      assert.equal((await request(`/admin/users/${targetId}`, "DELETE")).status, 403);
      assert.deepEqual(mutations, ["lock"]);
    });
    await t.test("missing users and invalid IDs are rejected", async () => {
      reset([[admin], [admin], []]);
      assert.equal((await request(`/admin/users/${targetId}`, "DELETE")).status, 404);
      reset([[admin]]);
      assert.equal((await request("/admin/users/invalid", "DELETE")).status, 400);
    });
    await t.test("suspends and reactivates another account", async () => {
      for (const status of ["suspended", "active"]) {
        reset([[admin], [admin], [student]], [{ ...student, status }]);
        const res = await request(`/admin/users/${targetId}/status`, "PATCH", { status });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).status, status);
        assert.deepEqual(mutations, ["lock", "update"]);
      }
    });
    await t.test("list batches progress counts without disclosing password hashes", async () => {
      reset([[admin], [admin, student], [{ userId: targetId, value: 3 }], [{ userId: targetId, value: 7 }]]);
      const res = await request("/admin/users");
      assert.equal(res.status, 200);
      const users = await res.json();
      assert.equal(users[1].enrolledCourses, 3);
      assert.equal(users[1].completedLessons, 7);
      assert.ok(users.every((user: any) => !user.passwordHash));
      assert.equal(selections.length, 0);
    });
    await t.test("pagination validates bounds", async () => {
      reset([[admin]]);
      assert.equal((await request("/admin/users?limit=1000")).status, 400);
    });
    await t.test("profile requires a meaningful update", async () => {
      reset([[admin]]);
      assert.equal((await request("/auth/profile", "PATCH", {})).status, 400);
      assert.deepEqual(mutations, []);
    });
    await t.test("optional auth ignores suspended identities", async () => {
      reset([[{ ...admin, status: "suspended" }]]);
      assert.equal((await (await request("/optional")).json()).userId, null);
    });
    await t.test("quiz questions require exactly one boolean correct answer", async () => {
      for (const flags of [[false, false], [true, true], ["false", true]]) {
        reset([[admin], [admin]]);
        const res = await request(`/lessons/${targetId}/quiz`, "PUT", { passingScore: 70,
          questions: [{ questionText: "Question", options: flags.map(isCorrect => ({ optionText: "Answer", isCorrect })) }] });
        assert.equal(res.status, 400);
        assert.deepEqual(mutations, []);
      }
    });
    await t.test("progress rejects truthy strings instead of completing lessons", async () => {
      reset([[admin]]);
      assert.equal((await request(`/lessons/${targetId}/progress`, "PATCH", { completed: "false" })).status, 400);
      assert.deepEqual(mutations, []);
    });
    await t.test("roles can be promoted and demoted but self changes are blocked", async () => {
      for (const role of ["admin", "student"]) {
        reset([[admin], [admin], [{ ...student, role: role === "admin" ? "student" : "admin" }], ...(role === "student" ? [[{ value: 2 }]] : [])], [{ ...student, role }]);
        const res = await request(`/admin/users/${targetId}/role`, "PATCH", { role });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).role, role);
      }
      reset([[admin], [admin], [admin]]);
      assert.equal((await request(`/admin/users/${adminId}/role`, "PATCH", { role: "student" })).status, 409);
      assert.deepEqual(mutations, ["lock"]);
    });
    await t.test("filtered pagination exposes total count and rejects invalid filters", async () => {
      reset([[admin], [student], [{ count: 26 }], [], []]);
      const response = await request("/admin/users?page=2&limit=25&role=student&status=active&search=Student");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("X-Total-Count"), "26");
      assert.equal(response.headers.get("X-Page"), "2");
      assert.equal((await response.json()).length, 1);
      reset([[admin]]);
      assert.equal((await request("/admin/users?role=owner")).status, 400);
    });
    await t.test("credential changes reject previously issued tokens", async () => {
      reset([[{ ...admin, passwordHash: "a-new-password-hash" }]]);
      assert.equal((await request("/admin/users")).status, 401);
      assert.deepEqual(mutations, []);
    });
    await t.test("password change requires current password and returns a bound replacement token", async () => {
      const oldHash = await bcrypt.hash("current123", 10);
      const newHash = await bcrypt.hash("changed123", 10);
      const account = { ...admin, passwordHash: oldHash };
      const oldToken = signToken({ userId: adminId, role: "admin", credential: credentialKey(oldHash) });
      reset([[account], [account]]);
      assert.equal((await request("/auth/password", "POST", { currentPassword: "wrong", newPassword: "changed123" }, oldToken)).status, 400);
      assert.deepEqual(mutations, []);
      reset([[account], [account]], [{ ...account, passwordHash: newHash }]);
      const response = await request("/auth/password", "POST", { currentPassword: "current123", newPassword: "changed123" }, oldToken);
      assert.equal(response.status, 200);
      const replacement = await response.json();
      assert.equal(verifyToken(replacement.token).credential, credentialKey(newHash));
      assert.notEqual(replacement.token, oldToken);
      reset([[{ ...account, passwordHash: newHash }]]);
      assert.equal((await request("/auth/me", "GET", undefined, oldToken)).status, 401);
    });
    await t.test("lesson access permits previews, admins and completed lessons while locking later lessons", () => {
      const lessons = [{ id: "first" }, { id: "second" }, { id: "third" }];
      assert.equal(isLessonLocked(lessons, 0, false, new Set()), false);
      assert.equal(isLessonLocked(lessons, 1, false, new Set()), true);
      assert.equal(isLessonLocked(lessons, 1, true, new Set()), true);
      assert.equal(isLessonLocked(lessons, 1, true, new Set(["first"])), false);
      assert.equal(isLessonLocked(lessons, 1, true, new Set(["second"])), false);
      assert.equal(isLessonLocked(lessons, 2, true, new Set(["first"])), true);
      assert.equal(isLessonLocked(lessons, 2, false, new Set(), "admin"), false);
    });
    await t.test("public lesson lists hide locked file URLs and direct requests reject them", async () => {
      const lessons = [{ ...student, id: targetId, courseId: adminId, title: "Preview", lessonOrder: 1, fileUrl: "https://res.cloudinary.com/preview.mp4", parts: [], contentType: "video" },
        { ...student, id: "33333333-3333-4333-8333-333333333333", courseId: adminId, title: "Locked", lessonOrder: 2, fileUrl: "https://res.cloudinary.com/private.mp4", parts: [], contentType: "video" }];
      reset([lessons]);
      const response = await request(`/courses/${adminId}/lessons`, "GET", undefined, null);
      assert.equal(response.status, 200);
      const list = await response.json();
      assert.equal(list[0].fileUrl, lessons[0].fileUrl);
      assert.equal(list[1].fileUrl, "");
      assert.deepEqual(list[1].parts, []);
      assert.equal(list[1].isLocked, true);
      reset([[lessons[1]], lessons]);
      assert.equal((await request(`/lessons/${lessons[1].id}`, "GET", undefined, null)).status, 403);
    });
    await t.test("locked lessons reject completion, downloads and quiz content", async () => {
      const first = { id: targetId };
      const locked = { id: "33333333-3333-4333-8333-333333333333", courseId: adminId, lessonOrder: 2 };
      const lessons = [first, locked];
      const enrollment = { id: "enrollment" };
      for (const [path, method] of [[`/lessons/${locked.id}/complete`, "POST"], [`/lessons/${locked.id}/download`, "GET"],
        [`/lessons/${locked.id}/parts/part/download`, "GET"]]) {
        reset([[student], [locked], [enrollment], lessons, [enrollment], []]);
        assert.equal((await request(path, method)).status, 403);
        assert.deepEqual(mutations, []);
        assert.equal(selections.length, 0);
      }
      reset([[student], [{ id: "quiz", lessonId: locked.id }], [locked], lessons, [enrollment], []]);
      assert.equal((await request(`/lessons/${locked.id}/quiz`)).status, 403);
      assert.equal(selections.length, 0);
    });
    await t.test("adding a part to a finished lesson clears completion and preserves unchanged part progress", async () => {
      const parts = [{ partId: "original", title: "Original", contentType: "video", fileUrl: "https://res.cloudinary.com/original.mp4" }];
      const before = { id: targetId, courseId: adminId, title: "Lesson", lessonOrder: 1, parts, contentType: "video", fileUrl: parts[0].fileUrl, duration: null, createdAt: new Date(), updatedAt: new Date() };
      const after = { ...before, parts: [...parts, { partId: "new", title: "New", contentType: "pdf", fileUrl: "https://res.cloudinary.com/new.pdf" }] };
      const progress = { id: "progress", completed: true, completedAt: new Date(), completedParts: ["original"], downloadedParts: ["original"] };
      reset([[admin], [before], [progress], []], [after]);
      const response = await request(`/lessons/${targetId}`, "PATCH", { parts: after.parts });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).progressReset, true);
      const saved = updateValues.find(update => update.table === userProgressTable)!.values;
      assert.equal(saved.completed, false);
      assert.equal(saved.completedAt, null);
      assert.deepEqual(saved.completedParts, ["original"]);
      assert.deepEqual(saved.downloadedParts, ["original"]);
      assert.equal(updateValues.find(update => update.table === assignmentSubmissionsTable)?.values.status, "pending");
      assert.equal(selections.length, 0);
    });
    await t.test("a title-only save from an older editor retains part IDs and completion", async () => {
      const originalPart = { partId: "original", title: "Original", contentType: "video", fileUrl: "https://res.cloudinary.com/original.mp4" };
      const before = { id: targetId, courseId: adminId, title: "Lesson", lessonOrder: 1, parts: [originalPart], contentType: "video", fileUrl: originalPart.fileUrl, duration: null, createdAt: new Date(), updatedAt: new Date() };
      reset([[admin], [before], [{ id: "progress", completed: true, completedParts: ["original"], downloadedParts: [] }]], [{ ...before, title: "Renamed lesson" }]);
      const { partId: _id, ...withoutId } = originalPart;
      const response = await request(`/lessons/${targetId}`, "PATCH", { title: "Renamed lesson", parts: [withoutId] });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).progressReset, false);
      assert.equal((updateValues.find(update => update.table === lessonsTable)!.values.parts as any[])[0].partId, "original");
      assert.equal(updateValues.find(update => update.table === userProgressTable)!.values.completed, undefined);
      assert.ok(!updateValues.some(update => update.table === assignmentSubmissionsTable));
    });
    await t.test("a new lesson changes a formerly completed course to unfinished", async () => {
      const course = { id: adminId, title: "Course", thumbnailUrl: null };
      const completedLesson = { id: targetId };
      const addedLesson = { id: "33333333-3333-4333-8333-333333333333" };
      const progress = { lessonId: targetId, completed: true, completedAt: new Date() };
      reset([[student], [{ courseId: adminId }], [progress], [course], [completedLesson, addedLesson]]);
      const response = await request("/student/progress");
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.totalCompleted, 0);
      assert.equal(body.enrolledCourses[0].isCompleted, false);
      assert.equal(body.enrolledCourses[0].progressPercent, 50);
    });
    await t.test("stale completion writes cannot restore progress after a lesson revision", async () => {
      const lesson = { id: targetId, updatedAt: new Date("2026-10-14T10:00:00Z") } as any;
      let written = false;
      reset([[{ ...lesson, updatedAt: new Date("2026-10-14T11:00:00Z") }]]);
      assert.equal(await withLessonRevision(lesson, undefined, async () => { written = true; }), false);
      assert.equal(written, false);
      reset([[lesson]]);
      assert.equal(await withLessonRevision(lesson, "2026-10-14T09:00:00.000Z", async () => { written = true; }), false);
      assert.equal(written, false);
    });
    await t.test("new quiz requirements reset completion and clear old passes", async () => {
      const lesson = { id: targetId, courseId: adminId };
      reset([[admin], [admin], [lesson], []]);
      insertResults = [[{ id: "quiz" }], [{ id: "question" }], [], []];
      const response = await request(`/lessons/${targetId}/quiz`, "PUT", {
        passingScore: 70, questions: [{ questionText: "New question", options: [{ optionText: "Yes", isCorrect: true }, { optionText: "No", isCorrect: false }] }],
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).progressReset, true);
      assert.equal(updateValues.find(update => update.table === userProgressTable)?.values.completed, false);
      assert.equal(updateValues.find(update => update.table === userProgressTable)?.values.completedAt, null);
      assert.ok(deletedTables.includes(quizAttemptsTable));
      assert.equal(updateValues.find(update => update.table === assignmentSubmissionsTable)?.values.status, "pending");
    });
    await t.test("saving an unchanged quiz preserves completion and previous passes", async () => {
      reset([[admin], [admin], [{ id: targetId, courseId: adminId }], [{ id: "quiz", passingScore: 70 }],
        [{ id: "question", questionText: "Question" }], [{ optionText: "Yes", isCorrect: true }, { optionText: "No", isCorrect: false }]]);
      const response = await request(`/lessons/${targetId}/quiz`, "PUT", {
        passingScore: 70, questions: [{ questionText: "Question", options: [{ optionText: "Yes", isCorrect: true }, { optionText: "No", isCorrect: false }] }],
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).progressReset, false);
      assert.deepEqual(mutations, ["lock"]);
      assert.deepEqual(deletedTables, []);
    });
    await t.test("students and admins can upload their own avatar; invalid uploads do not save", async () => {
      const originalFetch = globalThis.fetch;
      const keys = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
      const originalEnvironment = keys.map(key => process.env[key]);
      const avatarUrl = "https://res.cloudinary.com/avatar-test/image/upload/avatar.png";
      let uploads = 0;
      try {
        process.env.CLOUDINARY_CLOUD_NAME = "avatar-test";
        process.env.CLOUDINARY_API_KEY = "test-key";
        process.env.CLOUDINARY_API_SECRET = "test-secret";
        globalThis.fetch = async (input, options) => {
          if (String(input).startsWith("https://api.cloudinary.com/")) {
            uploads++;
            return Response.json({ secure_url: avatarUrl, resource_type: "image" });
          }
          return originalFetch(input, options);
        };
        const send = (body: Buffer, auth: string | null = token) => fetch(`http://127.0.0.1:${address.port}/auth/avatar`, {
          method: "POST", headers: { "Content-Type": "image/png", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: new Uint8Array(body),
        });
        const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        reset([]);
        assert.equal((await send(png, null)).status, 401);
        for (const account of [student, admin]) {
          reset([[account]], [{ ...account, avatarUrl }]);
          const response = await send(png);
          assert.equal(response.status, 200);
          assert.equal((await response.json()).avatarUrl, avatarUrl);
          assert.equal(updateValues[0].values.avatarUrl, avatarUrl);
        }
        reset([[student]]);
        assert.equal((await send(Buffer.from("fake image"))).status, 400);
        assert.deepEqual(mutations, []);
        reset([[student]]);
        assert.equal((await send(Buffer.alloc(5 * 1024 * 1024 + 1))).status, 413);
        assert.deepEqual(mutations, []);
        assert.equal(uploads, 2);
      } finally {
        globalThis.fetch = originalFetch;
        keys.forEach((key, index) => { if (originalEnvironment[index] === undefined) delete process.env[key]; else process.env[key] = originalEnvironment[index]; });
      }
    });
    await t.test("partial playback persists 30 minutes without completing the lesson and is returned on the next visit", async () => {
      const revision = new Date();
      const lesson = { id: targetId, courseId: adminId, title: "Two-hour lesson", contentType: "video", fileUrl: "https://res.cloudinary.com/video.mp4",
        parts: [{ partId: "video", title: "Recording", contentType: "video", fileUrl: "https://res.cloudinary.com/video.mp4" }], updatedAt: revision, createdAt: revision };
      const enrollment = { id: "enrolled" };
      reset([[student], [lesson], [enrollment], [{ id: targetId }], [enrollment], [], [lesson], []]);
      const response = await request(`/lessons/${targetId}/parts/video/playback`, "PATCH", {
        positionSeconds: 1800, durationSeconds: 7200, capturedAt: revision.toISOString(), lessonUpdatedAt: revision.toISOString(),
      });
      assert.equal(response.status, 200);
      assert.equal(inserted?.completed, undefined);
      assert.equal(inserted?.completedParts, undefined);
      const positions = inserted?.playbackPositions as any;
      assert.equal(positions.video.positionSeconds, 1800);
      assert.equal(positions.video.durationSeconds, 7200);
      assert.equal(selections.length, 0);
      reset([[student], [lesson], [{ id: targetId }], [enrollment], [], [{ playbackPositions: positions, completedParts: [], downloadedParts: [] }]]);
      const revisit = await request(`/lessons/${targetId}`);
      assert.equal(revisit.status, 200);
      assert.equal((await revisit.json()).playbackPositions.video.positionSeconds, 1800);
    });
    await t.test("invalid, unenrolled and stale playback requests cannot write progress", async () => {
      const lesson = { id: targetId, courseId: adminId, contentType: "video", fileUrl: "https://res.cloudinary.com/video.mp4",
        parts: [{ partId: "video", contentType: "video", fileUrl: "https://res.cloudinary.com/video.mp4" }], updatedAt: new Date() };
      const body = { positionSeconds: 1800, durationSeconds: 7200, capturedAt: new Date().toISOString(), lessonUpdatedAt: lesson.updatedAt.toISOString() };
      reset([[student]]);
      assert.equal((await request(`/lessons/${targetId}/parts/video/playback`, "PATCH", { ...body, positionSeconds: 8000 })).status, 400);
      assert.deepEqual(mutations, []);
      reset([[student], [lesson], []]);
      assert.equal((await request(`/lessons/${targetId}/parts/video/playback`, "PATCH", body)).status, 403);
      assert.deepEqual(mutations, []);
      reset([[student], [lesson], [{ id: "enrolled" }], [{ id: targetId }], [{ id: "enrolled" }], [], [lesson]]);
      assert.equal((await request(`/lessons/${targetId}/parts/video/playback`, "PATCH", { ...body, lessonUpdatedAt: new Date(lesson.updatedAt.getTime() - 1000).toISOString() })).status, 409);
      assert.deepEqual(mutations, []);
    });
    await t.test("a partially watched lesson updates last activity without counting as completed", async () => {
      const lastViewedAt = new Date();
      reset([[student], [{ courseId: adminId }], [{ lessonId: targetId, completed: false, lastViewedAt }],
        [{ id: adminId, title: "Course", thumbnailUrl: null }], [{ id: targetId }]]);
      const response = await request("/student/progress");
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.completedLessons, 0);
      assert.equal(body.totalCompleted, 0);
      assert.equal(body.enrolledCourses[0].lastActivityAt, lastViewedAt.toISOString());
      assert.equal(body.enrolledCourses[0].isCompleted, false);
    });
  } finally {
    Object.assign(db, original);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await pool.end();
  }
});
