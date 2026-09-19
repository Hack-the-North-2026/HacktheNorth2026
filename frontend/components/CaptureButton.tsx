import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { PulseRings } from './PulseRings';

interface CaptureButtonProps {
  size?: number;
  disabled?: boolean;
  onPress: () => void;
  onLongPress: () => void;
}

const ACCENT = '#7C7CFF';
const ACCENT_DARK = '#3F3FBD';

export const CaptureButton: React.FC<CaptureButtonProps> = ({ size = 176, disabled, onPress, onLongPress }) => {
  const breathe = useRef(new Animated.Value(0)).current;
  const pressScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [breathe]);

  const scale = Animated.multiply(
    pressScale,
    breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.045] })
  );

  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      onPressIn={() =>
        Animated.timing(pressScale, { toValue: 0.94, duration: 120, useNativeDriver: true }).start()
      }
      onPressOut={() =>
        Animated.spring(pressScale, { toValue: 1, useNativeDriver: true, friction: 5 }).start()
      }
      style={{ width: size + 90, height: size + 90, alignItems: 'center', justifyContent: 'center' }}
    >
      <PulseRings size={size} color={ACCENT} active={!disabled} />
      <Animated.View style={[styles.shadowWrap, { width: size, height: size, borderRadius: size / 2, transform: [{ scale }] }]}>
        <LinearGradient
          colors={[ACCENT, ACCENT_DARK]}
          start={{ x: 0.2, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={[styles.gradient, { width: size, height: size, borderRadius: size / 2 }]}
        >
          <Ionicons name="camera" size={size * 0.34} color="#F5F5FF" />
        </LinearGradient>
      </Animated.View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  shadowWrap: {
    shadowColor: '#7C7CFF',
    shadowOpacity: 0.55,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  gradient: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
