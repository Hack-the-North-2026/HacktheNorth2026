import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, Platform, StyleSheet, View, Text } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { ACCENT, EASE_OUT_EXPO } from '../lib/theme';
import { isVideoUri } from '../lib/api';

const useNativeDriver = Platform.OS !== 'web';

// We don't know the real job's duration up front, so the ring crawls toward
// (never quite reaching) this ceiling with a decelerating curve — fast at
// first, then slower — instead of running to 100% on a guessed timer. Once
// the real result arrives, `done` snaps it the rest of the way.
const CRAWL_CEILING = 0.92;
const CRAWL_DURATION_MS = 20000;
const FINISH_DURATION_MS = 320;

interface ScanningCircleProps {
  uri: string;
  size?: number;
  color?: string;
  done?: boolean;
  onFinished?: () => void;
}

export const ScanningCircle: React.FC<ScanningCircleProps> = ({
  uri,
  size = 176,
  color = ACCENT,
  done = false,
  onFinished,
}) => {
  const breathe = useRef(new Animated.Value(0)).current;
  const progress = useRef(new Animated.Value(0)).current;
  const isVideo = isVideoUri(uri);

  const strokeWidth = 4;
  const radius = size / 2 - strokeWidth;
  const circumference = 2 * Math.PI * radius;
  const [dashOffset, setDashOffset] = useState(circumference);

  useEffect(() => {
    const listenerId = progress.addListener(({ value }) => {
      setDashOffset(circumference * (1 - value));
    });
    return () => progress.removeListener(listenerId);
  }, [progress, circumference]);

  useEffect(() => {
    const breatheLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.ease), useNativeDriver }),
        Animated.timing(breathe, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.ease), useNativeDriver }),
      ])
    );
    breatheLoop.start();
    return () => breatheLoop.stop();
  }, [breathe]);

  useEffect(() => {
    if (done) return;
    progress.setValue(0);
    const crawl = Animated.timing(progress, {
      toValue: CRAWL_CEILING,
      duration: CRAWL_DURATION_MS,
      easing: Easing.bezier(...EASE_OUT_EXPO),
      useNativeDriver: false,
    });
    crawl.start();
    return () => crawl.stop();
  }, [done, progress]);

  useEffect(() => {
    if (!done) return;
    const finish = Animated.timing(progress, {
      toValue: 1,
      duration: FINISH_DURATION_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    finish.start(({ finished }) => {
      if (finished) onFinished?.();
    });
    return () => finish.stop();
  }, [done, progress, onFinished]);

  const scale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.045] });

  return (
    <Animated.View style={{ width: size, height: size, transform: [{ scale }] }}>
      <View style={[styles.imageClip, { width: size, height: size, borderRadius: size / 2 }]}>
        {isVideo ? (
          <LinearGradient
            colors={['#1F1D36', '#0E0D1B']}
            style={[styles.videoCenter, { width: size, height: size }]}
          >
            <Ionicons name="videocam" size={size * 0.3} color="#C4B5FD" />
            <Text style={styles.videoBadge}>VIDEO</Text>
          </LinearGradient>
        ) : (
          <Image source={{ uri }} style={{ width: size, height: size }} resizeMode="cover" />
        )}
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
  videoCenter: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoBadge: {
    marginTop: 6,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: '#C4B5FD',
  },
});
