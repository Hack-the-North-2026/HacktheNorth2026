export type IdentifyOrigin = 'app' | 'android_overlay' | 'android_qs' | 'share';

export type GarmentCategory =
  | 'jacket'
  | 'shirt'
  | 'pants'
  | 'shorts'
  | 'skirt'
  | 'dress'
  | 'shoes'
  | 'bag'
  | 'hat'
  | 'accessory';

export type Garment = {
  id: string;
  category: GarmentCategory;
  description: string;
  search_query: string;
  attributes: { color: string; material?: string; pattern?: string; fit?: string };
  brand: string | null;
  brand_cues: string[];
  confidence: number;
  bbox: [number, number, number, number];
  chip_key: string;
  accessibility_line: string;
};

export type ProductCandidate = {
  title: string;
  url: string;
  image_url?: string;
  price?: string;
  currency?: string;
  store_name?: string;
  source: 'shopify' | 'browserbase' | 'composio' | 'creator_tag';
  raw_score?: number;
};

export type Match = ProductCandidate & {
  match_type: 'exact' | 'similar';
  confidence: number;
  reason: string;
};

export type IdentifyStatus = 'queued' | 'ingesting' | 'seeing' | 'sourcing' | 'ranking' | 'done' | 'error';

export const IDENTIFY_STATUS_COPY: Record<IdentifyStatus, string> = {
  queued: 'Queuing your screenshot…',
  ingesting: 'Preparing the image…',
  seeing: 'Looking at the outfit…',
  sourcing: 'Searching shops…',
  ranking: 'Picking the best matches…',
  done: 'Found your fit',
  error: 'Something went wrong',
};

export type IdentifyResult = {
  job_id: string;
  status: IdentifyStatus;
  origin: IdentifyOrigin;
  thumbnail_url?: string;
  outfit_summary?: string;
  items: Array<{
    garment: Garment;
    matches: Match[];
  }>;
  error?: string;
};
