type JobPreview = {
  uri: string;
  mediaType: 'image' | 'video';
  mimeType?: string | null;
};

const previews = new Map<string, JobPreview>();

function inferMediaType(uri: string, mimeType?: string | null): 'image' | 'video' {
  if (mimeType?.startsWith('video/')) return 'video';
  const clean = uri.split('?')[0].toLowerCase();
  return /\.(mp4|mov|webm|m4v|mkv)$/i.test(clean) ? 'video' : 'image';
}

export function setJobPreview(
  jobId: string,
  uri: string,
  extra?: { mediaType?: 'image' | 'video'; mimeType?: string | null },
) {
  previews.set(jobId, {
    uri,
    mediaType: extra?.mediaType || inferMediaType(uri, extra?.mimeType),
    mimeType: extra?.mimeType,
  });
}

export function getJobPreview(jobId: string): string | null {
  return previews.get(jobId)?.uri ?? null;
}

export function getJobPreviewRecord(jobId: string): JobPreview | null {
  return previews.get(jobId) ?? null;
}
