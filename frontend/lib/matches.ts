export function preferStrongExact<T extends { match_type: 'exact' | 'similar' }>(matches: T[]): T[] {
  const exact = matches.filter((match) => match.match_type === 'exact');
  if (exact.length) return exact.slice(0, 1);
  return matches.slice(0, 3);
}
