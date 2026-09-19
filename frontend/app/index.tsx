import React, { useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, Alert, Image } from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { identifyImage } from '../lib/api';
import { setLastResult } from '../lib/resultStore';

export default function HomeScreen() {
  const router = useRouter();
  const [uri, setUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const runIdentify = async (imageUri: string) => {
    setUri(imageUri);
    setLoading(true);
    try {
      const result = await identifyImage(imageUri);
      setLastResult(result);
      router.push('/results');
    } catch (error: any) {
      Alert.alert('Identify Failed', error.message || 'Could not process that screenshot.');
    } finally {
      setLoading(false);
    }
  };

  const pickFromLibrary = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow photo library access to upload a screenshot.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.9,
    });
    if (!result.canceled && result.assets[0]) {
      runIdentify(result.assets[0].uri);
    }
  };

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow camera access to capture a screenshot.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.9,
    });
    if (!result.canceled && result.assets[0]) {
      runIdentify(result.assets[0].uri);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Fit Stealer</Text>
      <Text style={styles.subtitle}>Upload a screenshot of an outfit to find it</Text>

      {uri && (
        <Image source={{ uri }} style={styles.preview} resizeMode="cover" />
      )}

      <View style={styles.actions}>
        <TouchableOpacity style={styles.button} onPress={pickFromLibrary} disabled={loading}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Upload Screenshot</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={takePhoto} disabled={loading}>
          <Text style={styles.secondaryButtonText}>Take Photo</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F0F12',
    padding: 24,
    justifyContent: 'center',
  },
  title: {
    fontSize: 36,
    fontWeight: '800',
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#A0A0AB',
    textAlign: 'center',
    marginBottom: 32,
  },
  preview: {
    width: '100%',
    height: 280,
    borderRadius: 16,
    marginBottom: 24,
    backgroundColor: '#1C1C22',
  },
  actions: {
    gap: 12,
  },
  button: {
    backgroundColor: '#6366F1',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: '#1C1C22',
    borderWidth: 1,
    borderColor: '#2E2E38',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: '#D1D5DB',
    fontSize: 16,
    fontWeight: '600',
  },
});
