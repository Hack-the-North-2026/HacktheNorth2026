import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Image, StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

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
  color = '#7C7CFF',
}) => {
  const breathe = useRef(new Animated.Value(0)).current;
  const progress = useRef(new Animated.Value(0)).current;

  const strokeWidth = 4;
  const radius = size / 2 - strokeWidth;
  const circumference = 2 * Math.PI * radius;

  useEffect(() => {
    const breatheLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    breatheLoop.start();

    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: durationMs,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();

    return () => breatheLoop.stop();
  }, [breathe, progress, durationMs]);

  const scale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.045] });
  const strokeDashoffset = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [circumference, 0],
  });

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
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circumference}, ${circumference}`}
          strokeDashoffset={strokeDashoffset}
          rotation="-90"
          origin={`${size / 2}, ${size / 2}`}
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
