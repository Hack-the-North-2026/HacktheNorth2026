import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { InspectingView } from '../components/InspectingView';
import { Garment, GarmentCategory, IdentifyResult, IdentifyStatus } from '../lib/types';
import { BACKGROUND } from '../lib/theme';

const URI = 'http://localhost:8081/preview.mp4';

function garment(
  id: string,
  category: GarmentCategory,
  description: string,
  confidence: number,
  bbox: [number, number, number, number],
): Garment {
  return {
    id,
    category,
    description,
    search_query: description,
    attributes: { color: 'white' },
    brand: null,
    brand_cues: [],
    confidence,
    bbox,
    chip_key: id,
    accessibility_line: description,
  };
}

const DETECTED: IdentifyResult['items'] = [
  { garment: garment('g1', 'accessory', 'Black sunglasses', 0.88, [0.41, 0.35, 0.57, 0.39]), matches: [] },
  { garment: garment('g2', 'shirt', 'Ivory linen shirt', 0.94, [0.33, 0.41, 0.64, 0.64]), matches: [] },
  { garment: garment('g3', 'pants', 'Wide-leg denim', 0.91, [0.33, 0.6, 0.63, 0.9]), matches: [] },
  { garment: garment('g4', 'shoes', 'Black loafers', 0.86, [0.34, 0.87, 0.61, 0.95]), matches: [] },
];

const DEMO: Array<{
  status: IdentifyStatus;
  logs: Array<{ at: string; message: string; status: IdentifyStatus }>;
}> = [
  {
    status: 'queued',
    logs: [{ at: 't0', message: 'Request received', status: 'queued' }],
  },
  {
    status: 'ingesting',
    logs: [
      { at: 't0', message: 'Request received', status: 'queued' },
      { at: 't1', message: 'Preparing the clip', status: 'ingesting' },
    ],
  },
  {
    status: 'seeing',
    logs: [
      { at: 't1', message: 'Preparing the clip', status: 'ingesting' },
      { at: 't2', message: 'Pulling clear frames', status: 'ingesting' },
      { at: 't3', message: 'Reading the outfit across frames', status: 'seeing' },
    ],
  },
  {
    status: 'detailing',
    logs: [
      { at: 't3', message: 'Reading the outfit across frames', status: 'seeing' },
      { at: 't4', message: 'Found 3 pieces — jacket, pants, and shoes', status: 'seeing' },
      { at: 't5', message: 'Reading each garment up close', status: 'detailing' },
    ],
  },
  {
    status: 'sourcing',
    logs: [
      { at: 't5', message: 'Reading each garment up close', status: 'detailing' },
      { at: 't6', message: 'Searching shops for black leather jacket', status: 'sourcing' },
      { at: 't7', message: 'Black leather jacket — 12 listings', status: 'sourcing' },
    ],
  },
  {
    status: 'judging',
    logs: [
      { at: 't7', message: 'Black leather jacket — 12 listings', status: 'sourcing' },
      { at: 't8', message: 'Comparing photos to black leather jacket', status: 'judging' },
      { at: 't9', message: 'Searching shops for cream trousers', status: 'sourcing' },
    ],
  },
];

export default function VisionPreview() {
  const [tick, setTick] = useState(0);
  const frame = DEMO[Math.min(tick, DEMO.length - 1)];

  useEffect(() => {
    if (tick >= DEMO.length - 1) return;
    const id = setTimeout(() => setTick((value) => value + 1), 2800);
    return () => clearTimeout(id);
  }, [tick]);

  return (
    <View style={styles.container}>
      <InspectingView
        uri={URI}
        isVideo
        status={frame.status}
        items={tick >= 3 ? DETECTED : []}
        logs={frame.logs}
        steps={frame.logs.map((entry) => ({ status: entry.status, at: entry.at, note: entry.message }))}
        done={false}
        onFinished={() => {}}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BACKGROUND },
});
