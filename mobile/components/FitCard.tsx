import React from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Linking } from 'react-native';

export interface ProductItem {
  id: string;
  title: string;
  price?: string;
  imageUrl?: string;
  productUrl?: string;
  storeName?: string;
}

interface FitCardProps {
  item: ProductItem;
}

export const FitCard: React.FC<FitCardProps> = ({ item }) => {
  const handlePress = () => {
    if (item.productUrl) {
      Linking.openURL(item.productUrl);
    }
  };

  return (
    <View style={styles.card}>
      {item.imageUrl && (
        <Image source={{ uri: item.imageUrl }} style={styles.image} resizeMode="cover" />
      )}
      <View style={styles.details}>
        <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
        {item.storeName && <Text style={styles.store}>{item.storeName}</Text>}
        {item.price && <Text style={styles.price}>{item.price}</Text>}
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
    height: 120,
  },
  details: {
    flex: 1,
    padding: 12,
    justifyContent: 'space-between',
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
