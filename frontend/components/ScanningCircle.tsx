import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, Platform, StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { ACCENT, EASE_OUT_EXPO } from '../lib/theme';

const useNativeDriver = Platform.OS !== 'web';

interface ScanningCircleProps {
  uri: string;
  size?: number;
  durationMs: number;
  color?: string;
}

export const ScanningCircle: React.FC<ScanningCircleProps> = ({
  uri,
  size = 176,
  durationMs,
  color = ACCENT,
}) => {
  const breathe = useRef(new Animated.Value(0)).current;
  const progress = useRef(new Animated.Value(0)).current;

  const strokeWidth = 4;
  const radius = size / 2 - strokeWidth;
  const circumference = 2 * Math.PI * radius;
  const [dashOffset, setDashOffset] = useState(circumference);

  useEffect(() => {
    const listenerId = progress.addListener(({ value }) => {
      setDashOffset(circumference * (1 - value));
    });

    const breatheLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.ease), useNativeDriver }),
        Animated.timing(breathe, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.ease), useNativeDriver }),
      ])
    );
    breatheLoop.start();

    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: durationMs,
      easing: Easing.bezier(...EASE_OUT_EXPO),
      useNativeDriver: false,
    }).start();

    return () => {
      breatheLoop.stop();
      progress.removeListener(listenerId);
    };
  }, [breathe, progress, durationMs, circumference]);

  const scale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.045] });

  return (
    <Animated.View style={{ width: size, height: size, transform: [{ scale }] }}>
      <View style={[styles.imageClip, { width: size, height: size, borderRadius: size / 2 }]}>
        <Image source={{ uri }} style={{ width: size, height: size }} resizeMode="cover" />
      </View>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="rgba(255,255,255,0.12)"
          strokeWidth={strokeWidth}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  imageClip: {
    overflow: 'hidden',
    backgroundColor: '#12121A',
  },
});
