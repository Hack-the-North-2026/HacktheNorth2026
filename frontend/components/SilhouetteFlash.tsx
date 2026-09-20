import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, ImageSourcePropType, StyleSheet } from 'react-native';

const SILHOUETTES: ImageSourcePropType[] = [
  require('../assets/silhouettes/silhouette-01.png'),
  require('../assets/silhouettes/silhouette-02.png'),
  require('../assets/silhouettes/silhouette-03.png'),
  require('../assets/silhouettes/silhouette-04.png'),
  require('../assets/silhouettes/silhouette-05.png'),
  require('../assets/silhouettes/silhouette-06.png'),
  require('../assets/silhouettes/silhouette-07.png'),
  require('../assets/silhouettes/silhouette-08.png'),
  require('../assets/silhouettes/silhouette-09.png'),
  require('../assets/silhouettes/silhouette-10.png'),
  require('../assets/silhouettes/silhouette-11.png'),
  require('../assets/silhouettes/silhouette-12.png'),
];

function shuffledIndices(count: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

interface SilhouetteFlashProps {
  active: boolean;
  size?: number;
}

export const SilhouetteFlash: React.FC<SilhouetteFlashProps> = ({ active, size = 260 }) => {
  const opacity = useRef(new Animated.Value(0)).current;
  const [source, setSource] = useState<ImageSourcePropType>(SILHOUETTES[0]);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      opacity.stopAnimation();
      opacity.setValue(0);
      return;
    }

    const order = shuffledIndices(SILHOUETTES.length);
    let pos = 0;

    const cycle = () => {
      if (!activeRef.current) return;
      setSource(SILHOUETTES[order[pos % order.length]]);
      pos += 1;
      opacity.setValue(0);
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.4, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.delay(220),
        Animated.timing(opacity, { toValue: 0, duration: 380, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished && activeRef.current) cycle();
      });
    };
    cycle();
  }, [active, opacity]);

  if (!active) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.wrap, { width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, opacity }]}
    >
      <Image source={source} style={styles.image} resizeMode="contain" />
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
});
