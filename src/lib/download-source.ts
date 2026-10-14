import { isIP } from "node:net";

// Keep server-side downloads on explicitly trusted hosting services. Redirects
// must pass the same rules; arbitrary administrator-entered URLs cannot turn
// the API into a proxy for internal services.
const defaultHosts = ["res.cloudinary.com", "drive.google.com", "drive.usercontent.google.com"];

export function validateDownloadUrl(input: string | URL): URL {
  const url = new URL(input);
  const configured = (process.env.DOWNLOAD_ALLOWED_HOSTS ?? "").split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
  const allowed = [...defaultHosts, ...configured];
  const hostname = url.hostname.toLowerCase();
  if (isIP(hostname.replace(/^\[|\]$/g, "")) || hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") || hostname.endsWith(".internal") ||
    url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
    !(allowed.includes(hostname) || hostname.endsWith(".googleusercontent.com"))) {
    throw new Error("Download host is not allowed. Use a trusted HTTPS file host.");
  }
  return url;
}

export async function fetchDownload(input: string | URL, fetcher: typeof fetch = fetch): Promise<Response> {
  let url = validateDownloadUrl(input);
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error("Too many or invalid download redirects");
      url = validateDownloadUrl(new URL(location, url));
      continue;
    }
    const maxBytes = 512 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new Error("Download exceeds the 512 MB file limit");
    }
    if (!response.body) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw new Error("Download exceeds the 512 MB file limit");
        controller.enqueue(chunk);
      },
    }));
    // Content-Length can describe compressed bytes; fetch returns decoded data.
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(body, { status: response.status, headers });
  }
  throw new Error("Download failed");
}
