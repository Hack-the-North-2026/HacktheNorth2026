export type IdentifyStatus =
  | "queued"
  | "ingesting"
  | "seeing"
  | "detailing"
  | "sourcing"
  | "judging"
  | "retrying"
  | "ranking"
  | "done"
  | "error";

export type IdentifyOrigin = "app" | "android_overlay" | "android_qs" | "share";

export type JobStep = {
  status: IdentifyStatus;
  at: string;
  note?: string;
};

export type JobState = {
  job_id: string;
  status: IdentifyStatus;
  origin: IdentifyOrigin;
  outfit_summary?: string;
  items: Array<{ garment: Record<string, unknown>; matches: Record<string, unknown>[] }>;
  steps: JobStep[];
  error?: string;
  image_hash?: string;
};

export type RunPayload = {
  job_id: string;
  origin: IdentifyOrigin;
  image_hash: string;
  r2_key: string;
  filename: string;
  content_type: string;
  cached?: JobState;
};

export type Env = {
  IdentifyAgent: DurableObjectNamespace;
  MATCH_CACHE: KVNamespace;
  MEDIA: R2Bucket;
  AI_SERVICE_URL: string;
  TOOL_SERVER_SECRET?: string;
};
