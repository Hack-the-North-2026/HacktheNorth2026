import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, ScrollView, Image, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { FitCard } from '../../components/FitCard';
import { IdentifyStatusView } from '../../components/IdentifyStatus';
import { getIdentifyJob } from '../../lib/api';
import { getJobPreview } from '../../lib/resultStore';
import { withIdentifySpan } from '../../lib/sentry';
import { IdentifyResult } from '../../lib/types';

const POLL_MS = 400;
const POLL_DEADLINE_MS = 90_000;

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

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <TouchableOpacity onPress={() => router.replace('/')} style={styles.back}>
          <Text style={styles.backText}>New screenshot</Text>
        </TouchableOpacity>

        {thumbnail ? (
          <Image source={{ uri: thumbnail }} style={styles.thumbnail} resizeMode="cover" />
        ) : null}

        {loading && <IdentifyStatusView status={result?.status || 'queued'} />}

        {failed && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>{failMessage}</Text>
            <TouchableOpacity style={styles.retry} onPress={() => router.replace('/')}>
              <Text style={styles.retryText}>Try another screenshot</Text>
            </TouchableOpacity>
          </View>
        )}

        {empty && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>We couldn’t see a clear outfit in this photo.</Text>
            <Text style={styles.emptySubtitle}>Try another screenshot with the outfit clearly visible.</Text>
            <TouchableOpacity style={styles.retry} onPress={() => router.replace('/')}>
              <Text style={styles.retryText}>Try another screenshot</Text>
            </TouchableOpacity>
          </View>
        )}

        {result?.status === 'done' && result.outfit_summary ? (
          <Text style={styles.summary}>{result.outfit_summary}</Text>
        ) : null}

        {result?.status === 'done' && result.items.map(({ garment, matches }) => (
          <View key={garment.id} style={styles.section}>
            <Text style={styles.sectionTitle}>{garment.description}</Text>
            {garment.accessibility_line ? (
              <Text style={styles.accessLine}>{garment.accessibility_line}</Text>
            ) : null}
            {matches.length === 0 ? (
              <Text style={styles.emptySubtitle}>No product matches yet for this item.</Text>
            ) : (
              matches.map((match, index) => (
                <FitCard key={`${garment.id}-${index}`} match={match} />
              ))
            )}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0F0F12',
  },
  container: {
    flex: 1,
    backgroundColor: '#0F0F12',
  },
  content: {
    padding: 24,
    paddingBottom: 48,
  },
  back: {
    marginBottom: 16,
  },
  backText: {
    color: '#A5B4FC',
    fontSize: 14,
    fontWeight: '600',
  },
  thumbnail: {
    width: '100%',
    height: 220,
    borderRadius: 16,
    marginBottom: 16,
    backgroundColor: '#1C1C22',
  },
  summary: {
    color: '#D1D5DB',
    fontSize: 15,
    marginBottom: 24,
    lineHeight: 21,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  accessLine: {
    color: '#9CA3AF',
    fontSize: 13,
    marginBottom: 8,
    lineHeight: 18,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
    gap: 12,
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptySubtitle: {
    color: '#888899',
    fontSize: 14,
    textAlign: 'center',
  },
  retry: {
    marginTop: 8,
    backgroundColor: '#6366F1',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  retryText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
});
