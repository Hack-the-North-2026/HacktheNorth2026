import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View, ScrollView, Image, Pressable, Animated } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { getLastResult } from '../lib/resultStore';
import { FitCard } from '../components/FitCard';

const HERO_HEIGHT = 460;

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

export default function ResultsScreen() {
  const router = useRouter();
  const result = getLastResult();

  if (!result) {
    router.replace('/');
    return null;
  }

  const hasItems = result.items.length > 0;
  const headline = hasItems
    ? `${result.items.length} piece${result.items.length > 1 ? 's' : ''} found`
    : 'Nothing identified';

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.heroWrap}>
          {result.thumbnail_url && (
            <Image source={{ uri: result.thumbnail_url }} style={styles.thumbnail} resizeMode="cover" />
          )}
          <LinearGradient colors={['rgba(0,0,0,0.55)', 'transparent']} style={styles.heroTopScrim} />
          <LinearGradient colors={['transparent', 'rgba(5,5,9,0.75)', '#050509']} style={styles.heroBottomScrim} />
          <View style={styles.heroText}>
            <Text style={styles.eyebrow}>IDENTIFIED</Text>
            <Text style={styles.headline}>{headline}</Text>
          </View>
        </View>

        {result.outfit_summary && (
          <Text style={styles.summary}>{result.outfit_summary}</Text>
        )}

        {!hasItems && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>We couldn't see a clear outfit in this photo.</Text>
            <Text style={styles.emptySubtitle}>Try another screenshot with the outfit clearly visible.</Text>
          </View>
        )}

        {result.items.map(({ garment, matches }, index) => (
          <AnimatedSection key={garment.id} index={index}>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{garment.description}</Text>
              <View style={styles.cardGroup}>
                {matches.map((match, matchIndex) => (
                  <FitCard key={`${garment.id}-${matchIndex}`} match={match} />
                ))}
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
