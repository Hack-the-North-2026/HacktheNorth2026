import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useIncomingShare } from 'expo-sharing';
import { startIdentifyJob } from '../lib/api';
import { setJobPreview } from '../lib/resultStore';
import { BACKGROUND } from '../lib/theme';

export default function ShareScreen() {
  const router = useRouter();
  const started = useRef(false);
  const [message, setMessage] = useState('Preparing your shared image…');
  const [failure, setFailure] = useState<string | null>(null);
  const {
    resolvedSharedPayloads,
    isResolving,
    error,
    clearSharedPayloads,
    refreshSharePayloads,
  } = useIncomingShare();

  useEffect(() => {
    if (isResolving || started.current) return;

    if (error) {
      setFailure(error.message || 'Fit Stealer could not read the shared image.');
      return;
    }

    const image = resolvedSharedPayloads.find(
      (payload) => payload.contentType === 'image' && payload.contentUri,
    );
    if (!image?.contentUri) {
      setFailure('Share one image with Fit Stealer to identify its clothing.');
      return;
    }

    started.current = true;
    setMessage('Uploading your fit…');
    startIdentifyJob(
      {
        uri: image.contentUri,
        fileName: image.originalName,
        mimeType: image.contentMimeType,
      },
      'ios_share',
    )
      .then((job) => {
        setJobPreview(job.job_id, image.contentUri!);
        clearSharedPayloads();
        router.replace(`/job/${job.job_id}`);
      })
      .catch((uploadError: unknown) => {
        started.current = false;
        setFailure(
          uploadError instanceof Error
            ? uploadError.message
            : 'Fit Stealer could not upload the shared image.',
        );
      });
  }, [
    clearSharedPayloads,
    error,
    isResolving,
    resolvedSharedPayloads,
    router,
  ]);

  const retry = () => {
    started.current = false;
    setFailure(null);
    setMessage('Preparing your shared image…');
    refreshSharePayloads();
  };

  return (
    <View style={styles.container}>
      {failure ? (
        <>
          <Text style={styles.title}>Couldn’t import this image</Text>
          <Text style={styles.subtitle}>{failure}</Text>
          <Pressable accessibilityRole="button" onPress={retry} style={styles.button}>
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => router.replace('/')}>
            <Text style={styles.cancel}>Back to Fit Stealer</Text>
          </Pressable>
        </>
      ) : (
        <>
          <ActivityIndicator size="large" color="#9C9CFF" />
          <Text style={styles.title}>Finding this fit</Text>
          <Text style={styles.subtitle}>{message}</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    backgroundColor: BACKGROUND,
  },
  title: {
    marginTop: 22,
    color: '#F5F5FA',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 10,
    color: '#8A8A99',
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  button: {
    marginTop: 28,
    paddingHorizontal: 24,
    paddingVertical: 13,
    borderRadius: 999,
    backgroundColor: '#6C63FF',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  cancel: {
    marginTop: 20,
    color: '#9C9CFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
