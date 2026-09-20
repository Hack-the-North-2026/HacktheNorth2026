import { getAgentByName } from "agents";
import { IdentifyAgent } from "./identify-agent";
import { cacheKey } from "./matching";
import type { Env, IdentifyOrigin, JobState } from "./types";

export { IdentifyAgent };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-device-id, x-job-id, x-request-id",
};

const ORIGINS = new Set(["app", "android_overlay", "android_qs", "share"]);

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

async function startJob(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const form = await request.formData();
  const image = form.get("image");
  if (!(image instanceof File) || image.size === 0) {
    return json({ error: 'An image file is required (multipart field "image").' }, 400);
  }

  const originRaw = String(form.get("origin") || "app");
  const origin = (ORIGINS.has(originRaw) ? originRaw : "app") as IdentifyOrigin;
  const bytes = await image.arrayBuffer();
  const imageHash = await sha256Hex(bytes);
  const jobId = crypto.randomUUID();
  const agent = await getAgentByName(
    env.IdentifyAgent as unknown as DurableObjectNamespace<IdentifyAgent>,
    jobId,
  );

  const cachedRaw = await env.MATCH_CACHE.get(cacheKey(imageHash));
  if (cachedRaw) {
    let cached: Pick<JobState, "outfit_summary" | "items" | "steps"> | null = null;
    try {
      cached = JSON.parse(cachedRaw) as Pick<JobState, "outfit_summary" | "items" | "steps">;
    } catch {
      cached = null;
    }
    if (cached?.items) {
      const hydrated: JobState = {
        job_id: jobId,
        status: "done",
        origin,
        outfit_summary: cached.outfit_summary || "",
        items: cached.items,
        steps: cached.steps || [],
        image_hash: imageHash,
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
            filename: image.name || "screenshot.jpg",
            content_type: image.type || "image/jpeg",
            cached: hydrated,
          }),
        }),
      );
      return json({ job_id: jobId, status: "done" });
    }
  }

  const r2Key = `jobs/${jobId}/${image.name || "screenshot.jpg"}`;
  await env.MEDIA.put(r2Key, bytes, {
    httpMetadata: { contentType: image.type || "image/jpeg" },
  });

  const runRequest = new Request("https://identify-agent/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: jobId,
      origin,
      image_hash: imageHash,
      r2_key: r2Key,
      filename: image.name || "screenshot.jpg",
      content_type: image.type || "image/jpeg",
    }),
  });
  ctx.waitUntil(agent.fetch(runRequest));
  return json({ job_id: jobId, status: "queued" });
}
