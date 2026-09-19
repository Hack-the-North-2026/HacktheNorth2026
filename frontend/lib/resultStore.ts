const previews = new Map<string, string>();

export function setJobPreview(jobId: string, uri: string) {
  previews.set(jobId, uri);
}

export function getJobPreview(jobId: string): string | null {
  return previews.get(jobId) ?? null;
}
