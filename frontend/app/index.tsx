import React, { useRef, useState } from 'react';
import { StyleSheet, Text, View, Animated, Alert, Platform, Pressable, Linking, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { startIdentifyJob, getIdentifyJob, isVideoUri } from '../lib/api';
import { setJobPreview } from '../lib/resultStore';
import { CaptureButton } from '../components/CaptureButton';
import { InspectingView } from '../components/InspectingView';
import { RippleTransition } from '../components/RippleTransition';
import { IdentifyResult, IdentifyStatus } from '../lib/types';
import {
  BACKGROUND,
  TEXT_PRIMARY,
  TEXT_MUTED,
  SURFACE,
  BORDER,
  ACCENT,
  FONT_MEDIUM,
  FONT_SEMIBOLD,
  FONT_SERIF_SEMIBOLD,
  FS_LG,
  FS_MD,
  FS_SM,
} from '../lib/theme';

type Phase = 'idle' | 'scanning' | 'revealing';

const POLL_MS = 400;
const POLL_DEADLINE_MS = 90_000;
const CIRCLE_SIZE = 200;
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const RIPPLE_ORIGIN = { x: SCREEN_W / 2, y: SCREEN_H / 2 };

const useNativeDriver = Platform.OS !== 'web';

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>('idle');
  const [uri, setUri] = useState<string | null>(null);
  const [jobDone, setJobDone] = useState(false);
  const [scanJob, setScanJob] = useState<IdentifyResult | null>(null);
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

  const runIdentify = async (asset: { uri: string; fileName?: string | null; mimeType?: string | null }) => {
    setUri(asset.uri);
    setScanJob(null);
    setJobDone(false);
    setPhase('scanning');
    setIdleVisible(false);
    try {
      const job = await startIdentifyJob(asset);
      setJobPreview(job.job_id, asset.uri);
      jobIdRef.current = job.job_id;
      setScanJob(job);

      // Keep the inspecting view up until the job is actually finished —
      // starting the job only means it was accepted, not that a result exists.
      const started = Date.now();
      let latest = job;
      while (latest.status !== 'done' && latest.status !== 'error') {
        if (Date.now() - started > POLL_DEADLINE_MS) {
          throw new Error('This media took too long to identify. Try another clip or screenshot.');
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        latest = await getIdentifyJob(job.job_id);
        setScanJob(latest);
      }

      // Let the progress bar's fast finish animation land before rippling away.
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

      <Animated.View style={[StyleSheet.absoluteFill, { opacity: scanOpacity, pointerEvents: phase === 'idle' ? 'none' : 'auto' }]}>
        {uri && phase !== 'idle' && (
          <InspectingView
            uri={uri}
            isVideo={isVideo}
            status={scanJob?.status ?? ('queued' as IdentifyStatus)}
            items={scanJob?.items ?? []}
            keyframes={scanJob?.keyframes}
            done={jobDone}
            onFinished={() => ringFinishedRef.current?.()}
          />
        )}
      </Animated.View>

      <RippleTransition
        originX={RIPPLE_ORIGIN.x}
        originY={RIPPLE_ORIGIN.y}
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
    fontSize: FS_SM,
    fontFamily: FONT_SEMIBOLD,
  },
  buttonWrap: {
    marginTop: 40,
  },
  captionWrap: {
    alignItems: 'center',
  },
  caption: {
    fontSize: FS_LG,
    fontFamily: FONT_SERIF_SEMIBOLD,
    color: TEXT_PRIMARY,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  subCaption: {
    fontSize: FS_MD,
    fontFamily: FONT_MEDIUM,
    color: TEXT_MUTED,
    marginTop: 8,
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
    fontSize: FS_SM,
    fontFamily: FONT_SEMIBOLD,
    letterSpacing: 0.3,
  },
});
