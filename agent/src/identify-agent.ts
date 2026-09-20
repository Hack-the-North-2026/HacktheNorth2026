import { Agent } from "agents";
import {
  cacheKey,
  mergeBrowse,
  needsBrowse,
  needsReformulate,
  preferStrongExact,
  reformulateGarment,
  scrubChipKeys,
  shouldEarlyExit,
  withAltChip,
} from "./matching";
import { bytesToBase64, decodeDataUrl, frameObjectKey } from "./media";
import type { Env, IdentifyMediaType, IdentifyOrigin, IdentifyStatus, JobState, RunPayload } from "./types";

const SEE_TIMEOUT_MS = 60_000;
const INGEST_TIMEOUT_MS = 30_000;
const VIDEO_SEE_TIMEOUT_MS = 90_000;
const VIDEO_COMBINED_TIMEOUT_MS = 90_000;
const CHIP_TIMEOUT_MS = 45_000;
const RETRIEVE_TIMEOUT_MS = 25_000;
const JUDGE_TIMEOUT_MS = 25_000;
const BROWSE_TIMEOUT_MS = 18_000;
const RANK_TIMEOUT_MS = 20_000;

function emptyState(jobId = "", origin: IdentifyOrigin = "app"): JobState {
  return {
    job_id: jobId,
    status: "queued",
    origin,
    items: [],
    steps: [],
  };
}

export class IdentifyAgent extends Agent<Env, JobState> {
  initialState: JobState = emptyState();

