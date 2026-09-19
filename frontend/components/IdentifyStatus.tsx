import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { IDENTIFY_STATUS_COPY, IdentifyStatus } from '../lib/types';

const STEPS: IdentifyStatus[] = ['queued', 'ingesting', 'seeing', 'sourcing', 'ranking'];

export function IdentifyStatusView({ status }: { status: IdentifyStatus }) {
  const currentIndex = Math.max(0, STEPS.indexOf(status));

  return (
    <View style={styles.wrap}>
      <ActivityIndicator color="#9C9CFF" size="large" />
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
    color: '#F5F5FA',
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
    backgroundColor: '#9C9CFF',
  },
  dotIdle: {
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  skeletonCard: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  skeletonImage: {
    width: 60,
    height: 60,
    borderRadius: 12,
    backgroundColor: '#12121A',
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
    backgroundColor: '#12121A',
    width: '90%',
  },
  skeletonLineShort: {
    height: 10,
    borderRadius: 6,
    backgroundColor: '#12121A',
    width: '30%',
  },
  skeletonLineMid: {
    height: 10,
    borderRadius: 6,
    backgroundColor: '#12121A',
    width: '50%',
  },
});
