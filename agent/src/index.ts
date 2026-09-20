import { getAgentByName } from "agents";
import { IdentifyAgent } from "./identify-agent";
import { cacheKey } from "./matching";
import { isVideoUpload } from "./media";
import type { Env, IdentifyMediaType, IdentifyOrigin, JobState } from "./types";

export { IdentifyAgent };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-device-id, x-job-id, x-request-id",
};

const ORIGINS = new Set(["app", "android_overlay", "android_qs", "share", "ios_share"]);

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS });
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        status: "ok",
        service: "Fit Stealer IdentifyAgent",
        endpoints: ["/api/identify", "/jobs", "/jobs/:id"],
      });
    }

    if (request.method === "POST" && (url.pathname === "/api/identify" || url.pathname === "/jobs")) {
      return startJob(request, env, ctx);
    }

    const frameMatch = url.pathname.match(/^\/jobs\/([^/]+)\/frames\/(\d+)$/);
    if (frameMatch && request.method === "GET") {
      const object = await env.MEDIA.get(`jobs/${frameMatch[1]}/frames/${frameMatch[2]}.jpg`);
      if (!object) return json({ error: "Frame not found." }, 404);
      return new Response(object.body, {
        status: 200,
        headers: {
          ...CORS,
          "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
          "Cache-Control": "no-store",
        },
      });
    }

    const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (jobMatch && request.method === "GET") {
      const agent = await getAgentByName(
        env.IdentifyAgent as unknown as DurableObjectNamespace<IdentifyAgent>,
        jobMatch[1],
      );
      const response = await agent.fetch(new Request("https://identify-agent/state", { method: "GET" }));
      const body = await response.text();
      return new Response(body, { status: response.status, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    return json({ error: "Not found." }, 404);
  },
} satisfies ExportedHandler<Env>;

function asFile(value: unknown): File | null {
  return value instanceof File && value.size > 0 ? value : null;
}

async function startJob(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const form = await request.formData();
  const typeField = String(form.get("type") || "");
  const video = asFile(form.get("video"));
  const image = asFile(form.get("image")) || asFile(form.get("file"));
  const file = video || image;
  if (!file) {
    return json({ error: 'A file is required (multipart field "image" or "video").' }, 400);
  }
  const mediaType: IdentifyMediaType = isVideoUpload(file, typeField) || video ? "video" : "image";

  const originRaw = String(form.get("origin") || "app");
  const origin = (ORIGINS.has(originRaw) ? originRaw : "app") as IdentifyOrigin;
  const bytes = await file.arrayBuffer();
  const imageHash = await sha256Hex(bytes);
  const jobId = crypto.randomUUID();
  const agent = await getAgentByName(
    env.IdentifyAgent as unknown as DurableObjectNamespace<IdentifyAgent>,
    jobId,
  );
  const filename = file.name || (mediaType === "video" ? "clip.mp4" : "screenshot.jpg");
  const contentType = file.type || (mediaType === "video" ? "video/mp4" : "image/jpeg");

  const cachedRaw = await env.MATCH_CACHE.get(cacheKey(imageHash));
  if (cachedRaw) {
    let cached: Partial<JobState> | null = null;
    try {
      cached = JSON.parse(cachedRaw) as Partial<JobState>;
    } catch {
      cached = null;
    }
    if (cached?.items) {
      const hydrated: JobState = {
        job_id: jobId,
        status: "done",
        origin,
        media_type: mediaType,
        outfit_summary: cached.outfit_summary || "",
        items: cached.items,
        steps: cached.steps || [],
        image_hash: imageHash,
        keyframes: cached.keyframes || [],
        thumbnail_url: cached.thumbnail_url,
        empty_reason: cached.empty_reason,
      };
      await agent.fetch(
        new Request("https://identify-agent/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            job_id: jobId,
            origin,
            image_hash: imageHash,
            r2_key: "",
            filename,
            content_type: contentType,
            media_type: mediaType,
            cached: hydrated,
          }),
        }),
      );
      return json({ job_id: jobId, status: "done", media_type: mediaType });
    }
  }

  const r2Key = `jobs/${jobId}/${filename}`;
  await env.MEDIA.put(r2Key, bytes, {
    httpMetadata: { contentType },
  });

  const runRequest = new Request("https://identify-agent/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: jobId,
      origin,
      image_hash: imageHash,
      r2_key: r2Key,
      filename,
      content_type: contentType,
      media_type: mediaType,
    }),
  });
  ctx.waitUntil(agent.fetch(runRequest));
  return json({ job_id: jobId, status: "queued", media_type: mediaType });
}
