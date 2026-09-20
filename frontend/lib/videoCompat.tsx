import React, { useMemo } from 'react';
import { View, Image, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

// Check if ExpoVideo native module is linked in the running native binary
export const isExpoVideoAvailable = Boolean(requireOptionalNativeModule('ExpoVideo'));

let ExpoVideoModule: typeof import('expo-video') | null = null;
if (isExpoVideoAvailable) {
  try {
    ExpoVideoModule = require('expo-video');
  } catch (err) {
    console.warn('[videoCompat] ExpoVideo native module was reported available, but require("expo-video") failed:', err);
    ExpoVideoModule = null;
  }
}

export type SafeVideoPlayer = {
  src: string | null;
  loop: boolean;
  muted: boolean;
  playing: boolean;
  status: string;
  play: () => void;
  pause: () => void;
  release?: () => void;
  [key: string]: any;
};

export function useVideoPlayer(
  source: any,
  setup?: (player: any) => void
): any {
  if (ExpoVideoModule?.useVideoPlayer) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return ExpoVideoModule.useVideoPlayer(source, setup);
  }

  // Fallback dummy player when native module is missing from the binary
  const dummyPlayer = useMemo<SafeVideoPlayer>(() => {
    const rawUri = typeof source === 'string' ? source : source?.uri ?? null;
    const dummy: SafeVideoPlayer = {
      src: rawUri,
      loop: false,
      muted: false,
      playing: false,
      status: 'idle',
      play: () => {
        dummy.playing = true;
        dummy.status = 'playing';
      },
      pause: () => {
        dummy.playing = false;
        dummy.status = 'paused';
      },
    };
    return dummy;
  }, [typeof source === 'string' ? source : source?.uri]);

  if (setup) {
    try {
      setup(dummyPlayer);
    } catch {}
  }

  return dummyPlayer;
}

export const useSafeVideoPlayer = useVideoPlayer;

export type VideoViewProps = {
  player?: any;
  style?: StyleProp<ViewStyle>;
  contentFit?: 'cover' | 'contain' | 'fill';
  nativeControls?: boolean;
  playsInline?: boolean;
  fallbackUri?: string | null;
  [key: string]: any;
};

export function VideoView(props: VideoViewProps) {
  if (ExpoVideoModule?.VideoView) {
    const RealVideoView = ExpoVideoModule.VideoView;
    return <RealVideoView {...props} />;
  }

  const uri = props.fallbackUri || props.player?.src;
  const isImageUri = uri && !/\.(mp4|mov|webm|m4v|mkv)$/i.test(uri.split('?')[0]);

  if (uri && isImageUri) {
    return (
      <Image
        source={{ uri }}
        style={props.style as any}
        resizeMode={props.contentFit === 'contain' ? 'contain' : 'cover'}
      />
    );
  }

  return (
    <View style={[styles.fallback, props.style]} />
  );
}

export const SafeVideoView = VideoView;

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: '#1a1816',
  },
});
