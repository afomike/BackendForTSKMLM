import test from "node:test";
import assert from "node:assert/strict";
import { ObjectStorageService } from "./objectStorage.js";

test("normalizes Cloudinary asset URLs to object paths", () => {
  const service = new ObjectStorageService();

  const normalized = service.normalizeObjectEntityPath(
    "https://res.cloudinary.com/demo/image/upload/v1710000000/avatars/profile.png"
  );

  assert.equal(normalized, "/objects/avatars/profile.png");
});
