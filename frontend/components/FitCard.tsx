import React, { useRef } from 'react';
import { View, Text, StyleSheet, Image, Pressable, Linking, Animated } from 'react-native';
import { Match } from '../lib/types';

interface FitCardProps {
  match: Match;
}

export const FitCard: React.FC<FitCardProps> = ({ match }) => {
  const scale = useRef(new Animated.Value(1)).current;
  const isExact = match.match_type === 'exact';

  const handlePress = () => {
    if (match.url) {
      Linking.openURL(match.url);
    }
  };

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        onPress={handlePress}
        onPressIn={() => Animated.spring(scale, { toValue: 0.98, useNativeDriver: true, friction: 6 }).start()}
        onPressOut={() => Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 6 }).start()}
        style={styles.row}
      >
        {match.image_url && (
          <Image source={{ uri: match.image_url }} style={styles.image} resizeMode="cover" />
        )}
        <View style={styles.details}>
          <Text style={styles.title} numberOfLines={1}>{match.title}</Text>
          {match.store_name && <Text style={styles.store} numberOfLines={1}>{match.store_name}</Text>}
          {match.reason ? (
            <Text style={styles.reason} numberOfLines={1}>{match.reason}</Text>
          ) : null}
        </View>
        <View style={styles.trailing}>
          {match.price && (
            <Text style={styles.price}>
              {match.currency ? `${match.currency} ` : ''}{match.price}
            </Text>
          )}
          <Text style={[styles.badgeText, isExact ? styles.badgeTextExact : styles.badgeTextSimilar]}>
            {isExact ? 'Found' : 'Similar'}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  image: {
    width: 60,
    height: 60,
    borderRadius: 12,
    backgroundColor: '#12121A',
  },
  details: {
    flex: 1,
    marginLeft: 14,
    gap: 3,
  },
  title: {
    color: '#F5F5FA',
    fontWeight: '600',
    fontSize: 15,
  },
  store: {
    color: '#6B6B7A',
    fontSize: 12.5,
  },
  reason: {
    color: '#5C5C6B',
    fontSize: 11.5,
  },
  trailing: {
    alignItems: 'flex-end',
    gap: 4,
    marginLeft: 10,
  },
  price: {
    color: '#F5F5FA',
    fontWeight: '700',
    fontSize: 15,
  },
  badgeText: {
    fontSize: 11.5,
    fontWeight: '700',
  },
  badgeTextExact: {
    color: '#34D399',
  },
  badgeTextSimilar: {
    color: '#9C9CFF',
  },
});
