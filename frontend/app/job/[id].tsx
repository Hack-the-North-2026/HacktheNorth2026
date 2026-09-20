import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, ScrollView, Image, Pressable, Animated } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { FitCard } from '../../components/FitCard';
import { IdentifyStatusView } from '../../components/IdentifyStatus';
import { getIdentifyJob } from '../../lib/api';
import { getJobPreview } from '../../lib/resultStore';
import { withIdentifySpan } from '../../lib/sentry';
import { IdentifyResult } from '../../lib/types';

const HERO_HEIGHT = 460;
const POLL_MS = 400;
const POLL_DEADLINE_MS = 90_000;

function AnimatedSection({ index, children }: { index: number; children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(16)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 380, delay: 120 + index * 90, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, delay: 120 + index * 90, useNativeDriver: true, friction: 8 }),
    ]).start();
  }, [opacity, translateY, index]);

  return (
    <Animated.View style={{ opacity, transform: [{ translateY }] }}>
      {children}
    </Animated.View>
  );
}

export default function JobScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = Array.isArray(id) ? id[0] : id;
  const preview = jobId ? getJobPreview(jobId) : null;
  const [result, setResult] = useState<IdentifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const didHaptic = useRef(false);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;

    setResult(null);
    setError(null);

    const poll = async () => {
      try {
        await withIdentifySpan(jobId, async () => {
          const started = Date.now();
          while (!cancelled) {
            const job = await getIdentifyJob(jobId);
            if (cancelled) return;
            setResult(job);
            if (job.status === 'done' || job.status === 'error') {
              return job;
            }
            if (Date.now() - started > POLL_DEADLINE_MS) {
              throw new Error('This photo took too long to identify. Try another screenshot.');
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          }
        });
      } catch (err: unknown) {
        if (!cancelled) {
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

  const thumbnail = result?.thumbnail_url || preview;
  const failed = Boolean(error) || result?.status === 'error';
  const failMessage = error || result?.error || 'Something went wrong identifying this photo. Try another screenshot.';
  const loading = !failed && (!result || (result.status !== 'done' && result.status !== 'error'));
  const empty = result?.status === 'done' && result.items.length === 0;
  const done = result?.status === 'done';
  const hasItems = Boolean(done && result && result.items.length > 0);
  const headline = failed
    ? 'Couldn’t identify'
    : loading
      ? 'Identifying…'
      : hasItems
        ? `${result!.items.length} piece${result!.items.length > 1 ? 's' : ''} found`
        : 'Nothing identified';

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.heroWrap}>
          {thumbnail ? (
            <Image source={{ uri: thumbnail }} style={styles.thumbnail} resizeMode="cover" />
          ) : null}
          <LinearGradient colors={['rgba(0,0,0,0.55)', 'transparent']} style={styles.heroTopScrim} />
          <LinearGradient colors={['transparent', 'rgba(5,5,9,0.75)', '#050509']} style={styles.heroBottomScrim} />
          <View style={styles.heroText}>
            <Text style={styles.eyebrow}>{loading ? 'SCANNING' : failed ? 'ERROR' : 'IDENTIFIED'}</Text>
            <Text style={styles.headline}>{headline}</Text>
          </View>
        </View>

        {loading && <IdentifyStatusView status={result?.status || 'queued'} />}

        {failed && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>{failMessage}</Text>
            <Text style={styles.emptySubtitle}>Try another screenshot with the outfit clearly visible.</Text>
          </View>
        )}

        {empty && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>We couldn’t see a clear outfit in this photo.</Text>
            <Text style={styles.emptySubtitle}>Try another screenshot with the outfit clearly visible.</Text>
          </View>
        )}

        {done && result?.outfit_summary ? (
          <Text style={styles.summary}>{result.outfit_summary}</Text>
        ) : null}

        {done && result?.items.map(({ garment, matches }, index) => (
          <AnimatedSection key={garment.id} index={index}>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{garment.description}</Text>
              {garment.accessibility_line ? (
                <Text style={styles.accessLine}>{garment.accessibility_line}</Text>
              ) : null}
              <View style={styles.cardGroup}>
                {matches.length === 0 ? (
                  <Text style={styles.emptySubtitle}>No product matches yet for this item.</Text>
                ) : (
                  matches.map((match, matchIndex) => (
                    <FitCard key={`${garment.id}-${matchIndex}`} match={match} />
                  ))
                )}
              </View>
            </View>
          </AnimatedSection>
        ))}
      </ScrollView>

      <Pressable style={styles.backButton} onPress={() => router.replace('/')}>
        <Ionicons name="chevron-back" size={22} color="#F5F5FA" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050509',
  },
  content: {
    paddingBottom: 48,
  },
  heroWrap: {
    width: '100%',
    height: HERO_HEIGHT,
    backgroundColor: '#12121A',
  },
  thumbnail: {
    width: '100%',
    height: '100%',
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
    height: 220,
  },
  heroText: {
    position: 'absolute',
    bottom: 28,
    left: 24,
    right: 24,
  },
  eyebrow: {
    color: '#9C9CFF',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.4,
    marginBottom: 6,
  },
  headline: {
    color: '#FFFFFF',
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  summary: {
    color: '#9494A2',
    fontSize: 14.5,
    lineHeight: 20,
    marginHorizontal: 24,
    marginTop: 16,
    marginBottom: 4,
  },
  section: {
    marginTop: 26,
    paddingHorizontal: 24,
  },
  sectionTitle: {
    color: '#F5F5FA',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  accessLine: {
    color: '#6B6B7A',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 6,
  },
  cardGroup: {
    marginTop: 6,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
    gap: 8,
    paddingHorizontal: 24,
  },
  emptyTitle: {
    color: '#F5F5FA',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptySubtitle: {
    color: '#6B6B7A',
    fontSize: 14,
    textAlign: 'center',
  },
  backButton: {
    position: 'absolute',
    top: 56,
    left: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(10, 10, 16, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
});
