import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { listRecentSearches, resolveMediaUrl } from '../lib/api';
import { CATEGORY_LABELS, GarmentCategory, RecentSearch } from '../lib/types';
import {
  BACKGROUND,
  SURFACE,
  SURFACE_MUTED,
  BORDER,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_MUTED,
  ACCENT,
  FONT_MEDIUM,
  FONT_SEMIBOLD,
  FONT_BOLD,
  FONT_SERIF_SEMIBOLD,
  FS_LG,
  FS_MD,
  FS_SM,
} from '../lib/theme';

const H_PAD = 18;
const MAX_CHIPS = 2;

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'Just now';
  if (seconds < 90) return '1 min ago';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 5400) return '1 hr ago';
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hr ago`;
  if (seconds < 172800) return 'Yesterday';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function groupLabel(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'Earlier';
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86_400_000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return 'This week';
  return 'Earlier';
}

function titleCase(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function uniqueCategories(categories: string[]): GarmentCategory[] {
  const seen = new Set<string>();
  const ordered: GarmentCategory[] = [];
  categories.forEach((category) => {
    if (!category || seen.has(category)) return;
    if (!(category in CATEGORY_LABELS)) return;
    seen.add(category);
    ordered.push(category as GarmentCategory);
  });
  return ordered;
}

function lookCopy(search: RecentSearch): { title: string; detail: string } {
  const summary = (search.outfit_summary || '').replace(/\s+/g, ' ').trim();
  const match = summary.match(/^An?\s+(.+?)\s+look(?:[,.]?\s+(?:pairing\s+)?(.+))?$/i);
  if (match?.[1]) {
    const detail = match[2]?.replace(/[.]+$/, '').trim();
    return {
      title: `${titleCase(match[1])} look`,
      detail: detail ? `Pairing ${detail}` : '',
    };
  }
  if (summary) {
    const [first] = summary.split(/(?<=[.!?])\s+/);
    return { title: titleCase(first.replace(/[.!?]$/, '')), detail: '' };
  }
  const labels = uniqueCategories(search.categories || []).map((category) => CATEGORY_LABELS[category]);
  return { title: labels.slice(0, 2).join(' & ') || 'Identified fit', detail: '' };
}

function Thumb({ uri }: { uri: string }) {
  const [failed, setFailed] = useState(false);
  if (!uri || failed) {
    return (
      <View style={styles.thumbFallback}>
        <Ionicons name="shirt-outline" size={26} color={ACCENT} />
      </View>
    );
  }
  return (
    <Image
      source={{ uri }}
      style={styles.thumbImage}
      resizeMode="cover"
      onError={() => setFailed(true)}
    />
  );
}

function SearchCard({ search, onPress }: { search: RecentSearch; onPress: () => void }) {
  const scale = useRef(new Animated.Value(1)).current;
  const { title, detail } = lookCopy(search);
  const categories = uniqueCategories(search.categories || []);
  const extra = Math.max(0, categories.length - MAX_CHIPS);
  const chips = categories.slice(0, MAX_CHIPS);
  const thumb = search.thumbnail_url ? resolveMediaUrl(search.thumbnail_url) : '';
  const when = formatRelativeTime(search.created_at);
  const pieces = search.item_count
    ? `${search.item_count} piece${search.item_count === 1 ? '' : 's'}`
    : '';

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${pieces}${when ? `, ${when}` : ''}`}
        onPress={onPress}
        onPressIn={() => Animated.spring(scale, { toValue: 0.98, useNativeDriver: true, friction: 7 }).start()}
        onPressOut={() => Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 7 }).start()}
        style={styles.card}
      >
        <View style={styles.thumb}>
          <Thumb uri={thumb} />
        </View>

        <View style={styles.details}>
          <Text style={styles.cardTitle} numberOfLines={1}>{title}</Text>
          {detail ? (
            <Text style={styles.cardDetail} numberOfLines={2}>{detail}</Text>
          ) : null}

          {chips.length > 0 ? (
            <View style={styles.chipRow}>
              {chips.map((category) => (
                <View key={category} style={styles.chip}>
                  <Text style={styles.chipText}>{CATEGORY_LABELS[category]}</Text>
                </View>
              ))}
              {extra > 0 ? (
                <View style={styles.chip}>
                  <Text style={styles.chipText}>+{extra}</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          <View style={styles.metaRow}>
            <Text style={styles.meta} numberOfLines={1}>
              {[pieces, when].filter(Boolean).join('  ·  ')}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={TEXT_MUTED} />
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

function SkeletonCard() {
  return (
    <View style={styles.card}>
      <View style={[styles.thumb, styles.skeletonBlock]} />
      <View style={styles.details}>
        <View style={[styles.skeletonLine, { width: '62%' }]} />
        <View style={[styles.skeletonLine, { width: '92%', marginTop: 8 }]} />
        <View style={[styles.skeletonLine, { width: '74%', marginTop: 6 }]} />
        <View style={[styles.chipRow, { marginTop: 12 }]}>
          <View style={[styles.chip, styles.skeletonBlock, { width: 58, height: 22 }]} />
          <View style={[styles.chip, styles.skeletonBlock, { width: 48, height: 22 }]} />
        </View>
      </View>
    </View>
  );
}

export default function RecentSearchesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [searches, setSearches] = useState<RecentSearch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    listRecentSearches()
      .then((next) => {
        if (cancelled) return;
        setSearches(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load recent searches.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useFocusEffect(useCallback(() => load(), [load]));

  const groups = useMemo(() => {
    const next: { label: string; items: RecentSearch[] }[] = [];
    searches.forEach((search) => {
      const label = groupLabel(search.created_at);
      const last = next[next.length - 1];
      if (last?.label === label) last.items.push(search);
      else next.push({ label, items: [search] });
    });
    return next;
  }, [searches]);

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 12) + 6 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="chevron-back" size={20} color={TEXT_PRIMARY} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.eyebrow}>YOUR FITS</Text>
          <Text style={styles.headline} numberOfLines={1}>Recently searched</Text>
        </View>
        {!loading && !error && searches.length > 0 ? (
          <View style={styles.countChip}>
            <Text style={styles.countText}>{searches.length}</Text>
          </View>
        ) : (
          <View style={styles.headerSpacer} />
        )}
      </View>

      {loading ? (
        <ScrollView
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 32 }]}
          showsVerticalScrollIndicator={false}
        >
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </ScrollView>
      ) : error ? (
        <View style={styles.centered}>
          <View style={styles.emptyIcon}>
            <Ionicons name="cloud-offline-outline" size={26} color={ACCENT} />
          </View>
          <Text style={styles.emptyTitle}>{error}</Text>
          <Text style={styles.emptySubtitle}>Check that the backend can reach MongoDB Atlas.</Text>
          <Pressable onPress={load} style={styles.retryButton} accessibilityRole="button">
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : searches.length === 0 ? (
        <View style={styles.centered}>
          <View style={styles.emptyIcon}>
            <Ionicons name="sparkles-outline" size={26} color={ACCENT} />
          </View>
          <Text style={styles.emptyTitle}>No looks yet</Text>
          <Text style={styles.emptySubtitle}>Identify a fit and it’ll show up here.</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 32 }]}
          showsVerticalScrollIndicator={false}
        >
          {groups.map((group) => (
            <View key={group.label} style={styles.section}>
              <Text style={styles.sectionLabel}>{group.label}</Text>
              {group.items.map((search) => (
                <SearchCard
                  key={search.job_id}
                  search={search}
                  onPress={() => router.push(`/job/${search.job_id}`)}
                />
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BACKGROUND,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: H_PAD,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    backgroundColor: BACKGROUND,
  },
  backButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: SURFACE,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: BORDER,
  },
  headerText: {
    flex: 1,
  },
  eyebrow: {
    fontFamily: FONT_BOLD,
    color: ACCENT,
    fontSize: 10.5,
    letterSpacing: 1.4,
    marginBottom: 2,
  },
  headline: {
    fontFamily: FONT_SERIF_SEMIBOLD,
    color: TEXT_PRIMARY,
    fontSize: 19,
    letterSpacing: 0.2,
  },
  headerSpacer: {
    width: 38,
  },
  countChip: {
    minWidth: 38,
    height: 38,
    paddingHorizontal: 10,
    borderRadius: 19,
    backgroundColor: SURFACE,
    borderWidth: 1,
    borderColor: BORDER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: {
    fontFamily: FONT_BOLD,
    color: TEXT_PRIMARY,
    fontSize: FS_MD,
  },
  list: {
    paddingHorizontal: H_PAD,
    paddingTop: 18,
    gap: 12,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  section: {
    gap: 12,
  },
  sectionLabel: {
    fontFamily: FONT_BOLD,
    color: ACCENT,
    fontSize: 10.5,
    letterSpacing: 1.4,
    marginBottom: 2,
    marginLeft: 2,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 14,
    padding: 10,
    borderRadius: 22,
    backgroundColor: SURFACE,
    borderWidth: 1,
    borderColor: BORDER,
    shadowColor: '#3A2A18',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  thumb: {
    width: 96,
    minHeight: 108,
    alignSelf: 'stretch',
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: SURFACE_MUTED,
    position: 'relative',
    borderWidth: 1,
    borderColor: BORDER,
  },
  thumbImage: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
  },
  thumbFallback: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  details: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    paddingVertical: 4,
    paddingRight: 4,
  },
  cardTitle: {
    fontFamily: FONT_SERIF_SEMIBOLD,
    color: TEXT_PRIMARY,
    fontSize: 17,
    letterSpacing: 0.15,
    lineHeight: 22,
  },
  cardDetail: {
    marginTop: 4,
    fontFamily: FONT_MEDIUM,
    color: TEXT_SECONDARY,
    fontSize: FS_SM,
    lineHeight: 17,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: 6,
    marginTop: 8,
    overflow: 'hidden',
  },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: BACKGROUND,
    borderWidth: 1,
    borderColor: BORDER,
  },
  chipText: {
    fontFamily: FONT_SEMIBOLD,
    fontSize: 11,
    color: TEXT_SECONDARY,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    gap: 8,
  },
  meta: {
    flex: 1,
    fontFamily: FONT_MEDIUM,
    color: TEXT_MUTED,
    fontSize: FS_SM,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: SURFACE,
    borderWidth: 1,
    borderColor: BORDER,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  emptyTitle: {
    color: TEXT_PRIMARY,
    fontSize: FS_LG,
    fontFamily: FONT_SERIF_SEMIBOLD,
    textAlign: 'center',
  },
  emptySubtitle: {
    color: TEXT_SECONDARY,
    fontSize: FS_MD,
    fontFamily: FONT_MEDIUM,
    textAlign: 'center',
    lineHeight: 22,
  },
  retryButton: {
    marginTop: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: ACCENT,
  },
  retryText: {
    fontFamily: FONT_BOLD,
    color: '#FBF3E7',
    fontSize: FS_SM,
  },
  skeletonBlock: {
    backgroundColor: SURFACE_MUTED,
  },
  skeletonLine: {
    height: 12,
    borderRadius: 6,
    backgroundColor: SURFACE_MUTED,
  },
});
