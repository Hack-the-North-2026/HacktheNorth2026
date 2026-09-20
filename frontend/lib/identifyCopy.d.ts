import type { IdentifyResult, IdentifyStatus } from './types';

export const IDENTIFY_POLL_DEADLINE_MS: number;

export const IDENTIFY_STATUS_COPY: Record<IdentifyStatus, string>;

export const IDENTIFY_STAGE_ORDER: IdentifyStatus[];

export const IDENTIFY_STAGE_PROGRESS: Record<IdentifyStatus, number>;

export const IDENTIFY_STAGE_CEILING: Partial<Record<IdentifyStatus, number>>;

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

export function identifyStageIndex(status: IdentifyStatus): number;

export function identifyProgressFloor(status: IdentifyStatus): number;

export function identifyProgressCeiling(status: IdentifyStatus): number;

export function formatIdentifyLog(message?: string | null): string;

export function timeoutIdentifyCopy(mediaType: IdentifyMediaType): string;

export function isVideoJob(
  result?: Pick<IdentifyResult, 'media_type'> | null,
  previewUri?: string | null,
  previewMediaType?: IdentifyMediaType | null,
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
