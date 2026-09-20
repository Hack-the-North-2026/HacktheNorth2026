import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Image,
  Pressable,
  Animated,
  Easing,
  FlatList,
  Modal,
  ScrollView,
  Dimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { FitCard } from '../../components/FitCard';
import { IdentifyStatusView } from '../../components/IdentifyStatus';
import { InspectingView } from '../../components/InspectingView';
import { RippleTransition } from '../../components/RippleTransition';
import { getIdentifyJob } from '../../lib/api';
import {
  emptyIdentifyCopy,
  failedIdentifyCopy,
  IDENTIFY_POLL_DEADLINE_MS,
  isVideoJob,
  timeoutIdentifyCopy,
} from '../../lib/identifyCopy';
import { useVideoPlayer, VideoView, isExpoVideoAvailable } from '../../lib/videoCompat';
import { getJobPreviewRecord } from '../../lib/resultStore';
import { Sentry, withIdentifySpan } from '../../lib/sentry';
import { CATEGORY_LABELS, GarmentCategory, IdentifyResult, Match, IdentifyStatus } from '../../lib/types';
import {
  ACCENT_GRADIENT,
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
} from '../../lib/theme';

const POLL_MS = 400;
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const H_PAD = 18;
const GUTTER = 12;
const COLUMN_W = Math.floor((SCREEN_W - H_PAD * 2 - GUTTER) / 2);
const SOURCE_CHIP = 52;

type Card = { key: string; match: Match | null; label: string; category: GarmentCategory };

function RevealOverlay() {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 0,
      duration: 480,
      delay: 40,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [opacity]);

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.reveal, { opacity }]}>
      <LinearGradient colors={ACCENT_GRADIENT} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

function EmptyMatchCard({ label }: { label: string }) {
  return (
    <View style={[styles.emptyCard, { width: COLUMN_W, height: COLUMN_W + 72 }]}>
      <Ionicons name="search-outline" size={26} color={TEXT_MUTED} />
      <Text style={styles.emptyCardTitle}>No listings</Text>
      <Text style={styles.emptyCardSubtitle} numberOfLines={2}>{label}</Text>
    </View>
  );
}

function SourceVideo({ uri, style, playing }: { uri: string; style: object; playing: boolean }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = true;
  });

  useEffect(() => {
    if (playing) {
      player.currentTime = 0;
      player.play();
    } else {
      player.pause();
    }
  }, [player, playing]);

  return <VideoView player={player} style={style} contentFit="cover" nativeControls={false} playsInline />;
}

