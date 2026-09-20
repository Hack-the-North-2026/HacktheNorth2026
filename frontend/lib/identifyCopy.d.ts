import type { IdentifyResult, IdentifyStatus } from './types';

export const IDENTIFY_POLL_DEADLINE_MS: number;

export const IDENTIFY_STATUS_COPY: Record<IdentifyStatus, string>;

export type IdentifyMediaType = 'image' | 'video';

export type IdentifyCopy = {
  title: string;
  subtitle: string;
};

export function identifyStatusCopy(
  status: IdentifyStatus,
  mediaType?: IdentifyMediaType,
  note?: string,
): string;

export function timeoutIdentifyCopy(mediaType: IdentifyMediaType): string;

export function isVideoJob(
  result?: Pick<IdentifyResult, 'media_type'> | null,
  previewUri?: string | null,
): boolean;

export function isIngestEmpty(result?: IdentifyResult | null): boolean;

export function emptyIdentifyCopy(
  result?: IdentifyResult | null,
  previewUri?: string | null,
): IdentifyCopy;

export function failedIdentifyCopy(
  message: string,
  result?: IdentifyResult | null,
  previewUri?: string | null,
): IdentifyCopy;
