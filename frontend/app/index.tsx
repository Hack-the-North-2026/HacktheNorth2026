import React, { useRef, useState } from 'react';
import { StyleSheet, Text, View, Animated, Alert, Platform, Pressable, Linking, LayoutChangeEvent } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { startIdentifyJob, getIdentifyJob, isVideoUri } from '../lib/api';
import { setJobPreview } from '../lib/resultStore';
import { CaptureButton } from '../components/CaptureButton';
import { ScanningCircle } from '../components/ScanningCircle';
import { SilhouetteFlash } from '../components/SilhouetteFlash';
import { RippleTransition } from '../components/RippleTransition';
import {
  BACKGROUND,
  TEXT_PRIMARY,
  TEXT_MUTED,
  SURFACE,
  BORDER,
  ACCENT,
  FONT_MEDIUM,
  FONT_SEMIBOLD,
  FONT_BOLD,
  FONT_SERIF_SEMIBOLD,
} from '../lib/theme';

type Phase = 'idle' | 'scanning' | 'revealing';

const POLL_MS = 400;
const POLL_DEADLINE_MS = 90_000;
const CIRCLE_SIZE = 200;

const useNativeDriver = Platform.OS !== 'web';

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>('idle');
  const [uri, setUri] = useState<string | null>(null);
  const [circleOrigin, setCircleOrigin] = useState({ x: 0, y: 0 });
  const [jobDone, setJobDone] = useState(false);
  const [keyframes, setKeyframes] = useState<string[]>([]);
  const jobIdRef = useRef<string | null>(null);
  const ringFinishedRef = useRef<(() => void) | null>(null);

  const idleOpacity = useRef(new Animated.Value(1)).current;
  const scanOpacity = useRef(new Animated.Value(0)).current;

  const setIdleVisible = (visible: boolean) => {
    Animated.parallel([
      Animated.timing(idleOpacity, { toValue: visible ? 1 : 0, duration: 320, useNativeDriver }),
      Animated.timing(scanOpacity, { toValue: visible ? 0 : 1, duration: 320, useNativeDriver }),
    ]).start();
  };

  const onCircleLayout = (event: LayoutChangeEvent) => {
    const { x, y, width, height } = event.nativeEvent.layout;
    setCircleOrigin({ x: x + width / 2, y: y + height / 2 });
  };

  const runIdentify = async (asset: { uri: string; fileName?: string | null; mimeType?: string | null }) => {
    setUri(asset.uri);
    setKeyframes([]);
    setJobDone(false);
    setPhase('scanning');
    setIdleVisible(false);
    try {
      const job = await startIdentifyJob(asset);
      setJobPreview(job.job_id, asset.uri);
      jobIdRef.current = job.job_id;

      // Keep the circle up until the job is actually finished — starting the
      // job only means it was accepted, not that a result exists yet.
      const started = Date.now();
      let latest = job;
      while (latest.status !== 'done' && latest.status !== 'error') {
        if (Date.now() - started > POLL_DEADLINE_MS) {
          throw new Error('This media took too long to identify. Try another clip or screenshot.');
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        latest = await getIdentifyJob(job.job_id);
        if (latest.keyframes && latest.keyframes.length > 0) {
          setKeyframes(latest.keyframes);
        }
      }

      // Let the ring's fast finish animation land before rippling away.
      await new Promise<void>((resolve) => {
        ringFinishedRef.current = resolve;
        setJobDone(true);
      });
      setPhase('revealing');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Could not process that upload.';
      Alert.alert('Identify Failed', message);
      setPhase('idle');
      setIdleVisible(true);
    }
  };

  const onRippleDone = () => {
    if (jobIdRef.current) {
      router.push(`/job/${jobIdRef.current}`);
    }
    setTimeout(() => {
      setPhase('idle');
      setIdleVisible(true);
    }, 400);
  };

  const pickFromLibrary = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow photo library access to upload a screenshot or video.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      videoMaxDuration: 15,
      quality: 0.9,
    });
    if (!result.canceled && result.assets[0]) {
      runIdentify(result.assets[0]);
    }
  };

  // Opens Android Accessibility Settings so the user can enable the overlay service.
  const openAccessibilitySettings = () => {
    Linking.openSettings().catch(() => {
      Alert.alert('Open Settings', 'Go to Settings → Accessibility → Fit Stealer to enable the overlay.');
    });
  };

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow camera access to capture a screenshot or record a video.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images', 'videos'],
      videoMaxDuration: 15,
      quality: 0.9,
    });
    if (!result.canceled && result.assets[0]) {
      runIdentify(result.assets[0]);
    }
  };

  const isVideo = isVideoUri(uri);

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.layer, { opacity: idleOpacity, pointerEvents: phase === 'idle' ? 'auto' : 'none' }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Recently searched"
          onPress={() => router.push('/recent')}
          style={[styles.recentButton, { top: Math.max(insets.top, 16) + 8 }]}
        >
          <Ionicons name="time-outline" size={16} color={TEXT_PRIMARY} />
          <Text style={styles.recentLabel}>Recent</Text>
        </Pressable>
        <View style={styles.captionWrap}>
          <Text style={styles.caption}>Tap to find this fit</Text>
          <Text style={styles.subCaption}>Hold to use the camera</Text>
        </View>
        <View style={styles.buttonWrap}>
          <CaptureButton size={CIRCLE_SIZE} disabled={phase !== 'idle'} onPress={pickFromLibrary} onLongPress={takePhoto} />
        </View>
        {Platform.OS === 'android' && (
          <Pressable
            style={styles.overlayButton}
            onPress={openAccessibilitySettings}
            accessibilityLabel="Set up overlay bubble"
            accessibilityHint="Opens Accessibility Settings to enable the Fit Stealer overlay">
            <Text style={styles.overlayButtonText}>⚙ Setup Overlay Bubble</Text>
          </Pressable>
        )}
      </Animated.View>

      <Animated.View style={[styles.layer, styles.scanningLayer, { opacity: scanOpacity, pointerEvents: 'none' }]}>
        {uri && phase !== 'idle' && (
          <View onLayout={onCircleLayout} style={styles.circleStack}>
            <SilhouetteFlash active={phase === 'scanning'} size={296} />
            <ScanningCircle
              uri={uri}
              keyframes={keyframes}
              size={CIRCLE_SIZE}
              done={jobDone}
              onFinished={() => ringFinishedRef.current?.()}
            />
          </View>
        )}
        <Text style={styles.scanTitle}>{isVideo ? 'Analyzing video frames' : 'Identifying your fit'}</Text>
        <Text style={styles.scanSubtitle}>
          {isVideo ? 'Selecting clearest frames & matching items' : 'Matching the pieces to real listings'}
        </Text>
      </Animated.View>

      <RippleTransition
        originX={circleOrigin.x}
        originY={circleOrigin.y}
        active={phase === 'revealing'}
        onDone={onRippleDone}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BACKGROUND,
  },
  layer: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  scanningLayer: {
    gap: 24,
  },
  circleStack: {
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recentButton: {
    position: 'absolute',
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: SURFACE,
    borderWidth: 1,
    borderColor: BORDER,
  },
  recentLabel: {
    color: TEXT_PRIMARY,
    fontSize: 13.5,
    fontFamily: FONT_SEMIBOLD,
  },
  buttonWrap: {
    marginTop: 40,
  },
  captionWrap: {
    alignItems: 'center',
  },
  caption: {
    fontSize: 30,
    fontFamily: FONT_SERIF_SEMIBOLD,
    color: TEXT_PRIMARY,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  subCaption: {
    fontSize: 15,
    fontFamily: FONT_MEDIUM,
    color: TEXT_MUTED,
    marginTop: 8,
  },
  scanTitle: {
    fontSize: 20,
    fontFamily: FONT_BOLD,
    color: TEXT_PRIMARY,
    marginTop: 4,
  },
  scanSubtitle: {
    fontSize: 14,
    fontFamily: FONT_MEDIUM,
    color: TEXT_MUTED,
  },
  overlayButton: {
    marginTop: 28,
    paddingVertical: 11,
    paddingHorizontal: 22,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(156,107,65,0.35)',
    backgroundColor: 'rgba(156,107,65,0.10)',
  },
  overlayButtonText: {
    color: ACCENT,
    fontSize: 13.5,
    fontFamily: FONT_SEMIBOLD,
    letterSpacing: 0.3,
  },
});
