import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { IDENTIFY_STATUS_COPY, IdentifyStatus } from '../lib/types';

const STEPS: IdentifyStatus[] = ['queued', 'ingesting', 'seeing', 'sourcing', 'ranking'];

export function IdentifyStatusView({ status }: { status: IdentifyStatus }) {
  const currentIndex = Math.max(0, STEPS.indexOf(status));

  return (
    <View style={styles.wrap}>
      <ActivityIndicator color="#A5B4FC" size="large" />
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
    paddingTop: 24,
    gap: 16,
  },
  title: {
    color: '#E5E7EB',
    fontSize: 16,
    fontWeight: '600',
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
    backgroundColor: '#818CF8',
  },
  dotIdle: {
    backgroundColor: '#2E2E38',
  },
  skeletonCard: {
    width: '100%',
    flexDirection: 'row',
    backgroundColor: '#1C1C22',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2E2E38',
    overflow: 'hidden',
  },
  skeletonImage: {
    width: 100,
    height: 130,
    backgroundColor: '#2A2A33',
  },
  skeletonBody: {
    flex: 1,
    padding: 12,
    gap: 10,
    justifyContent: 'center',
  },
  skeletonLine: {
    height: 12,
    borderRadius: 6,
    backgroundColor: '#2A2A33',
    width: '90%',
  },
  skeletonLineShort: {
    height: 10,
    borderRadius: 6,
    backgroundColor: '#2A2A33',
    width: '30%',
  },
  skeletonLineMid: {
    height: 12,
    borderRadius: 6,
    backgroundColor: '#2A2A33',
    width: '50%',
  },
});