  async onRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return Response.json(this.state);
    }
    if (request.method === "POST") {
      const payload = (await request.json()) as RunPayload;
      if (payload.cached) {
        this.setState({
          ...payload.cached,
          job_id: payload.job_id,
          status: "done",
          steps: [
            ...(payload.cached.steps || []),
            { status: "done", at: new Date().toISOString(), note: "KV cache hit" },
          ],
        });
        return Response.json(this.state);
      }
      this.setState({
        ...emptyState(payload.job_id, payload.origin),
        image_hash: payload.image_hash,
        media_type: payload.media_type || "image",
        steps: [{ status: "queued", at: new Date().toISOString(), note: "job accepted" }],
      });
      await this.schedule(0, "runMatchingScheduled", payload);
      return Response.json(this.state);
    }
    return new Response("Method not allowed", { status: 405 });
  }

  async runMatchingScheduled(payload: RunPayload): Promise<void> {
    try {
      await this.runMatching(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Identify failed.";
      this.note("error", "matching agent failed", { error: message });
    }
  }

  private note(status: IdentifyStatus, note: string, extra: Partial<JobState> = {}): void {
    const steps = [...(this.state.steps || []), { status, at: new Date().toISOString(), note }];
    this.setState({ ...this.state, status, steps, ...extra });
  }

  private aiUrl(path: string): string {
    return `${String(this.env.AI_SERVICE_URL || "http://127.0.0.1:8000").replace(/\/$/, "")}${path}`;
  }

  private async aiJson<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const toolKey = String(this.env.TOOL_SERVER_SECRET || "");
    const response = await fetch(this.aiUrl(path), {
      ...init,
      headers: {
        "x-job-id": this.state.job_id,
        ...(toolKey ? { "x-tool-key": toolKey } : {}),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await response.json().catch(() => ({}))) as T & { detail?: unknown; error?: string };
    if (!response.ok) {
      const detail = typeof data?.detail === "string" ? data.detail : data?.error;
      throw new Error(String(detail || `${path} failed (${response.status})`));
    }
    return data;
  }

  private async persistKeyframes(keyframes: string[]): Promise<string[]> {
    const stored: string[] = [];
    for (let index = 0; index < keyframes.length; index += 1) {
      const uri = keyframes[index];
      const decoded = decodeDataUrl(uri);
      if (decoded) {
        await this.env.MEDIA.put(frameObjectKey(this.state.job_id, index), decoded.bytes, {
          httpMetadata: { contentType: decoded.contentType },
        });
        stored.push(`/jobs/${this.state.job_id}/frames/${index}`);
        continue;
      }
      stored.push(uri);
    }
    return stored;
  }

  private async perceiveVideo(payload: RunPayload): Promise<{
    garments: Record<string, unknown>[];
    outfit_summary: string;
    keyframes: string[];
    empty_reason?: "ingest" | "see";
    frame_count: number;
  }> {
    this.note("ingesting", "pulling clear frames");
    const object = await this.env.MEDIA.get(payload.r2_key);
    if (!object) {
      this.note("error", "clip missing from R2", { error: "Upload was lost. Try another clip." });
      throw new Error("clip missing from R2");
    }
    const bytes = await object.arrayBuffer();
    const form = new FormData();
    form.append("video", new Blob([new Uint8Array(bytes)], { type: payload.content_type || "video/mp4" }), payload.filename);

    type Ingested = {
      garments?: Record<string, unknown>[];
      image_paths?: string[];
      frames?: Array<{ path?: string; index?: number; timestamp?: number; sharpness?: number }>;
      keyframes?: string[];
      outfit_summary?: string;
      frame_count?: number;
      selected_frames?: number;
      empty_reason?: "ingest" | "see";
    };

    let ingested: Ingested;
    try {
      ingested = await this.aiJson<Ingested>("/tools/ingest", { method: "POST", body: form }, INGEST_TIMEOUT_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/404/.test(message)) throw error;
      this.note("seeing", "reading the outfit across frames");
      const combined = await this.aiJson<Ingested>(
        "/api/identify-video?detail=0",
        { method: "POST", body: form },
        VIDEO_COMBINED_TIMEOUT_MS,
      );
      const keyframes = await this.persistKeyframes(Array.isArray(combined.keyframes) ? combined.keyframes : []);
      const emptyReason =
        combined.empty_reason === "ingest" || combined.empty_reason === "see"
          ? combined.empty_reason
          : undefined;
      return {
        garments: Array.isArray(combined.garments) ? combined.garments : [],
        outfit_summary: combined.outfit_summary || "",
        keyframes,
        empty_reason: emptyReason,
        frame_count: Number(combined.frame_count || keyframes.length || 0),
      };
    }

    const keyframes = await this.persistKeyframes(Array.isArray(ingested.keyframes) ? ingested.keyframes : []);
    const imagePaths = Array.isArray(ingested.image_paths) ? ingested.image_paths : [];
    this.setState({
      ...this.state,
      keyframes,
      thumbnail_url: keyframes[0],
      frame_count: Number(ingested.frame_count || 0),
      selected_frames: Number(ingested.selected_frames || imagePaths.length || 0),
    });
    if (!imagePaths.length) {
      return {
        garments: [],
        outfit_summary: ingested.outfit_summary || "Couldn't find a clear enough view of the outfit in this clip.",
        keyframes,
        empty_reason: "ingest",
        frame_count: Number(ingested.frame_count || 0),
      };
    }

    this.note("seeing", "reading the outfit across frames", { keyframes, thumbnail_url: keyframes[0] });
    const frames = Array.isArray(ingested.frames) ? ingested.frames : [];
    const frameMetadata = frames.length
      ? frames.map((frame, index) => ({
          index: frame?.index ?? index,
          timestamp: frame?.timestamp ?? 0,
          sharpness: frame?.sharpness ?? 0,
        }))
      : imagePaths.map((_path, index) => ({ index, timestamp: 0, sharpness: 0 }));
    const uploadedFrames = [];
    for (let index = 0; index < keyframes.length; index += 1) {
      const object = await this.env.MEDIA.get(frameObjectKey(this.state.job_id, index));
      if (!object) continue;
      const bytes = new Uint8Array(await object.arrayBuffer());
      uploadedFrames.push({
        data: bytesToBase64(bytes),
        index: frameMetadata[index]?.index ?? index,
        timestamp: frameMetadata[index]?.timestamp ?? 0,
        sharpness: frameMetadata[index]?.sharpness ?? 0,
      });
    }
    const seen = await this.aiJson<{ garments?: Record<string, unknown>[]; outfit_summary?: string }>(
      "/tools/see",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_paths: imagePaths,
          frame_metadata: frameMetadata,
          frames: uploadedFrames,
        }),
      },
      VIDEO_SEE_TIMEOUT_MS,
    );
    return {
      garments: Array.isArray(seen.garments) ? seen.garments : [],
      outfit_summary: seen.outfit_summary || "",
      keyframes,
      frame_count: Number(ingested.frame_count || imagePaths.length),
    };
  }

  private async runMatching(payload: RunPayload): Promise<void> {
    const mediaType: IdentifyMediaType =
      payload.media_type || (payload.content_type?.startsWith("video/") ? "video" : "image");
    let garments: Record<string, unknown>[] = [];
    let outfitSummary = "";
    let keyframes: string[] = [];
    let emptyReason: "ingest" | "see" | undefined;

    if (mediaType === "video") {
      const perceived = await this.perceiveVideo(payload);
      garments = perceived.garments;
      outfitSummary = perceived.outfit_summary;
      keyframes = perceived.keyframes;
      emptyReason = perceived.empty_reason;
    } else {
      this.note("ingesting", "loading screenshot from R2");
      const object = await this.env.MEDIA.get(payload.r2_key);
      if (!object) {
        this.note("error", "screenshot missing from R2", { error: "Upload was lost. Try another screenshot." });
        return;
      }
      const bytes = await object.arrayBuffer();
      const form = new FormData();
      form.append("image", new Blob([new Uint8Array(bytes)], { type: payload.content_type }), payload.filename);

      this.note("seeing", "looking at the outfit");
      const seen = await this.aiJson<{ garments?: Record<string, unknown>[]; outfit_summary?: string }>(
        "/api/identify?detail=0",
        { method: "POST", body: form },
        SEE_TIMEOUT_MS,
      );
      garments = Array.isArray(seen.garments) ? seen.garments : [];
      outfitSummary = seen.outfit_summary || "";
    }

    this.setState({
      ...this.state,
      media_type: mediaType,
      outfit_summary: outfitSummary,
      keyframes,
      thumbnail_url: keyframes[0] || this.state.thumbnail_url,
      items: garments.map((garment) => ({ garment, matches: [] })),
    });

    this.note("detailing", "reading each garment up close");
    if (garments.length) {
      const detailed = await this.aiJson<{ garments?: Record<string, unknown>[] }>(
        "/tools/see-chip",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ garments }),
        },
        CHIP_TIMEOUT_MS,
      );
      garments = Array.isArray(detailed.garments) ? detailed.garments : garments;
    }

    if (!garments.length) {
      const reason = emptyReason || (mediaType === "video" ? "see" : undefined);
      this.note("done", reason === "ingest" ? "no usable frames" : "no clothes found", {
        items: [],
        outfit_summary: outfitSummary,
        keyframes,
        thumbnail_url: keyframes[0],
        empty_reason: reason,
      });
      return;
    }

    this.note("sourcing", "searching catalogs", {
      outfit_summary: outfitSummary,
      items: garments.map((garment) => ({ garment, matches: [] })),
    });
    const retrieved = await Promise.all(
      garments.map(async (garment) => {
        const data = await this.aiJson<{ candidates?: Record<string, unknown>[] }>(
          "/tools/retrieve",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ garment }),
          },
          RETRIEVE_TIMEOUT_MS,
        );
        return { garment, candidates: Array.isArray(data.candidates) ? data.candidates : [] };
      }),
    );

    this.note("judging", "comparing product photos to the crop");
    const judged = await Promise.all(
      retrieved.map(async (item) => {
        const data = await this.aiJson<{ visual_scores?: Record<string, unknown>[]; best?: number | null }>(
          "/tools/judge",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ garment: item.garment, candidates: item.candidates }),
          },
          JUDGE_TIMEOUT_MS,
        );
        return {
          ...item,
          visual_scores: Array.isArray(data.visual_scores) ? data.visual_scores : [],
          best: typeof data.best === "number" ? data.best : null,
        };
      }),
    );

    const mid = judged.filter((item) => needsReformulate(item.best));
    if (mid.length) {
      this.note("retrying", "searching with a sharper query");
      await Promise.all(
        mid.map(async (item) => {
          const data = await this.aiJson<{ candidates?: Record<string, unknown>[] }>(
            "/tools/retrieve",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ garment: reformulateGarment(item.garment) }),
            },
            RETRIEVE_TIMEOUT_MS,
          );
          const extra = Array.isArray(data.candidates) ? data.candidates : [];
          if (!extra.length && !item.garment?.alt_chip_key) return;
          item.candidates = extra.length ? mergeBrowse(item.candidates, extra) : item.candidates;
          const judgeGarment = item.garment?.alt_chip_key ? withAltChip(item.garment) : item.garment;
          const again = await this.aiJson<{ visual_scores?: Record<string, unknown>[]; best?: number | null }>(
            "/tools/judge",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ garment: judgeGarment, candidates: item.candidates }),
            },
            JUDGE_TIMEOUT_MS,
          );
          item.visual_scores = Array.isArray(again.visual_scores) ? again.visual_scores : [];
          item.best = typeof again.best === "number" ? again.best : item.best;
        }),
      );
    }

    const weak = judged.filter((item) => !shouldEarlyExit(item.best) && needsBrowse(item.best, item.candidates.length));
    if (weak.length) {
      this.note("retrying", "searching the open web");
      await Promise.all(
        weak.map(async (item) => {
          const browseGarment = item.garment?.alt_chip_key ? withAltChip(item.garment) : item.garment;
          const browsed = await this.aiJson<{ candidates?: Record<string, unknown>[] }>(
            "/tools/browse",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ garment: browseGarment }),
            },
            BROWSE_TIMEOUT_MS,
          );
          const listings = Array.isArray(browsed.candidates) ? browsed.candidates : [];
          if (!listings.length) return;
          item.candidates = mergeBrowse(item.candidates, listings);
          const again = await this.aiJson<{ visual_scores?: Record<string, unknown>[]; best?: number | null }>(
            "/tools/judge",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ garment: browseGarment, candidates: item.candidates }),
            },
            JUDGE_TIMEOUT_MS,
          );
          item.visual_scores = Array.isArray(again.visual_scores) ? again.visual_scores : [];
          item.best = typeof again.best === "number" ? again.best : item.best;
        }),
      );
    }

    this.note("ranking", "picking the best matches");
    const items = await Promise.all(
      judged.map(async (item) => {
        const ranked = await this.aiJson<{ matches?: Record<string, unknown>[] }>(
          "/tools/rank",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              garment: item.garment,
              candidates: item.candidates,
              visual_scores: item.visual_scores,
            }),
          },
          RANK_TIMEOUT_MS,
        );
        return {
          garment: item.garment,
          matches: preferStrongExact(Array.isArray(ranked.matches) ? ranked.matches : []),
        };
      }),
    );

    this.note("done", "identify complete", {
      items: scrubChipKeys(items) as JobState["items"],
      outfit_summary: outfitSummary,
      keyframes,
      thumbnail_url: keyframes[0] || this.state.thumbnail_url,
    });
    await this.persistCache(payload.image_hash);
  }

  private async persistCache(imageHash: string): Promise<void> {
    if (!imageHash || this.state.status !== "done") return;
    if (!this.state.items?.length) return;
    const payload = {
      outfit_summary: this.state.outfit_summary || "",
      items: this.state.items,
      steps: this.state.steps,
      media_type: this.state.media_type,
      keyframes: [],
      thumbnail_url: undefined,
      empty_reason: this.state.empty_reason,
    };
    await this.env.MATCH_CACHE.put(cacheKey(imageHash), JSON.stringify(payload), {
      expirationTtl: 60 * 60 * 24,
    });
  }
}
