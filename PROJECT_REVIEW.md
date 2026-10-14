# Project review and account management

Reviewed on 14 October 2026. Projects: `BackendForTSKMLM` and sibling `SeedSowerLMC`.

## Delivered

| Area | Change |
| --- | --- |
| Account administration | Admin-only `POST /api/admin/users` creates students or admins; `DELETE /api/admin/users/:id` permanently deletes an account. Password hashes are never returned. Public registration still creates students only. |
| Admin UI | Existing `/admin/students` page now manages all users, with a Users navigation label, search, role filters, account creation, suspension/reactivation, deletion confirmation, loading/error states and retry. |
| Admin protection | Self deletion/suspension is blocked. Account removal and status changes use a transaction-scoped PostgreSQL advisory lock, recheck the acting admin, and preserve an active admin. These safeguards apply to the HTTP endpoints; existing maintenance scripts remain separate. |
| Authentication | Protected requests load the current account role/status. Deleted or suspended accounts cannot use existing tokens. JWTs also bind to the password hash, so changing a password invalidates old sessions. JWT verification restricts algorithms and validates payload fields. Database failures propagate as server errors instead of being mistaken for invalid credentials. |
| Validation | Names/emails are trimmed; emails are normalized on registration, login and admin creation. Existing differently cased emails are found using case-insensitive lookup. Password creation rejects input beyond bcrypt's 72-byte limit. Profile updates reject empty input and invalid names/URLs. |
| Profile | Frontend saves now call `/api/auth/profile`, matching the backend. Clearing an avatar stores null. |
| User listing | Enrollment/progress counts are batched into two aggregate queries rather than two queries per user. Pagination rejects invalid/out-of-range values. Unpaginated responses remain compatible with the frontend. |
| Deployment | Quiz/editor/settings requests use the configured API base URL. Quiz deletion checks HTTP failures. Frontend handles unauthorized identity responses and clears cached data when changing accounts. |
| HTTP | CORS accepts configured origins rather than every Vercel deployment. `FRONTEND_URL` remains supported. Download filenames and pagination headers are exposed to frontend JavaScript. Server errors do not expose internal exception messages. Responses already streaming pass failures to Express. |
| Quizzes | Quiz replacement uses one database transaction. Questions require exactly one correct option, boolean answer flags and a finite passing score. |
| Progress | Progress updates require a boolean; the string `"false"` can no longer mark a lesson completed. |
| Tests | `npm test` runs the storage test and HTTP route tests with a mocked database. They exercise actual Express routing, authorization and password hashing without changing live data. |

## Verification and operating requirements

- Backend and frontend TypeScript checks and production builds were run.
- Backend tests pass: 31 tests, including account/lesson HTTP scenarios and download/rate-limit tests.
- HTTP tests mock database reads/writes. They do not validate a real PostgreSQL lock, foreign-key cascade or concurrent transaction execution.
- Existing migrations define cascades for enrollment, lesson progress, quiz attempts and assignment submissions, and set deleted reviewers to null. Account deletion relies on these migrations being installed. No migration was added or applied during this work.
- Use the Users navigation entry after signing in as an admin. Existing `/admin/students` links continue to work.
- Configure `FRONTEND_URL` for any additional deployed frontend origin. Arbitrary Vercel previews are no longer automatically allowed.
- Changes are local source changes; hosted applications still need their normal deployment.
- The Cloudinary API secret pasted into the conversation needs rotation in Cloudinary and the deployment environment. No secret was copied into this report or new source files.

## Further findings and verification gaps

This is a source review and targeted implementation, not a claim that every feature is production-certified. Further work should include:

1. **Storage-level content protection:** server endpoints now enforce the existing first-lesson preview and sequential lesson unlocking, hide locked file URLs, and block locked lesson downloads/progress/quiz access. Public Cloudinary URLs that were already shared remain accessible at the provider; restricted assets need a storage-level protection strategy.
2. **Custom download providers:** default download hosts and every redirect are restricted to trusted HTTPS providers. Requests have a two-minute timeout, files a 512 MB limit, and archives a 100-file/1 GB limit. Additional `DOWNLOAD_ALLOWED_HOSTS` entries must be trusted public providers. This is a provider allowlist, not a general-purpose arbitrary URL fetcher with DNS pinning.
3. **Account security:** login/registration/password-change throttling and password changes with old-session invalidation are now implemented. Still add a durable administration audit trail, email-based recovery, email verification and individual session revocation. Logout currently removes the browser token; it does not revoke a copied token on the server. Throttling is per process; multi-instance deployments need a shared gateway or datastore limit as well.
4. **Database invariants:** the existing email uniqueness constraint is case-sensitive. The new normalized input and case-insensitive lookup cover normal requests, but a database unique index on `lower(email)` would also prevent races involving legacy differently cased records. First check existing data for collisions. Assignment submission uniqueness and concurrent review/resubmission behavior also merit database-backed tests.
5. **Scale and usability:** admin users now have server-backed search, role/status filters and 25-account pages. Mobile navigation and lesson error/retry states are added. Most general API types still use optional fields or `any`; tighten them incrementally. The homepage includes a roughly 1.9 MB image that could be compressed or converted to a modern format.
6. **End-to-end coverage:** verify account creation/deletion, cascade cleanup, simultaneous admin actions, profile saves, quizzes, downloads, certificates and mobile navigation against a disposable database in a real browser. No live accounts were created or deleted and no browser automation was available in this session.

These items require additional implementation or environment-level verification; they were not silently assumed to be complete.

## Second implementation pass

- **Profile → Change password:** requires the current password, checks confirmation in the UI and uses a compare-and-swap database update. A replacement JWT keeps the current browser signed in; old tokens fail against the new password fingerprint. No database migration is required. Old-format JWTs issued before this release are rejected, so users must sign in again after deployment.
- **Admin → Users:** adds promotion/demotion of other accounts, preserving self/final-admin protections. Search and role/status filtering run on the server with bounded pagination and escaped search wildcards.
- **Lesson access:** the first lesson remains a preview; enrolled students unlock subsequent lessons by completing their predecessor. Previously completed lessons remain available. Admins can inspect all lessons without enrollment. The same policy is applied to API reads, progress, quizzes and downloads.
- **Course downloads:** the course page now exposes an unlocked-files ZIP button using the server ZIP endpoint instead of downloading all files in parallel and assembling a second archive in the browser. Completion invalidates the cached download list so newly unlocked files appear. ZIP filenames use UTF-8, and upstream streams are cleaned up on failures.
- **Legacy lessons:** single-file lessons without saved parts can now record completion of their fallback part. The part-completion response includes the `completedPartIds` field expected by the frontend.
- **Navigation:** account menus include course/user/dashboard links and admin site settings on smaller screens. The profile uses the matching admin/student layout.

Deploy backend and frontend together. Configure additional trusted download providers in `DOWNLOAD_ALLOWED_HOSTS` if existing lessons use other hosting services. Existing database migrations still need to be installed; this pass did not alter schema or live records. Browser and real database end-to-end checks remain outstanding.
