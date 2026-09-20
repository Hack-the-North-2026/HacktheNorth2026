export type IdentifyOrigin =
  | 'app'
  | 'android_overlay'
  | 'android_qs'
  | 'share'
  | 'ios_share';

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
  queries?: string[];
  attributes: { color: string; material?: string; pattern?: string; fit?: string };
  brand: string | null;
  brand_cues: string[];
  confidence: number;
  bbox: [number, number, number, number];
  chip_key: string;
  alt_chip_key?: string;
  accessibility_line: string;
  source_frame_index?: number | null;
  crop_fallback?: boolean;
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
  visual_score?: number;
  visual_label?: 'same_item' | 'similar' | 'different';
};

export type IdentifyStatus =
  | 'queued'
  | 'ingesting'
  | 'seeing'
  | 'detailing'
  | 'sourcing'
  | 'judging'
  | 'retrying'
  | 'ranking'
  | 'done'
  | 'error';

export const IDENTIFY_STATUS_COPY: Record<IdentifyStatus, string> = {
  queued: 'Queuing your request…',
  ingesting: 'Preparing media…',
  seeing: 'Looking at the outfit…',
  detailing: 'Reading each garment up close…',
  sourcing: 'Searching shops…',
  judging: 'Comparing product photos to the crop…',
  retrying: 'Searching the open web…',
  ranking: 'Picking the best matches…',
  done: 'Found your fit',
  error: 'Something went wrong',
};

export type IdentifyResult = {
  job_id: string;
  status: IdentifyStatus;
  origin: IdentifyOrigin;
  media_type?: 'image' | 'video';
  thumbnail_url?: string;
  keyframes?: string[];
  outfit_summary?: string;
  items: Array<{
    garment: Garment;
    matches: Match[];
  }>;
  error?: string;
  steps?: Array<{ status: IdentifyStatus; at: string; note?: string }>;
};

export type RecentSearch = {
  job_id: string;
  created_at: string;
  outfit_summary?: string;
  item_count: number;
  categories: string[];
  thumbnail_url?: string;
  preview_title?: string;
};
