import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
} from "./objectAcl.js";

interface StoredObject {
  url: string;
  contentType?: string;
  size?: number;
  isPublic?: boolean;
}

function getCloudinaryCloudName(): string {
  return process.env.CLOUDINARY_CLOUD_NAME || "";
}

function buildCloudinaryUrl(pathOrUrl: string): string {
  if (!pathOrUrl) {
    return "";
  }

  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }

  const cloudName = getCloudinaryCloudName();
  const normalizedPath = pathOrUrl.replace(/^\/+/, "");
  if (!cloudName) {
    return normalizedPath;
  }

  return `https://res.cloudinary.com/${cloudName}/${normalizedPath}`;
}

function buildObjectUrl(objectPath: string): string {
  const normalizedPath = objectPath.replace(/^\/+/, "");
  const objectId = normalizedPath.startsWith("objects/")
    ? normalizedPath.slice("objects/".length)
    : normalizedPath;
  return buildCloudinaryUrl(`image/upload/${objectId}`);
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    return Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
  }

  getPrivateObjectDir(): string {
    return process.env.CLOUDINARY_FOLDER || process.env.PRIVATE_OBJECT_DIR || "";
  }

  async searchPublicObject(filePath: string): Promise<StoredObject | null> {
    const searchPaths = this.getPublicObjectSearchPaths();
    const candidates = searchPaths.length > 0
      ? searchPaths.map((searchPath) => (searchPath ? `${searchPath}/${filePath}` : filePath))
      : [filePath];

    for (const candidate of candidates) {
      return {
        url: buildObjectUrl(candidate),
        isPublic: true,
      };
    }

    return null;
  }

  async downloadObject(object: StoredObject, cacheTtlSec: number = 3600): Promise<Response> {
    const response = await fetch(object.url);
    const headers = new Headers(response.headers);
    headers.set(
      "Cache-Control",
      `${object.isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`
    );
    return new Response(response.body, { status: response.status, headers });
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const cloudName = getCloudinaryCloudName();
    if (!cloudName) {
      throw new Error("CLOUDINARY_CLOUD_NAME not set");
    }

    const privateObjectDir = this.getPrivateObjectDir();
    const objectId = randomUUID();
    const folder = privateObjectDir ? `folder=${encodeURIComponent(privateObjectDir)}` : "";
    const publicId = privateObjectDir
      ? `public_id=${encodeURIComponent(`${privateObjectDir}/uploads/${objectId}`)}`
      : `public_id=${encodeURIComponent(`uploads/${objectId}`)}`;
    const params = [folder, publicId].filter(Boolean).join("&");

    return `https://api.cloudinary.com/v1_1/${cloudName}/upload${params ? `?${params}` : ""}`;
  }

  async getObjectEntityFile(objectPath: string): Promise<StoredObject> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const entityId = objectPath.slice("/objects/".length);
    if (!entityId) {
      throw new ObjectNotFoundError();
    }

    const objectEntityPath = this.getPrivateObjectDir()
      ? `${this.getPrivateObjectDir()}/${entityId}`
      : entityId;

    return {
      url: buildObjectUrl(objectEntityPath),
      isPublic: false,
    };
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith("http://") && !rawPath.startsWith("https://")) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname.replace(/^\/+/, "");
    const parts = rawObjectPath.split("/");
    const uploadIndex = parts.indexOf("upload");

    if (uploadIndex === -1) {
      return rawPath;
    }

    const candidateParts = [...parts.slice(uploadIndex + 1)];
    const withoutVersion = candidateParts[0]?.startsWith("v") && /^v\d+/.test(candidateParts[0])
      ? candidateParts.slice(1)
      : candidateParts;

    const normalizedObjectPath = withoutVersion.join("/");
    return normalizedObjectPath ? `/objects/${normalizedObjectPath}` : rawPath;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    await canAccessObject({
      userId: aclPolicy.owner,
      objectFile: { name: normalizedPath },
      requestedPermission: ObjectPermission.READ,
    });
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: StoredObject;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}
