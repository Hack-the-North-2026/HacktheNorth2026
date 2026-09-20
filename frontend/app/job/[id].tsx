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
  ScrollView,
  Dimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { FitCard } from '../../components/FitCard';
import { IdentifyStatusView } from '../../components/IdentifyStatus';
import { getIdentifyJob } from '../../lib/api';
import {
  emptyIdentifyCopy,
  failedIdentifyCopy,
  IDENTIFY_POLL_DEADLINE_MS,
  isVideoJob,
  timeoutIdentifyCopy,
} from '../../lib/identifyCopy';
import { getJobPreview } from '../../lib/resultStore';
import { Sentry, withIdentifySpan } from '../../lib/sentry';
import { CATEGORY_LABELS, GarmentCategory, IdentifyResult, Match } from '../../lib/types';
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
const POLL_DEADLINE_MS = 90_000;
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const HERO_HEIGHT = Math.round(SCREEN_H * 0.54);
const CARD_WIDTH = Math.min(SCREEN_W * 0.76, 340);
const CARD_HEIGHT = CARD_WIDTH * 1.32;
const CARD_GAP = 16;

type Card = { key: string; match: Match | null; label: string };
type Section = { category: GarmentCategory; title: string; cards: Card[] };

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
    <View style={[styles.emptyCard, { width: CARD_WIDTH, height: CARD_HEIGHT }]}>
      <Ionicons name="search-outline" size={34} color={TEXT_MUTED} />
      <Text style={styles.emptyCardTitle}>No listings found</Text>
      <Text style={styles.emptyCardSubtitle}>{label}</Text>
    </View>
  );
}

