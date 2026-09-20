import React, { useRef, useState } from 'react';
import { StyleSheet, Text, View, Animated, Alert, Platform, Pressable, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { startIdentifyJob } from '../lib/api';
import { setJobPreview } from '../lib/resultStore';
import { CaptureButton } from '../components/CaptureButton';
import { ScanningCircle } from '../components/ScanningCircle';

type Phase = 'idle' | 'scanning';

const useNativeDriver = Platform.OS !== 'web';

export default function HomeScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [uri, setUri] = useState<string | null>(null);

  const idleOpacity = useRef(new Animated.Value(1)).current;
  const scanOpacity = useRef(new Animated.Value(0)).current;

  const setPhaseAnimated = (next: Phase) => {
    setPhase(next);
    Animated.parallel([
      Animated.timing(idleOpacity, { toValue: next === 'idle' ? 1 : 0, duration: 320, useNativeDriver }),
      Animated.timing(scanOpacity, { toValue: next === 'scanning' ? 1 : 0, duration: 320, useNativeDriver }),
    ]).start();
  };

  const runIdentify = async (asset: { uri: string; fileName?: string | null; mimeType?: string | null }) => {
    setUri(asset.uri);
    setPhaseAnimated('scanning');
    try {
      const job = await startIdentifyJob(asset);
      setJobPreview(job.job_id, asset.uri);
      router.push(`/job/${job.job_id}`);
      setTimeout(() => setPhaseAnimated('idle'), 400);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Could not process that screenshot.';
      Alert.alert('Identify Failed', message);
      setPhaseAnimated('idle');
    }
  };

  const pickFromLibrary = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow photo library access to upload a screenshot.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
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
      Alert.alert('Permission needed', 'Allow camera access to capture a screenshot.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.9 });
    if (!result.canceled && result.assets[0]) {
      runIdentify(result.assets[0]);
    }
  };

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.layer, { opacity: idleOpacity, pointerEvents: phase === 'idle' ? 'auto' : 'none' }]}>
        <Text style={styles.title}>Fit Stealer</Text>
        <View style={styles.buttonWrap}>
          <CaptureButton disabled={phase !== 'idle'} onPress={pickFromLibrary} onLongPress={takePhoto} />
        </View>
        <Text style={styles.caption}>Tap to find this fit</Text>
        <Text style={styles.subCaption}>Hold to use the camera</Text>
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
        {uri && phase === 'scanning' && (
          <ScanningCircle uri={uri} size={176} durationMs={12000} />
        )}
        <Text style={styles.scanTitle}>Identifying your fit</Text>
        <Text style={styles.scanSubtitle}>Matching the pieces to real listings</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050509',
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
  title: {
    position: 'absolute',
    top: 76,
    fontSize: 20,
    fontWeight: '700',
    color: '#F5F5FA',
    letterSpacing: 0.3,
  },
  buttonWrap: {
    marginBottom: 28,
  },
  caption: {
    fontSize: 17,
    fontWeight: '600',
    color: '#F5F5FA',
    marginTop: 8,
  },
  subCaption: {
    fontSize: 13,
    color: '#5C5C6B',
    marginTop: 6,
  },
  scanTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#F5F5FA',
    marginTop: 4,
  },
  scanSubtitle: {
    fontSize: 13,
    color: '#5C5C6B',
  },
  overlayButton: {
    marginTop: 28,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(108,108,255,0.4)',
    backgroundColor: 'rgba(108,108,255,0.12)',
  },
  overlayButtonText: {
    color: '#9C9CFF',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});
