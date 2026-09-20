import React, { useRef, useState } from 'react';
import { StyleSheet, Text, View, Image, Animated, Alert, Platform, Pressable, Linking, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { startIdentifyJob, getIdentifyJob, isVideoUri } from '../lib/api';
import { IDENTIFY_POLL_DEADLINE_MS, timeoutIdentifyCopy } from '../lib/identifyCopy';
import { setJobPreview } from '../lib/resultStore';
import { IdentifyResult, IdentifyStatus } from '../lib/types';
import { InspectingView } from '../components/InspectingView';
import { RippleTransition } from '../components/RippleTransition';
import {
  BACKGROUND,
  TEXT_PRIMARY,
  TEXT_MUTED,
  SURFACE,
  BORDER,
  ACCENT,
  FONT_SEMIBOLD,
  FONT_BOLD,
  FONT_EXTRABOLD,
  FONT_SERIF_ITALIC,
  FS_SM,
} from '../lib/theme';

type Phase = 'idle' | 'scanning' | 'revealing';

const POLL_MS = 400;
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const RIPPLE_ORIGIN = { x: SCREEN_W / 2, y: SCREEN_H / 2 };

const HERO = require('../assets/steal-hero.webp');
const HERO_ASPECT = 991 / 2000;
const HERO_SCALE = 1.25;
const HERO_W = SCREEN_W * HERO_SCALE;
const DISPLAY = Math.min(Math.round(SCREEN_W * 0.165), 68);
const DISPLAY_FIT = Math.min(Math.round(SCREEN_W * 0.2), 82);

const useNativeDriver = Platform.OS !== 'web';

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>('idle');
  const [uri, setUri] = useState<string | null>(null);
  const [jobDone, setJobDone] = useState(false);
  const [scanJob, setScanJob] = useState<IdentifyResult | null>(null);
  const [keyframes, setKeyframes] = useState<string[]>([]);
  const [jobStatus, setJobStatus] = useState<IdentifyStatus>('queued');
  const [statusNote, setStatusNote] = useState<string | undefined>(undefined);
  const [mediaType, setMediaType] = useState<'image' | 'video'>('image');
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

  const runIdentify = async (asset: { uri: string; fileName?: string | null; mimeType?: string | null; file?: Blob | File | null }) => {
    setUri(asset.uri);
    setScanJob(null);
    setKeyframes([]);
    setJobStatus('queued');
    setStatusNote(undefined);
    setMediaType(isVideoUri(asset.uri, asset.mimeType) ? 'video' : 'image');
    setJobDone(false);
    setPhase('scanning');
    setIdleVisible(false);
    try {
      const job = await startIdentifyJob(asset);
      setJobPreview(job.job_id, asset.uri, {
        mediaType: isVideoUri(asset.uri, asset.mimeType) ? 'video' : 'image',
        mimeType: asset.mimeType,
      });
      // #region agent log
      fetch('http://127.0.0.1:7786/ingest/14f230d3-70c9-4ad3-a18f-383a84fda265',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'a21ccc'},body:JSON.stringify({sessionId:'a21ccc',runId:'pre-fix',hypothesisId:'C',location:'index.tsx:setJobPreview',message:'stored job preview uri',data:{jobId:job.job_id,uriScheme:asset.uri.slice(0,40),mimeType:asset.mimeType||null,fileName:asset.fileName||null,detectedVideo:isVideoUri(asset.uri,asset.mimeType)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      jobIdRef.current = job.job_id;
      setScanJob(job);
      setJobStatus(job.status);
      if (job.media_type) setMediaType(job.media_type);
      if (job.keyframes?.length) setKeyframes(job.keyframes);

      // Keep the inspecting view up until the job is actually finished —
      // starting the job only means it was accepted, not that a result exists.
      const started = Date.now();
      let latest = job;
      while (latest.status !== 'done' && latest.status !== 'error') {
        const kind = latest.media_type || (isVideoUri(asset.uri, asset.mimeType) ? 'video' : 'image');
        if (Date.now() - started > IDENTIFY_POLL_DEADLINE_MS) {
          throw new Error(timeoutIdentifyCopy(kind));
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        latest = await getIdentifyJob(job.job_id);
        setScanJob(latest);
        setJobStatus(latest.status);
        const latestNote = latest.steps?.[latest.steps.length - 1]?.note;
        if (latestNote) setStatusNote(latestNote);
        if (latest.media_type) setMediaType(latest.media_type);
        if (latest.keyframes && latest.keyframes.length > 0) {
          setKeyframes(latest.keyframes);
        }
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

  const openAccessibilitySettings = () => {
    Alert.alert(
      'Enable Fit Stealer',
      '1. Tap "Installed apps"\n2. Tap "Fit Stealer"\n3. Turn the switch ON\n4. Tap "Allow"',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Go to Settings',
          onPress: () => {
            // @ts-ignore – optional Android-only module
            import('expo-intent-launcher').then(IntentLauncher => {
              IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.ACCESSIBILITY_SETTINGS).catch(() => {
                Linking.openSettings();
              });
            }).catch(() => {
              Linking.openSettings();
            });
          }
        }
      ]
    );
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

  const isVideo = mediaType === 'video' || isVideoUri(uri);

  return (
    <View style={styles.container} >
      <Animated.View style={[styles.layer, { opacity: idleOpacity, pointerEvents: phase === 'idle' ? 'auto' : 'none' }]}>
        <Image
          source={HERO}
          style={[
            styles.hero,
            {
              width: HERO_W,
              height: HERO_W / HERO_ASPECT,
              left: (SCREEN_W - HERO_W) / 2,
              bottom: insets.bottom - 52,
            },
          ]}
          resizeMode="contain"
        />

        <View style={[styles.topBar, { top: Math.max(insets.top, 16) + 8 }]}>
          <Text style={styles.wordmark}>Fit Stealer</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Recently searched"
            onPress={() => router.push('/recent')}
            style={styles.recentButton}
          >
            <Ionicons name="time-outline" size={15} color={TEXT_PRIMARY} />
            <Text style={styles.recentLabel}>Recent</Text>
          </Pressable>
        </View>

        <View style={[styles.display, { top: Math.max(insets.top, 16) + 64 }]}>
          <Text style={styles.displayLine}>STEAL</Text>
          <Text style={styles.displayLine}>THE</Text>
          <Text style={styles.displayFit}>fit.</Text>
        </View>

        <View style={[styles.foot, { bottom: insets.bottom + 20 }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Steal a fit now"
            accessibilityHint="Pick a screenshot, or press and hold to use the camera"
            disabled={phase !== 'idle'}
            onPress={pickFromLibrary}
            onLongPress={takePhoto}
            delayLongPress={300}
            style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
          >
            <Text style={styles.ctaText}>Steal a fit now</Text>
            <Ionicons name="arrow-forward" size={20} color="#FBF3E7" />
          </Pressable>
          <Text style={styles.hint}>or press &amp; hold to shoot</Text>
          {Platform.OS === 'android' && (
            <Pressable
              onPress={openAccessibilitySettings}
              accessibilityLabel="Set up overlay bubble"
              accessibilityHint="Opens Accessibility Settings to enable the Fit Stealer overlay">
              <Text style={styles.overlayLink}>⚙ Set up overlay bubble</Text>
            </Pressable>
          )}
        </View>
      </Animated.View>

      <Animated.View style={[StyleSheet.absoluteFill, { opacity: scanOpacity, pointerEvents: phase === 'idle' ? 'none' : 'auto' }]}>
        {uri && phase !== 'idle' && (
          <InspectingView
            uri={uri}
            isVideo={isVideo}
            status={scanJob?.status ?? ('queued' as IdentifyStatus)}
            items={scanJob?.items ?? []}
            keyframes={scanJob?.keyframes}
            steps={scanJob?.steps}
            logs={scanJob?.logs}
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
    </View >
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BACKGROUND,
  },
  layer: {
    ...StyleSheet.absoluteFill,
  },
  hero: {
    position: 'absolute',
    zIndex: 0,
  },
  topBar: {
    position: 'absolute',
    left: 24,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 2,
  },
  wordmark: {
    color: TEXT_PRIMARY,
    fontSize: 16,
    fontFamily: FONT_BOLD,
    letterSpacing: 0.1,
  },
  recentButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 13,
    paddingVertical: 8,
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
  display: {
    position: 'absolute',
    left: 24,
    zIndex: 1,
  },
  displayLine: {
    color: TEXT_PRIMARY,
    fontFamily: FONT_EXTRABOLD,
    fontSize: DISPLAY,
    lineHeight: DISPLAY * 0.98,
    letterSpacing: -1,
  },
  displayFit: {
    color: ACCENT,
    fontFamily: FONT_SERIF_ITALIC,
    fontSize: DISPLAY_FIT,
    lineHeight: DISPLAY_FIT * 1.02,
    marginTop: 2,
    marginLeft: -2,
  },
  foot: {
    position: 'absolute',
    left: 20,
    right: 20,
    zIndex: 2,
    alignItems: 'center',
    gap: 12,
  },
  cta: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 20,
    borderRadius: 30,
    backgroundColor: ACCENT,
    shadowColor: ACCENT,
    shadowOpacity: 0.4,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  ctaPressed: {
    transform: [{ scale: 0.98 }],
    backgroundColor: '#8a5c36',
  },
  ctaText: {
    color: '#FBF3E7',
    fontSize: 19,
    fontFamily: FONT_BOLD,
    letterSpacing: 0.2,
  },
  hint: {
    color: TEXT_MUTED,
    fontSize: FS_SM,
    fontFamily: FONT_SEMIBOLD,
    letterSpacing: 0.2,
  },
  overlayLink: {
    color: ACCENT,
    fontSize: FS_SM,
    fontFamily: FONT_SEMIBOLD,
    letterSpacing: 0.2,
    marginTop: 2,
  },
});
