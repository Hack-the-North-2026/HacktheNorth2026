import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

interface PulseRingsProps {
  size: number;
  color: string;
  ringCount?: number;
  active?: boolean;
}

export const PulseRings: React.FC<PulseRingsProps> = ({ size, color, ringCount = 3, active = true }) => {
  const anims = useRef(Array.from({ length: ringCount }, () => new Animated.Value(0))).current;

  useEffect(() => {
    if (!active) return;
    const loops = anims.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay((index * 1600) / ringCount),
          Animated.timing(value, {
            toValue: 1,
            duration: 1600,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(value, { toValue: 0, duration: 0, useNativeDriver: true }),
          Animated.delay(1600 - (index * 1600) / ringCount),
        ])
      )
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [active, anims, ringCount]);

  return (
    <View style={[styles.container, { width: size, height: size }]} pointerEvents="none">
      {anims.map((value, index) => (
        <Animated.View
          key={index}
          style={[
            styles.ring,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              borderColor: color,
              opacity: value.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.35, 0] }),
              transform: [
                {
                  scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1.35] }),
                },
              ],
            },
          ]}
        />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'absolute',
  },
  ring: {
    position: 'absolute',
    borderWidth: 1.5,
  },
});
