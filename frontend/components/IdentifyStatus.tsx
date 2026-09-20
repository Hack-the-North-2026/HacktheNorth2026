import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { IDENTIFY_STATUS_COPY, IdentifyStatus } from '../lib/types';
import { ACCENT, TEXT_PRIMARY, SURFACE_MUTED, BORDER, FONT_SEMIBOLD, FS_MD } from '../lib/theme';
import { identifyStatusCopy } from '../lib/identifyCopy';
import { IdentifyStatus } from '../lib/types';

const STEPS: IdentifyStatus[] = [
  'queued',
  'ingesting',
  'seeing',
  'detailing',
  'sourcing',
  'judging',
  'ranking',
];

export function IdentifyStatusView({
  status,
  mediaType = 'image',
  note,
}: {
  status: IdentifyStatus;
  mediaType?: 'image' | 'video';
  note?: string;
}) {
  const progressStatus = status === 'retrying' ? 'judging' : status;
  const currentIndex = Math.max(0, STEPS.indexOf(progressStatus));

  return (
    <View style={styles.wrap}>
      <ActivityIndicator color={ACCENT} size="large" />
      <Text style={styles.title}>{IDENTIFY_STATUS_COPY[status]}</Text>
      <View style={styles.steps}>
        {STEPS.map((step, index) => {
          const active = index <= currentIndex;
          return (
            <View key={step} style={[styles.dot, active ? styles.dotActive : styles.dotIdle]} />
          );
        })}
      </View>
      <View style={styles.skeletonCard}>
        <View style={styles.skeletonImage} />
        <View style={styles.skeletonBody}>
          <View style={styles.skeletonLineShort} />
          <View style={styles.skeletonLine} />
          <View style={styles.skeletonLineMid} />
        </View>
      </View>
      <View style={styles.skeletonCard}>
        <View style={styles.skeletonImage} />
        <View style={styles.skeletonBody}>
          <View style={styles.skeletonLineShort} />
          <View style={styles.skeletonLine} />
          <View style={styles.skeletonLineMid} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingTop: 8,
    paddingHorizontal: 24,
    paddingBottom: 8,
    gap: 16,
  },
  title: {
    color: TEXT_PRIMARY,
    fontSize: FS_MD,
    fontFamily: FONT_SEMIBOLD,
    textAlign: 'center',
  },
  steps: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotActive: {
    backgroundColor: ACCENT,
  },
  dotIdle: {
    backgroundColor: SURFACE_MUTED,
  },
  skeletonCard: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  skeletonImage: {
    width: 60,
    height: 60,
    borderRadius: 12,
    backgroundColor: SURFACE_MUTED,
  },
  skeletonBody: {
    flex: 1,
    marginLeft: 14,
    gap: 8,
    justifyContent: 'center',
  },
  skeletonLine: {
    height: 10,
    borderRadius: 6,
    backgroundColor: SURFACE_MUTED,
    width: '90%',
  },
  skeletonLineShort: {
    height: 10,
    borderRadius: 6,
    backgroundColor: SURFACE_MUTED,
    width: '30%',
  },
  skeletonLineMid: {
    height: 10,
    borderRadius: 6,
    backgroundColor: SURFACE_MUTED,
    width: '50%',
  },
});