export default function JobScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, mediaType } = useLocalSearchParams<{ id: string; mediaType?: string }>();
  const paramMediaType = Array.isArray(mediaType) ? mediaType[0] : mediaType;
  const jobId = Array.isArray(id) ? id[0] : id;
  const previewRecord = jobId ? getJobPreviewRecord(jobId) : null;
  const preview = previewRecord?.uri ?? null;
  const [result, setResult] = useState<IdentifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<GarmentCategory | 'all'>('all');
  const [sourceOpen, setSourceOpen] = useState(false);
  const isDeepLinked = !previewRecord;
  const [inspectPhase, setInspectPhase] = useState<'scanning' | 'revealing' | 'done'>(isDeepLinked ? 'scanning' : 'done');
  const didHaptic = useRef(false);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;

    setResult(null);
    setError(null);

    const poll = async () => {
      try {
        await withIdentifySpan(jobId, async () => {
          const lastStatus = { current: null as string | null };
          const started = Date.now();
          while (!cancelled) {
            const job = await getIdentifyJob(jobId);
            if (cancelled) return;
            if (job.status !== lastStatus.current) {
              lastStatus.current = job.status;
              const short = jobId.replace(/-/g, '').slice(0, 8);
              console.log(`return — Job ${short} status: ${job.status}`);
              if (job.status === 'done') {
                const matches = job.items.reduce((n, item) => n + item.matches.length, 0);
                console.log(`return — Job ${short} showing ${job.items.length} clothes, ${matches} shop matches`);
                Sentry.logger.info('identify.return', {
                  job_id: jobId,
                  origin: job.origin || 'app',
                  garment_count: job.items.length,
                  shopify_hits: matches,
                });
              }
              if (job.status === 'error') {
                console.log(`return — Job ${short} failed: ${job.error || 'unknown error'}`);
                Sentry.logger.warn('identify.error', {
                  job_id: jobId,
                  origin: job.origin || 'app',
                  error: job.error || 'unknown error',
                });
              }
            }
            setResult(job);
            if (job.status === 'done' || job.status === 'error') {
              return job;
            }
            if (Date.now() - started > IDENTIFY_POLL_DEADLINE_MS) {
              throw new Error(timeoutIdentifyCopy(job.media_type === 'video' ? 'video' : 'image'));
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          }
        });
      } catch (err: unknown) {
        if (!cancelled) {
          Sentry.captureException(err);
          setError(err instanceof Error ? err.message : 'Could not load this identify job.');
        }
      }
    };

    poll();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    if (!result || didHaptic.current) return;
    if (result.status === 'done' && result.items.length > 0) {
      didHaptic.current = true;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
  }, [result]);

  const isVideo = isVideoJob(result, preview, previewRecord?.mediaType || paramMediaType);
  const keyframes = result?.keyframes?.filter(Boolean) || [];
  const sourceVideoUri = isVideo && preview ? preview : null;
  const sourceImageUri = sourceVideoUri ? null : keyframes[0] || result?.thumbnail_url || preview;
  const hasSource = Boolean(sourceVideoUri || sourceImageUri);
  const failed = Boolean(error) || result?.status === 'error';
  const failCopy = failedIdentifyCopy(
    error || result?.error || 'Something went wrong identifying this fit. Try another screenshot or clip.',
    result,
    preview,
  );
  const emptyCopy = emptyIdentifyCopy(result, preview);
  const loading = !failed && (!result || (result.status !== 'done' && result.status !== 'error'));
  const done = result?.status === 'done';

  const cards: Card[] = useMemo(() => {
    if (!done || !result) return [];
    return result.items.flatMap(({ garment, matches }): Card[] => {
      if (matches.length === 0) {
        return [{
          key: `${garment.id}-empty`,
          match: null,
          label: garment.description,
          category: garment.category,
        }];
      }
      return matches.map((match, matchIndex) => ({
        key: `${garment.id}-${matchIndex}`,
        match,
        label: garment.description,
        category: garment.category,
      }));
    });
  }, [done, result]);

  const categories = useMemo(() => {
    const seen: GarmentCategory[] = [];
    cards.forEach((card) => {
      if (!seen.includes(card.category)) seen.push(card.category);
    });
    return seen;
  }, [cards]);

  const visibleCards = useMemo(
    () => (activeCategory === 'all' ? cards : cards.filter((card) => card.category === activeCategory)),
    [cards, activeCategory],
  );

  const totalCards = cards.length;
  const empty = done && totalCards === 0;

  const headline = failed
    ? 'Couldn’t identify'
    : loading
      ? 'Identifying…'
      : totalCards > 0
        ? `${totalCards} listing${totalCards > 1 ? 's' : ''} found`
        : 'Nothing identified';

  const sourceThumb = (style: object, playing = false) => {
    if (sourceVideoUri) return <SourceVideo uri={sourceVideoUri} style={style} playing={playing} />;
    if (sourceImageUri) return <Image source={{ uri: sourceImageUri }} style={style} resizeMode="cover" />;
    return (
      <View style={[style, styles.sourceFallback]}>
        <Ionicons name={isVideo ? 'videocam' : 'image-outline'} size={20} color={ACCENT} />
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 12) + 6 }]}>
        <Pressable
          style={styles.backButton}
          onPress={() => router.replace('/')}
          accessibilityRole="button"
          accessibilityLabel="Back to capture"
        >
          <Ionicons name="chevron-back" size={20} color={TEXT_PRIMARY} />
        </Pressable>

        <View style={styles.headerText}>
          <Text style={styles.eyebrow}>{loading ? 'SCANNING' : failed ? 'ERROR' : 'IDENTIFIED'}</Text>
          <Text style={styles.headline} numberOfLines={1}>{headline}</Text>
        </View>

        <Pressable
          onPress={() => hasSource && setSourceOpen(true)}
          disabled={!hasSource}
          style={styles.sourceChip}
          accessibilityRole="button"
          accessibilityLabel="View the clip you scanned"
        >
          {sourceThumb(styles.sourceChipMedia)}
          {isVideo ? (
            <View style={styles.sourcePlayDot}>
              <Ionicons name="play" size={9} color="#FBF3E7" />
            </View>
          ) : null}
        </Pressable>
      </View>

      {done && categories.length > 1 && (
        <View style={styles.filterRow}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterContent}
          >
            {(['all', ...categories] as const).map((category) => {
              const active = activeCategory === category;
              const label = category === 'all' ? 'All' : CATEGORY_LABELS[category];
              return (
                <Pressable
                  key={category}
                  onPress={() => setActiveCategory(category)}
                  style={[styles.chip, active && styles.chipActive]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      {loading ? (
        <ScrollView contentContainerStyle={styles.stateContent} showsVerticalScrollIndicator={false}>
          <IdentifyStatusView
            status={result?.status || 'queued'}
            mediaType={isVideo ? 'video' : 'image'}
            note={result?.steps?.[result.steps.length - 1]?.note}
            logs={result?.logs}
          />
        </ScrollView>
      ) : failed || empty ? (
        <ScrollView contentContainerStyle={styles.stateContent} showsVerticalScrollIndicator={false}>
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>{failed ? failCopy.title : emptyCopy.title}</Text>
            <Text style={styles.emptySubtitle}>{failed ? failCopy.subtitle : emptyCopy.subtitle}</Text>
          </View>
        </ScrollView>
      ) : (
        <FlatList
          data={visibleCards}
          keyExtractor={(card) => card.key}
          numColumns={2}
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={[styles.gridContent, { paddingBottom: insets.bottom + 32 }]}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) =>
            item.match ? (
              <FitCard match={item.match} width={COLUMN_W} variant="compact" />
            ) : (
              <EmptyMatchCard label={item.label} />
            )
          }
        />
      )}

      <Modal visible={sourceOpen} animationType="fade" transparent onRequestClose={() => setSourceOpen(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSourceOpen(false)} />
          <View style={styles.modalMedia}>{sourceThumb(styles.modalMediaInner, sourceOpen)}</View>
          <Pressable
            style={[styles.modalClose, { top: Math.max(insets.top, 16) + 6 }]}
            onPress={() => setSourceOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close preview"
          >
            <Ionicons name="close" size={22} color={TEXT_PRIMARY} />
          </Pressable>
        </View>
      </Modal>

      {inspectPhase !== 'done' && (
        <Animated.View style={[StyleSheet.absoluteFill, { zIndex: 100, elevation: 100 }]}>
          <InspectingView
            uri={preview || sourceImageUri || ''}
            isVideo={isVideo}
            status={result?.status || ('queued' as IdentifyStatus)}
            items={result?.items || []}
            keyframes={result?.keyframes || []}
            done={done}
            onFinished={() => setInspectPhase('revealing')}
          />
        </Animated.View>
      )}

      <RippleTransition
        originX={SCREEN_W / 2}
        originY={SCREEN_H / 2}
        active={inspectPhase === 'revealing'}
        onDone={() => setInspectPhase('done')}
      />
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
  sourceChip: {
    width: SOURCE_CHIP,
    height: SOURCE_CHIP,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: SURFACE_MUTED,
    borderWidth: 1,
    borderColor: BORDER,
  },
  sourceChipMedia: {
    width: '100%',
    height: '100%',
  },
  sourceFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourcePlayDot: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(43,32,24,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterRow: {
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  filterContent: {
    paddingHorizontal: H_PAD,
    paddingVertical: 10,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: SURFACE,
    borderWidth: 1,
    borderColor: BORDER,
  },
  chipActive: {
    backgroundColor: ACCENT,
    borderColor: ACCENT,
  },
  chipText: {
    fontFamily: FONT_SEMIBOLD,
    fontSize: FS_SM,
    color: TEXT_SECONDARY,
  },
  chipTextActive: {
    color: '#FBF3E7',
  },
  gridContent: {
    paddingHorizontal: H_PAD,
    paddingTop: 16,
  },
  gridRow: {
    gap: GUTTER,
    marginBottom: GUTTER,
  },
  stateContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: 32,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontFamily: FONT_SEMIBOLD,
    color: TEXT_PRIMARY,
    fontSize: FS_MD,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontFamily: FONT_MEDIUM,
    color: TEXT_SECONDARY,
    fontSize: FS_SM,
    textAlign: 'center',
  },
  emptyCard: {
    borderRadius: 20,
    backgroundColor: SURFACE,
    borderWidth: 1,
    borderColor: BORDER,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 14,
  },
  emptyCardTitle: {
    fontFamily: FONT_BOLD,
    color: TEXT_PRIMARY,
    fontSize: FS_MD,
    marginTop: 4,
  },
  emptyCardSubtitle: {
    fontFamily: FONT_MEDIUM,
    color: TEXT_SECONDARY,
    fontSize: FS_SM,
    textAlign: 'center',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(28,20,14,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalMedia: {
    width: SCREEN_W,
    aspectRatio: 9 / 16,
    maxHeight: '82%',
    borderRadius: 20,
    overflow: 'hidden',
  },
  modalMediaInner: {
    width: '100%',
    height: '100%',
  },
  modalClose: {
    position: 'absolute',
    right: 18,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,253,248,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reveal: {
    zIndex: 10,
  },
});
