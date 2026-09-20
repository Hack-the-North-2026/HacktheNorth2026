import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
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
import { listRecentSearches } from '../lib/api';
import { RecentSearch } from '../lib/types';
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
  FONT_EXTRABOLD,
} from '../lib/theme';

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
  return new Date(iso).toLocaleDateString();
}

function subtitleFor(search: RecentSearch): string {
  const pieces = [];
  if (search.item_count) {
    pieces.push(`${search.item_count} piece${search.item_count === 1 ? '' : 's'}`);
  }
  const relative = formatRelativeTime(search.created_at);
  if (relative) pieces.push(relative);
  return pieces.join(' · ');
}

export default function RecentSearchesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [searches, setSearches] = useState<RecentSearch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
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
    }, []),
  );

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 16) + 8 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="chevron-back" size={22} color={TEXT_PRIMARY} />
        </Pressable>
        <Text style={styles.title}>Recently searched</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={ACCENT} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>{error}</Text>
          <Text style={styles.emptySubtitle}>Check that the backend can reach MongoDB Atlas.</Text>
        </View>
      ) : searches.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>No searches yet</Text>
          <Text style={styles.emptySubtitle}>Identify a fit and it’ll show up here.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {searches.map((search) => (
            <Pressable
              key={search.job_id}
              accessibilityRole="button"
              onPress={() => router.push(`/job/${search.job_id}`)}
              style={styles.row}
            >
              {search.thumbnail_url ? (
                <Image source={{ uri: search.thumbnail_url }} style={styles.thumb} />
              ) : (
                <View style={[styles.thumb, styles.thumbFallback]}>
                  <Ionicons name="shirt-outline" size={22} color={ACCENT} />
                </View>
              )}
              <View style={styles.details}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {search.preview_title || search.outfit_summary || 'Identified fit'}
                </Text>
                {search.outfit_summary && search.outfit_summary !== search.preview_title ? (
                  <Text style={styles.rowSummary} numberOfLines={1}>{search.outfit_summary}</Text>
                ) : null}
                <Text style={styles.rowMeta}>{subtitleFor(search)}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={TEXT_MUTED} />
            </Pressable>
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
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: SURFACE,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: BORDER,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: TEXT_PRIMARY,
    fontSize: 18,
    fontFamily: FONT_EXTRABOLD,
  },
  headerSpacer: {
    width: 40,
  },
  list: {
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 12,
    backgroundColor: SURFACE_MUTED,
  },
  thumbFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  details: {
    flex: 1,
    marginLeft: 14,
    marginRight: 10,
    gap: 3,
  },
  rowTitle: {
    color: TEXT_PRIMARY,
    fontSize: 15.5,
    fontFamily: FONT_BOLD,
  },
  rowSummary: {
    color: TEXT_SECONDARY,
    fontSize: 13,
    fontFamily: FONT_MEDIUM,
  },
  rowMeta: {
    color: TEXT_MUTED,
    fontSize: 12,
    fontFamily: FONT_MEDIUM,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: {
    color: TEXT_PRIMARY,
    fontSize: 16,
    fontFamily: FONT_SEMIBOLD,
    textAlign: 'center',
  },
  emptySubtitle: {
    color: TEXT_SECONDARY,
    fontSize: 14,
    fontFamily: FONT_MEDIUM,
    textAlign: 'center',
  },
});
