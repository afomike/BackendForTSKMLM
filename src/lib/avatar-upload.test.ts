import test from "node:test";
import assert from "node:assert/strict";
import { avatarImageType, uploadAvatar } from "./avatar-upload.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("avatar validation checks image bytes rather than just the filename", () => {
  assert.equal(avatarImageType(png), "image/png");
  assert.equal(avatarImageType(Buffer.from([255, 216, 255, 224])), "image/jpeg");
  assert.equal(avatarImageType(Buffer.from("RIFFxxxxWEBP")), "image/webp");
  assert.equal(avatarImageType(Buffer.from("<svg>unsafe</svg>")), null);
  assert.equal(avatarImageType(Buffer.from("a renamed text file")), null);
});

test("invalid or oversized avatars never reach the image provider", async () => {
  const fake: typeof fetch = async () => { assert.fail("Unexpected provider request"); };
  await assert.rejects(uploadAvatar(Buffer.from("not an image"), "user", fake), /JPG, PNG or WebP/);
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
  png.copy(oversized);
  await assert.rejects(uploadAvatar(oversized, "user", fake), /5 MB/);
});

test("avatar uploads use a signed image request and return a public image URL", async () => {
  const keys = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "CLOUDINARY_FOLDER"];
  const original = keys.map(key => process.env[key]);
  try {
    process.env.CLOUDINARY_CLOUD_NAME = "avatar-test";
    process.env.CLOUDINARY_API_KEY = "test-api-key";
    process.env.CLOUDINARY_API_SECRET = "test-api-secret";
    process.env.CLOUDINARY_FOLDER = "test-folder";
    const url = await uploadAvatar(png, "user-id", async (input, options) => {
      assert.equal(String(input), "https://api.cloudinary.com/v1_1/avatar-test/image/upload");
      assert.equal(options?.redirect, "error");
      const body = options?.body as FormData;
      assert.match(String(body.get("public_id")), /^test-folder\/avatars\/user-id\//);
      assert.match(String(body.get("signature")), /^[a-f0-9]{40}$/);
      assert.equal(body.has("api_secret"), false);
      assert.equal(body.get("transformation"), "c_limit,h_512,w_512");
      assert.equal((body.get("file") as Blob).type, "image/png");
      return Response.json({ secure_url: "https://res.cloudinary.com/avatar-test/image/upload/avatar.png", resource_type: "image" });
    });
    assert.equal(url, "https://res.cloudinary.com/avatar-test/image/upload/avatar.png");
    await assert.rejects(uploadAvatar(png, "user-id", async () => new Response(null, { status: 400 })), /could not be uploaded/);
    await assert.rejects(uploadAvatar(png, "user-id", async () => Response.json({ secure_url: "https://example.com/unsafe", resource_type: "image" })), /invalid upload/);
  } finally {
    keys.forEach((key, index) => { if (original[index] === undefined) delete process.env[key]; else process.env[key] = original[index]; });
  }
});
