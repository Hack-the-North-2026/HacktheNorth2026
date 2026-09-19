import React from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Linking } from 'react-native';
import { Match } from '../lib/types';

interface FitCardProps {
  match: Match;
}

export const FitCard: React.FC<FitCardProps> = ({ match }) => {
  const handlePress = () => {
    if (match.url) {
      Linking.openURL(match.url);
    }
  };

  const isExact = match.match_type === 'exact';

  return (
    <View style={styles.card}>
      {match.image_url && (
        <Image source={{ uri: match.image_url }} style={styles.image} resizeMode="cover" />
      )}
      <View style={styles.details}>
        <View style={[styles.badge, isExact ? styles.badgeExact : styles.badgeSimilar]}>
          <Text style={styles.badgeText}>{isExact ? 'Found' : 'Similar'}</Text>
        </View>
        <Text style={styles.title} numberOfLines={2}>{match.title}</Text>
        {match.store_name && <Text style={styles.store}>{match.store_name}</Text>}
        {match.price && (
          <Text style={styles.price}>
            {match.currency ? `${match.currency} ` : ''}{match.price}
          </Text>
        )}
        <TouchableOpacity style={styles.buyButton} onPress={handlePress}>
          <Text style={styles.buyButtonText}>View Product</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1C1C22',
    borderRadius: 16,
    overflow: 'hidden',
    marginVertical: 8,
    borderWidth: 1,
    borderColor: '#2E2E38',
    flexDirection: 'row',
  },
  image: {
    width: 100,
    height: 130,
  },
  details: {
    flex: 1,
    padding: 12,
    justifyContent: 'space-between',
    gap: 4,
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeExact: {
    backgroundColor: '#10B98122',
  },
  badgeSimilar: {
    backgroundColor: '#F59E0B22',
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#D1D5DB',
  },
  title: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  store: {
    color: '#888899',
    fontSize: 12,
  },
  price: {
    color: '#10B981',
    fontWeight: '700',
    fontSize: 16,
  },
  buyButton: {
    backgroundColor: '#6366F1',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  buyButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
});
