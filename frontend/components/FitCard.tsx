import React, { useRef } from 'react';
import { View, Text, StyleSheet, Image, Pressable, Linking, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Match } from '../lib/types';
import {
  SURFACE,
  SURFACE_MUTED,
  BORDER,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  ACCENT,
  SUCCESS,
  FONT_MEDIUM,
  FONT_BOLD,
  FONT_EXTRABOLD,
  FONT_SEMIBOLD,
  FONT_SERIF_SEMIBOLD,
  FS_LG,
  FS_MD,
  FS_SM,
} from '../lib/theme';

interface FitCardProps {
  match: Match;
  width: number;
  height?: number;
  /** `compact` is the grid tile used on the results screen; `full` is the large carousel card. */
  variant?: 'full' | 'compact';
}

export const FitCard: React.FC<FitCardProps> = ({ match, width, height, variant = 'full' }) => {
  const scale = useRef(new Animated.Value(1)).current;
  const isExact = match.match_type === 'exact';
  const compact = variant === 'compact';

  const handlePress = () => {
    if (match.url) {
      Linking.openURL(match.url);
    }
  };

  const pressProps = {
    onPress: handlePress,
    onPressIn: () => Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, friction: 7 }).start(),
    onPressOut: () => Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 7 }).start(),
    accessibilityRole: 'button' as const,
    accessibilityLabel: `Open ${match.title}${match.store_name ? ` at ${match.store_name}` : ''}`,
  };

  const thumbnail = (imageStyle: object, fallbackIcon: number) =>
    match.image_url ? (
      <Image source={{ uri: match.image_url }} style={imageStyle} resizeMode="cover" />
    ) : (
      <View style={[imageStyle, styles.imageFallback]}>
        <Ionicons name="shirt-outline" size={fallbackIcon} color={ACCENT} />
      </View>
    );

  if (compact) {
    return (
      <Animated.View style={{ width, transform: [{ scale }] }}>
        <Pressable {...pressProps} style={styles.compactCard}>
          <View style={[styles.compactImageWrap, { height: width }]}>
            {thumbnail(styles.image, 34)}
            <View
              style={[
                styles.compactBadge,
                isExact ? styles.matchBadgeExact : styles.matchBadgeSimilar,
              ]}
            >
              <Ionicons name={isExact ? 'checkmark-circle' : 'sparkles'} size={11} color="#FBF3E7" />
              <Text style={styles.compactBadgeText}>{isExact ? 'Exact' : 'Similar'}</Text>
            </View>
          </View>

          <View style={styles.compactBody}>
            <Text style={styles.compactTitle} numberOfLines={2}>{match.title}</Text>
            {match.store_name ? (
              <Text style={styles.compactStore} numberOfLines={1}>{match.store_name}</Text>
            ) : null}
            <View style={styles.compactFooter}>
              <Text style={styles.compactPrice} numberOfLines={1}>
                {match.price
                  ? `${match.currency ? `${match.currency} ` : ''}${match.price}`
                  : 'View'}
              </Text>
              <Ionicons
                name="arrow-up-outline"
                size={14}
                color={ACCENT}
                style={{ transform: [{ rotate: '45deg' }] }}
              />
            </View>
          </View>
        </Pressable>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={{ width, height, transform: [{ scale }] }}>
      <Pressable {...pressProps} style={styles.card}>
        <View style={styles.imageWrap}>
          {thumbnail(styles.image, 52)}

          <View style={[styles.matchBadge, isExact ? styles.matchBadgeExact : styles.matchBadgeSimilar]}>
            <Ionicons name={isExact ? 'checkmark-circle' : 'sparkles'} size={14} color="#FBF3E7" />
            <Text style={styles.matchBadgeText}>{isExact ? 'Exact match' : 'Similar find'}</Text>
          </View>

          <View style={styles.openIcon}>
            <Ionicons
              name="arrow-up-outline"
              size={17}
              color={TEXT_PRIMARY}
              style={{ transform: [{ rotate: '45deg' }] }}
            />
          </View>
        </View>

        <View style={styles.body}>
          <Text style={styles.title} numberOfLines={2}>{match.title}</Text>
          <View style={styles.metaRow}>
            {match.store_name ? (
              <Text style={styles.store} numberOfLines={1}>{match.store_name}</Text>
            ) : <View />}
            {match.price ? (
              <Text style={styles.price}>
                {match.currency ? `${match.currency} ` : ''}{match.price}
              </Text>
            ) : null}
          </View>

          <View style={styles.ctaButton}>
            <Text style={styles.ctaText}>View listing</Text>
            <Ionicons name="chevron-forward" size={16} color="#FBF3E7" />
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 30,
    backgroundColor: SURFACE,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: BORDER,
    elevation: 4,
    shadowColor: '#3A2A18',
    shadowOpacity: 0.16,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
  },
  imageWrap: {
    flex: 1,
    backgroundColor: SURFACE_MUTED,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  imageFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  matchBadge: {
    position: 'absolute',
    top: 18,
    left: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 999,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  matchBadgeExact: {
    backgroundColor: SUCCESS,
  },
  matchBadgeSimilar: {
    backgroundColor: ACCENT,
  },
  matchBadgeText: {
    fontFamily: FONT_BOLD,
    fontSize: FS_SM,
    color: '#FBF3E7',
    letterSpacing: 0.2,
  },
  openIcon: {
    position: 'absolute',
    top: 18,
    right: 18,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,253,248,0.9)',
  },
  body: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 20,
    gap: 12,
  },
  title: {
    fontFamily: FONT_SERIF_SEMIBOLD,
    color: TEXT_PRIMARY,
    fontSize: FS_LG,
    lineHeight: 30,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  store: {
    fontFamily: FONT_MEDIUM,
    color: TEXT_SECONDARY,
    fontSize: FS_MD,
    flexShrink: 1,
  },
  price: {
    fontFamily: FONT_EXTRABOLD,
    color: TEXT_PRIMARY,
    fontSize: FS_MD,
    marginLeft: 12,
  },
  ctaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    marginTop: 2,
    paddingVertical: 13,
    borderRadius: 16,
    backgroundColor: ACCENT,
  },
  ctaText: {
    fontFamily: FONT_BOLD,
    color: '#FBF3E7',
    fontSize: FS_MD,
    letterSpacing: 0.2,
  },
  compactCard: {
    borderRadius: 20,
    backgroundColor: SURFACE,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: BORDER,
    elevation: 2,
    shadowColor: '#3A2A18',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
  },
  compactImageWrap: {
    width: '100%',
    backgroundColor: SURFACE_MUTED,
  },
  compactBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  compactBadgeText: {
    fontFamily: FONT_BOLD,
    fontSize: 10,
    color: '#FBF3E7',
    letterSpacing: 0.2,
  },
  compactBody: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
    gap: 4,
  },
  compactTitle: {
    fontFamily: FONT_SEMIBOLD,
    color: TEXT_PRIMARY,
    fontSize: 13.5,
    lineHeight: 18,
  },
  compactStore: {
    fontFamily: FONT_MEDIUM,
    color: TEXT_SECONDARY,
    fontSize: FS_SM,
  },
  compactFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  compactPrice: {
    fontFamily: FONT_EXTRABOLD,
    color: TEXT_PRIMARY,
    fontSize: FS_MD,
    flexShrink: 1,
  },
});
