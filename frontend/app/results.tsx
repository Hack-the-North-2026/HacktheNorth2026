import React from 'react';
import { StyleSheet, Text, View, ScrollView, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { getLastResult } from '../lib/resultStore';
import { FitCard } from '../components/FitCard';

export default function ResultsScreen() {
  const router = useRouter();
  const result = getLastResult();

  if (!result) {
    router.replace('/');
    return null;
  }

  const hasItems = result.items.length > 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {result.thumbnail_url && (
        <Image source={{ uri: result.thumbnail_url }} style={styles.thumbnail} resizeMode="cover" />
      )}

      {result.outfit_summary && (
        <Text style={styles.summary}>{result.outfit_summary}</Text>
      )}

      {!hasItems && (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>We couldn't see a clear outfit in this photo.</Text>
          <Text style={styles.emptySubtitle}>Try another screenshot with the outfit clearly visible.</Text>
        </View>
      )}

      {result.items.map(({ garment, matches }) => (
        <View key={garment.id} style={styles.section}>
          <Text style={styles.sectionTitle}>{garment.description}</Text>
          {matches.map((match, index) => (
            <FitCard key={`${garment.id}-${index}`} match={match} />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F0F12',
  },
  content: {
    padding: 24,
    paddingTop: 60,
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
    marginBottom: 8,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
    gap: 8,
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
});