export default function JobScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = Array.isArray(id) ? id[0] : id;
  const preview = jobId ? getJobPreview(jobId) : null;
  const [result, setResult] = useState<IdentifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heroIndex, setHeroIndex] = useState(0);
  const didHaptic = useRef(false);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;

    setResult(null);
    setError(null);
    setHeroIndex(0);

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

  const isVideo = isVideoJob(result, preview);
  const keyframes = result?.keyframes?.filter(Boolean) || [];
  const selectedFrame = keyframes[Math.min(heroIndex, Math.max(keyframes.length - 1, 0))];
  const heroUri = selectedFrame || result?.thumbnail_url || (isVideo ? null : preview);
  const heroBranch = heroUri ? 'image' : isVideo ? 'video-placeholder' : 'empty';
  const failed = Boolean(error) || result?.status === 'error';
  const failCopy = failedIdentifyCopy(
    error || result?.error || 'Something went wrong identifying this fit. Try another screenshot or clip.',
    result,
    preview,
  );
  const emptyCopy = emptyIdentifyCopy(result, preview);
  const loading = !failed && (!result || (result.status !== 'done' && result.status !== 'error'));
  const done = result?.status === 'done';

  const sections: Section[] = useMemo(() => {
    if (!done || !result) return [];
    const order: GarmentCategory[] = [];
    const byCategory = new Map<GarmentCategory, Card[]>();

    result.items.forEach(({ garment, matches }) => {
      if (!byCategory.has(garment.category)) {
        byCategory.set(garment.category, []);
        order.push(garment.category);
      }
      const bucket = byCategory.get(garment.category)!;
      if (matches.length === 0) {
        bucket.push({ key: `${garment.id}-empty`, match: null, label: garment.description });
        return;
      }
      matches.forEach((match, matchIndex) => {
        bucket.push({ key: `${garment.id}-${matchIndex}`, match, label: garment.description });
      });
    });

    return order.map((category) => ({
      category,
      title: CATEGORY_LABELS[category],
      cards: byCategory.get(category) || [],
    }));
  }, [done, result]);

  const totalCards = sections.reduce((n, section) => n + section.cards.length, 0);
  const empty = done && totalCards === 0;

  // #region agent log
  fetch('http://127.0.0.1:7786/ingest/14f230d3-70c9-4ad3-a18f-383a84fda265',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'a21ccc'},body:JSON.stringify({sessionId:'a21ccc',runId:'pre-fix',hypothesisId:'A',location:'job/[id].tsx:hero',message:'job hero source selection',data:{jobId,isVideo,heroBranch,hasPreview:Boolean(preview),previewScheme:preview?preview.slice(0,32):null,previewLooksLikeVideo:preview?/\.(mp4|mov|webm|m4v|mkv)$/i.test(preview.split('?')[0]):false,heroScheme:heroUri?heroUri.slice(0,48):null,heroLen:heroUri?heroUri.length:0,thumbnailScheme:result?.thumbnail_url?String(result.thumbnail_url).slice(0,48):null,keyframeCount:keyframes.length,mediaType:result?.media_type||null,status:result?.status||null,loading,done},timestamp:Date.now()})}).catch(()=>{});
  if (done && result) {
    fetch('http://127.0.0.1:7786/ingest/14f230d3-70c9-4ad3-a18f-383a84fda265',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'b5ee46'},body:JSON.stringify({sessionId:'b5ee46',runId:'post-fix',hypothesisId:'A',location:'job/[id].tsx:render',message:'job screen stray-text sources',data:{jobId,itemCount:result.items.length,sectionTitles:sections.map((s)=>s.title),hasOutfitSummary:Boolean(result.outfit_summary),willRenderDuplicateItemBlock:false,willRenderSummary:false,willRenderAccessLines:false},timestamp:Date.now()})}).catch(()=>{});
  }
  // #endregion

  const headline = failed
    ? 'Couldn’t identify'
    : loading
      ? 'Identifying…'
      : totalCards > 0
        ? `${totalCards} listing${totalCards > 1 ? 's' : ''} found`
        : 'Nothing identified';

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.pageScroll}
        contentContainerStyle={styles.pageContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.heroWrap}>
          {heroUri ? (
            <Image
              source={{ uri: heroUri }}
              style={styles.thumbnail}
              resizeMode="cover"
              onLoad={() => {
                // #region agent log
                fetch('http://127.0.0.1:7786/ingest/14f230d3-70c9-4ad3-a18f-383a84fda265',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'a21ccc'},body:JSON.stringify({sessionId:'a21ccc',runId:'pre-fix',hypothesisId:'B',location:'job/[id].tsx:heroImage.onLoad',message:'hero image loaded',data:{jobId,heroScheme:heroUri.slice(0,48),isVideo},timestamp:Date.now()})}).catch(()=>{});
                // #endregion
              }}
              onError={() => {
                // #region agent log
                fetch('http://127.0.0.1:7786/ingest/14f230d3-70c9-4ad3-a18f-383a84fda265',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'a21ccc'},body:JSON.stringify({sessionId:'a21ccc',runId:'pre-fix',hypothesisId:'B',location:'job/[id].tsx:heroImage.onError',message:'hero image failed',data:{jobId,heroScheme:heroUri.slice(0,48),isVideo},timestamp:Date.now()})}).catch(()=>{});
                // #endregion
              }}
            />
          ) : isVideo ? (
            <View style={[styles.thumbnail, styles.videoHeroCenter]}>
              <Ionicons name="videocam" size={44} color={ACCENT} />
              <Text style={styles.videoHeroBadge}>VIDEO CLIP</Text>
            </View>
          ) : (
            <View style={styles.thumbnail} />
          )}
          <LinearGradient colors={['rgba(43,32,24,0.28)', 'transparent']} style={styles.heroTopScrim} />
          <LinearGradient colors={['transparent', 'rgba(247,240,228,0.9)', BACKGROUND]} style={styles.heroBottomScrim} />
          <View style={styles.heroText}>
            <Text style={styles.eyebrow}>{loading ? 'SCANNING' : failed ? 'ERROR' : 'IDENTIFIED'}</Text>
            <Text style={styles.headline}>{headline}</Text>
          </View>
        </View>

        {loading && (
          <View style={styles.loadingWrap}>
            <IdentifyStatusView status={result?.status || 'queued'} />
          </View>
        )}

        {keyframes.length > 1 ? (
          <View style={styles.frameStrip}>
            <Text style={styles.frameStripLabel}>FRAMES WE USED</Text>
            <ScrollView
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.frameStripRow}
            >
              {keyframes.map((uri, index) => (
                <Pressable
                  key={`${uri}-${index}`}
                  onPress={() => setHeroIndex(index)}
                  accessibilityRole="button"
                  accessibilityLabel={`Frame ${index + 1} of ${keyframes.length}`}
                >
                  <Image
                    source={{ uri }}
                    style={[styles.frameThumb, index === heroIndex && styles.frameThumbActive]}
                  />
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {loading && (
          <IdentifyStatusView
            status={result?.status || 'queued'}
            mediaType={isVideo ? 'video' : 'image'}
            note={result?.steps?.[result.steps.length - 1]?.note}
          />
        )}

        {failed && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>{failCopy.title}</Text>
            <Text style={styles.emptySubtitle}>{failCopy.subtitle}</Text>
          </View>
        )}

        {empty && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>{emptyCopy.title}</Text>
            <Text style={styles.emptySubtitle}>{emptyCopy.subtitle}</Text>
          </View>
        )}

        {done && sections.length > 0 && (
          <View style={styles.sectionsContent}>
            {sections.map((section) => (
              <View key={section.category} style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>{section.title}</Text>
                  <Text style={styles.sectionCount}>
                    {section.cards.length} {section.cards.length === 1 ? 'listing' : 'listings'}
                  </Text>
                </View>
                <FlatList
                  data={section.cards}
                  keyExtractor={(card) => card.key}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  snapToInterval={CARD_WIDTH + CARD_GAP}
                  decelerationRate="fast"
                  contentContainerStyle={styles.sectionList}
                  ItemSeparatorComponent={() => <View style={{ width: CARD_GAP }} />}
                  renderItem={({ item }) =>
                    item.match ? (
                      <FitCard match={item.match} width={CARD_WIDTH} height={CARD_HEIGHT} />
                    ) : (
                      <EmptyMatchCard label={item.label} />
                    )
                  }
                />
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      <Pressable style={styles.backButton} onPress={() => router.replace('/')}>
        <Ionicons name="chevron-back" size={22} color={TEXT_PRIMARY} />
      </Pressable>

      <RevealOverlay />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BACKGROUND,
  },
  heroWrap: {
    width: '100%',
    height: HERO_HEIGHT,
    backgroundColor: SURFACE_MUTED,
  },
  thumbnail: {
    width: '100%',
    height: '100%',
  },
  videoHeroCenter: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoHeroBadge: {
    marginTop: 10,
    fontFamily: FONT_BOLD,
    fontSize: FS_SM,
    letterSpacing: 1.5,
    color: ACCENT,
  },
  frameStrip: {
    paddingTop: 12,
    paddingBottom: 4,
    gap: 8,
  },
  frameStripLabel: {
    marginHorizontal: 24,
    color: '#9C9CFF',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.4,
  },
  frameStripRow: {
    paddingHorizontal: 24,
    gap: 8,
  },
  frameThumb: {
    width: 56,
    height: 72,
    borderRadius: 10,
    backgroundColor: '#12121A',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  frameThumbActive: {
    borderColor: '#C4B5FD',
    borderWidth: 2,
  },
  heroTopScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 140,
  },
  heroBottomScrim: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 140,
  },
  heroText: {
    position: 'absolute',
    bottom: 20,
    left: 24,
    right: 24,
  },
  backButton: {
    position: 'absolute',
    top: 56,
    left: 20,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,253,248,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: BORDER,
  },
  eyebrow: {
    fontFamily: FONT_BOLD,
    color: ACCENT,
    fontSize: FS_SM,
    letterSpacing: 1.4,
    marginBottom: 6,
  },
  headline: {
    fontFamily: FONT_SERIF_SEMIBOLD,
    color: TEXT_PRIMARY,
    fontSize: FS_LG,
    letterSpacing: 0.2,
  },
  loadingWrap: {
    paddingTop: 32,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 32,
    paddingTop: 48,
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
  pageScroll: {
    flex: 1,
  },
  pageContent: {
    flexGrow: 1,
    paddingBottom: 40,
  },
  sectionsContent: {
    paddingTop: 4,
  },
  section: {
    marginTop: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    marginBottom: 12,
  },
  sectionTitle: {
    fontFamily: FONT_SERIF_SEMIBOLD,
    color: TEXT_PRIMARY,
    fontSize: FS_LG,
  },
  sectionCount: {
    fontFamily: FONT_MEDIUM,
    color: TEXT_MUTED,
    fontSize: FS_SM,
  },
  sectionList: {
    paddingHorizontal: 24,
  },
  emptyCard: {
    borderRadius: 30,
    backgroundColor: SURFACE,
    borderWidth: 1,
    borderColor: BORDER,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 24,
  },
  emptyCardTitle: {
    fontFamily: FONT_BOLD,
    color: TEXT_PRIMARY,
    fontSize: FS_MD,
    marginTop: 6,
  },
  emptyCardSubtitle: {
    fontFamily: FONT_MEDIUM,
    color: TEXT_SECONDARY,
    fontSize: FS_SM,
    textAlign: 'center',
  },
  reveal: {
    zIndex: 10,
  },
});
