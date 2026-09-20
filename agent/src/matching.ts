export const EXACT_VISUAL_THRESHOLD = 0.82;
export const WEAK_VISUAL_THRESHOLD = 0.62;

export function needsBrowse(best: number | null | undefined, candidateCount: number): boolean {
  if (!candidateCount) return true;
  if (best == null || !Number.isFinite(best)) return true;
  return best < WEAK_VISUAL_THRESHOLD;
}

export function shouldEarlyExit(best: number | null | undefined): boolean {
  return Number.isFinite(Number(best)) && Number(best) >= EXACT_VISUAL_THRESHOLD;
}

export function needsReformulate(best: number | null | undefined): boolean {
  if (best == null || !Number.isFinite(Number(best))) return false;
  const score = Number(best);
  return score >= WEAK_VISUAL_THRESHOLD && score < EXACT_VISUAL_THRESHOLD;
}

export function reformulateGarment<T extends { queries?: unknown; search_query?: unknown }>(garment: T): T {
  const queries = [
    ...new Set(
      (Array.isArray(garment?.queries) ? garment.queries : [])
        .map((query) => String(query || "").trim())
        .filter(Boolean),
    ),
  ];
  if (queries.length < 2) return garment;
  const rotated = [...queries.slice(1), queries[0]].slice(0, 3);
  return { ...garment, search_query: rotated[0], queries: rotated };
}

export function mergeBrowse(
  catalog: Array<Record<string, unknown>>,
  browsed: Array<Record<string, unknown>>,
  limit = 16,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const item of [...catalog, ...browsed]) {
    const url = String(item?.url || "").trim();
    if (!url) continue;
    let key = url;
    try {
      const parsed = new URL(url);
      key = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.toLowerCase().replace(/\/$/, "") || url;
    } catch {
      key = url.split("?")[0].toLowerCase();
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  const withImage = out.filter((item) => item.image_url);
  const without = out.filter((item) => !item.image_url);
  return [...withImage, ...without].slice(0, limit);
}

export function preferStrongExact(
  matches: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const list = Array.isArray(matches) ? matches : [];
  const exact = list.filter((match) => match?.match_type === "exact");
  if (exact.length) return exact.slice(0, 1);
  return list.slice(0, 3);
}

export function scrubChipKeys(
  items: Array<{ garment?: Record<string, unknown>; matches?: Record<string, unknown>[] }>,
) {
  return (items || []).map((item) => {
    const garment = item?.garment;
    const chipKey = garment?.chip_key;
    const altKey = garment?.alt_chip_key;
    if (!garment) return item;
    const next = { ...garment };
    let changed = false;
    if (typeof chipKey === "string" && /fit-stealer/i.test(chipKey)) {
      next.chip_key = String(garment.id || "");
      changed = true;
    }
    if (typeof altKey === "string" && /fit-stealer/i.test(altKey)) {
      next.alt_chip_key = "";
      changed = true;
    }
    if (!changed) return item;
    return { ...item, garment: next };
  });
}

export function cacheKey(imageHash: string): string {
  return `sha256:${imageHash}`;
}
