import { createHash, randomUUID } from "node:crypto";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export function avatarImageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function uploadAvatar(bytes: Buffer, userId: string, fetcher: typeof fetch = fetch): Promise<string> {
  const type = avatarImageType(bytes);
  if (!type || bytes.length > MAX_AVATAR_BYTES) throw Object.assign(new Error("Choose a JPG, PNG or WebP image up to 5 MB."), { status: 400 });
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const secret = process.env.CLOUDINARY_API_SECRET;
  if (!cloud || !apiKey || !secret) throw Object.assign(new Error("Profile picture uploads are not configured."), { status: 503 });
  const folder = process.env.CLOUDINARY_FOLDER?.replace(/^\/+|\/+$/g, "") || "profiles";
  const publicId = `${folder}/avatars/${userId}/${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const transformation = "c_limit,h_512,w_512";
  const signature = createHash("sha1").update(`public_id=${publicId}&timestamp=${timestamp}&transformation=${transformation}${secret}`).digest("hex");
  const body = new FormData();
  body.append("file", new Blob([new Uint8Array(bytes)], { type }), "avatar");
  body.append("public_id", publicId);
  body.append("timestamp", timestamp);
  body.append("transformation", transformation);
  body.append("api_key", apiKey);
  body.append("signature", signature);
  const response = await fetcher(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/upload`, {
    method: "POST", body, signal: AbortSignal.timeout(30_000), redirect: "error",
  });
  if (!response.ok) throw Object.assign(new Error("The image could not be uploaded. Please try again."), { status: 502 });
  const result = await response.json() as { secure_url?: string; resource_type?: string };
  const url = result.secure_url ? new URL(result.secure_url) : null;
  if (!url || url.protocol !== "https:" || url.hostname !== "res.cloudinary.com" || result.resource_type !== "image")
    throw Object.assign(new Error("The image provider returned an invalid upload."), { status: 502 });
  return url.toString();
}
