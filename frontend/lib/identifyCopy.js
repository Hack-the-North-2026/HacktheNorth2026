export const IDENTIFY_POLL_DEADLINE_MS = 270_000;

export const IDENTIFY_STATUS_COPY = {
  queued: 'Queuing your request…',
  ingesting: 'Preparing media…',
  seeing: 'Looking at the outfit…',
  detailing: 'Reading each garment up close…',
  sourcing: 'Searching shops…',
  judging: 'Comparing product photos to the crop…',
  retrying: 'Refining the match…',
  ranking: 'Picking the best matches…',
  done: 'Found your fit',
  error: 'Something went wrong',
};

const VIDEO_STATUS_COPY = {
  queued: 'Queuing your clip…',
  ingesting: 'Pulling clear frames…',
  seeing: 'Reading the outfit across frames…',
};

export function identifyStatusCopy(status, mediaType = 'image', note) {
  if (status === 'retrying') {
    const detail = String(note || '');
    if (/open web|browser/i.test(detail)) return 'Searching the open web…';
    if (/sharper|query|reformulate/i.test(detail)) return 'Searching with a sharper query…';
  }
  if (mediaType === 'video' && VIDEO_STATUS_COPY[status]) {
    return VIDEO_STATUS_COPY[status];
  }
  return IDENTIFY_STATUS_COPY[status];
}

export function timeoutIdentifyCopy(mediaType) {
  return mediaType === 'video'
    ? 'This clip took too long to identify. Try another clip.'
    : 'This screenshot took too long to identify. Try another screenshot.';
}

export function isVideoJob(result, previewUri) {
  if (result?.media_type === 'video') return true;
  if (!previewUri) return false;
  const clean = previewUri.split('?')[0].toLowerCase();
  return /\.(mp4|mov|webm|m4v|mkv)$/i.test(clean);
}

function stepsMissedSee(result) {
  const steps = result?.steps || [];
  const ingested = steps.some((step) => step.status === 'ingesting');
  const seen = steps.some((step) => step.status === 'seeing');
  return ingested && !seen;
}

export function isIngestEmpty(result) {
  if (!result) return false;
  if (result.empty_reason === 'ingest') return true;
  if (result.empty_reason === 'see') return false;
  const summary = result.outfit_summary || '';
  if (/clear enough/i.test(summary)) return true;
  return stepsMissedSee(result);
}

export function emptyIdentifyCopy(result, previewUri) {
  const video = isVideoJob(result, previewUri);
  if (video && isIngestEmpty(result)) {
    return {
      title: 'No frame in this clip was clear enough',
      subtitle: 'Try another clip with the outfit clearly visible.',
    };
  }
  if (video) {
    return {
      title: "We couldn't see a clear outfit.",
      subtitle: 'Try another clip with the outfit clearly visible.',
    };
  }
  return {
    title: "We couldn't see a clear outfit in this photo.",
    subtitle: 'Try another screenshot with the outfit clearly visible.',
  };
}

export function failedIdentifyCopy(message, result, previewUri) {
  const video = isVideoJob(result, previewUri);
  return {
    title: message,
    subtitle: video
      ? 'Try another clip with the outfit clearly visible.'
      : 'Try another screenshot with the outfit clearly visible.',
  };
}
