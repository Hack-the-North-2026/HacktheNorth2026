import React, { useEffect, useRef } from 'react';
import { Animated, Dimensions, Easing, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ACCENT_GRADIENT, EASE_OUT_EXPO } from '../lib/theme';

const BASE_SIZE = 200;
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const DIAGONAL = Math.sqrt(SCREEN_W * SCREEN_W + SCREEN_H * SCREEN_H);
const TARGET_SCALE = (DIAGONAL * 2.1) / BASE_SIZE;

interface RippleTransitionProps {
  originX: number;
  originY: number;
  active: boolean;
  durationMs?: number;
  onDone?: () => void;
}

export const RippleTransition: React.FC<RippleTransitionProps> = ({
  originX,
  originY,
  active,
  durationMs = 620,
  onDone,
}) => {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) {
      progress.setValue(0);
      return;
    }
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: durationMs,
      easing: Easing.bezier(...EASE_OUT_EXPO),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) onDone?.();
    });
  }, [active, durationMs, onDone, progress]);

  if (!active) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.circle,
        {
          left: originX - BASE_SIZE / 2,
          top: originY - BASE_SIZE / 2,
          transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.001, TARGET_SCALE] }) }],
        },
      ]}
    >
      <LinearGradient colors={ACCENT_GRADIENT} style={styles.fill} />
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  circle: {
    position: 'absolute',
    width: BASE_SIZE,
    height: BASE_SIZE,
    borderRadius: BASE_SIZE / 2,
    overflow: 'hidden',
  },
  fill: {
    width: '100%',
    height: '100%',
  },
});
