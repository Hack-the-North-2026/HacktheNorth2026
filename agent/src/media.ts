const VIDEO_MIME = /^video\/(mp4|quicktime|webm|x-m4v|x-matroska)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv)$/i;

export function isVideoUpload(file: File | null | undefined, typeField = ""): boolean {
  if (typeField === "video") return true;
  if (!file) return false;
  if (file.type && VIDEO_MIME.test(file.type)) return true;
  if (file.name && VIDEO_EXT.test(file.name)) return true;
  return false;
}

export function frameObjectKey(jobId: string, index: number): string {
  return `jobs/${jobId}/frames/${index}.jpg`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; contentType: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(String(dataUrl || "").trim());
  if (!match) return null;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { bytes, contentType: match[1] || "image/jpeg" };
  } catch {
    return null;
  }
}
