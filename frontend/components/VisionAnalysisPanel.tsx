import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoPlayer, VideoView } from 'expo-video';
import { ACCENT, BACKGROUND } from '../lib/theme';
import { IdentifyStatus } from '../lib/types';

// The panel is the "machine's eye" beside the raw clip: the same media, but
// zoomed region by region with a box locked onto each garment while a log of
// the real pipeline calls streams underneath.

const FONT_MONO = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}) as string;

const HUD_DIM = 'rgba(247, 240, 228, 0.34)';
const HUD_TEXT = 'rgba(247, 240, 228, 0.72)';
const HUD_BRIGHT = BACKGROUND;
const LOCK_GLOW = 'rgba(156, 107, 65, 0.9)';

const SEEK_MS = 760;
const RELEASE_MS = 340;
const DWELL_MS = 2200;
const LOCK_AT_MS = 880;
const TICK_MS = 140;

const BRACKET = 13;
const SCAN_BAND = 30;

// Keep-out zones for the detection chip: the header strip and the log stack.
const HEADER_SAFE = 26;
const FOOTER_SAFE = 62;
const CHIP_H = 22;
const CHIP_W = 140;

export type AnalysisRegion = {
  id: string;
  /** Short mono tag shown inside the reticle, e.g. `torso`. */
  kind: string;
  /** Human label shown on the chip once the box locks. */
  label: string;
  confidence: number;
  bbox: number[];
};

// Used until the pipeline reports real detections. These are deliberately
// broad, shallow-zoom sweeps down the centre of the frame: we don't know where
// the subject is yet, so a wide search band always overlaps them. The hard
// zoom-and-lock is saved for real bboxes, where the coordinates are earned.
export const PROBE_REGIONS: AnalysisRegion[] = [
  { id: 'probe-head', kind: 'head', label: 'Region of interest', confidence: 0.61, bbox: [0.26, 0.12, 0.74, 0.4] },
  { id: 'probe-torso', kind: 'torso', label: 'Region of interest', confidence: 0.74, bbox: [0.2, 0.33, 0.8, 0.63] },
  { id: 'probe-legs', kind: 'legs', label: 'Region of interest', confidence: 0.7, bbox: [0.22, 0.56, 0.78, 0.86] },
  { id: 'probe-feet', kind: 'feet', label: 'Region of interest', confidence: 0.66, bbox: [0.26, 0.76, 0.74, 1] },
];

// The headline below the panel already narrates the job in plain English, so
// the HUD speaks the other register: the actual calls behind that sentence.
function machineLine(message?: string, status?: IdentifyStatus): string {
  const m = String(message || '').toLowerCase();
  if (/frame|clip|keyframe/.test(m)) return 'ffmpeg → keyframes';
  if (/found|piece|outfit/.test(m)) return 'seescene.detect()';
  if (/up close|garment/.test(m)) return 'seechip.embed(crop)';
  if (/listing|result/.test(m)) return 'shopify.fanout()';
  if (/search|shop/.test(m)) return 'retrieve.query()';
  if (/compar|match/.test(m)) return 'visualjudge(crop,·)';
  if (/rank|best/.test(m)) return 'rank(visual+text)';
  return (status && STATUS_LOG[status]) || 'pipeline.step()';
}

const STATUS_LOG: Record<IdentifyStatus, string> = {
  queued: 'job.accept()',
  ingesting: 'ffmpeg → keyframes',
  seeing: 'seescene.detect()',
  detailing: 'seechip.embed(crop)',
  sourcing: 'shopify.fanout(x12)',
  judging: 'visualjudge(crop,·)',
  retrying: 'browserbase.reverse()',
  ranking: 'rank(visual+text)',
  done: 'resolved ✓',
  error: 'retry queued',
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

type Pose = {
  scale: number;
  tx: number;
  ty: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

// Where the media must sit — and where the bbox lands on screen — for the
// region to fill most of the panel. Both are derived from the same numbers so
// the box tracks the zoom exactly instead of drifting behind it.
function poseFor(bbox: number[], W: number, H: number): { wide: Pose; near: Pose } {
  const x1 = clamp(bbox[0], 0, 1);
  const y1 = clamp(bbox[1], 0, 1);
  const x2 = clamp(bbox[2], 0, 1);
  const y2 = clamp(bbox[3], 0, 1);
  const bw = Math.max(x2 - x1, 0.05);
  const bh = Math.max(y2 - y1, 0.05);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;

  // A wide region only earns a gentle push-in; a small, confident bbox earns
  // the full zoom. The floor stays above 1 so every region still moves.
  const scale = clamp(Math.min(0.6 / bw, 0.6 / bh), 1.15, 3.1);
  const maxTx = ((scale - 1) * W) / 2;
  const maxTy = ((scale - 1) * H) / 2;
  const tx = clamp(scale * (0.5 - cx) * W, -maxTx, maxTx);
  const ty = clamp(scale * (0.5 - cy) * H, -maxTy, maxTy);

  const sx = (u: number) => W / 2 + scale * (u - 0.5) * W + tx;
  const sy = (v: number) => H / 2 + scale * (v - 0.5) * H + ty;

  return {
    wide: { scale: 1, tx: 0, ty: 0, left: x1 * W, top: y1 * H, width: bw * W, height: bh * H },
    near: { scale, tx, ty, left: sx(x1), top: sy(y1), width: sx(x2) - sx(x1), height: sy(y2) - sy(y1) },
  };
}

// Stable per-region scatter so the feature dots don't reshuffle on re-render.
function featurePoints(seed: string, count: number) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rnd = () => {
    h += 0x6d2b79f5;
    let x = Math.imul(h ^ (h >>> 15), 1 | h);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => ({ x: 0.1 + rnd() * 0.8, y: 0.08 + rnd() * 0.84 }));
}

const MediaLayer = React.memo(function MediaLayer({
  uri,
  isVideo,
  width,
  height,
  sharedPlayer,
}: {
  uri: string;
  isVideo: boolean;
  width: number;
  height: number;
  sharedPlayer?: VideoPlayer;
}) {
  // expo-video keeps every view bound to one player frame-synchronised, so
  // reusing the source clip's player is what makes this read as the same
  // moment seen twice rather than two clips drifting apart.
  const ownPlayer = useVideoPlayer(isVideo && !sharedPlayer ? uri : null, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  const player = sharedPlayer ?? ownPlayer;

  if (!isVideo) {
    return <Image source={{ uri }} style={{ width, height }} resizeMode="cover" />;
  }
  return (
    <VideoView
      player={player}
      style={{ width, height }}
      contentFit="cover"
      nativeControls={false}
      playsInline
    />
  );
});

function Brackets({ progress, color }: { progress: Animated.Value; color: string }) {
  const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [1.9, 1] });
  const corners = [
    { top: -1, left: -1, borderTopWidth: 2, borderLeftWidth: 2 },
    { top: -1, right: -1, borderTopWidth: 2, borderRightWidth: 2 },
    { bottom: -1, left: -1, borderBottomWidth: 2, borderLeftWidth: 2 },
    { bottom: -1, right: -1, borderBottomWidth: 2, borderRightWidth: 2 },
  ];
  return (
    <>
      {corners.map((c, i) => (
        <Animated.View
          key={i}
          style={[
            { position: 'absolute', width: BRACKET, height: BRACKET, borderColor: color },
            c,
            { opacity: progress, transform: [{ scale }] },
          ]}
        />
      ))}
    </>
  );
}

interface VisionAnalysisPanelProps {
  uri: string;
  isVideo: boolean;
  width: number;
  height: number;
  regions: AnalysisRegion[];
  status: IdentifyStatus;
  /** Bumped when the region list is replaced by real detections. */
  regionsVersion: number;
  jobLogs?: Array<{ message: string; status?: IdentifyStatus }>;
  focusedId?: string;
  onFocusRegion?: (region: AnalysisRegion | null) => void;
  /** The source clip's player, so both feeds show the same frame. */
  player?: VideoPlayer;
}

export const VisionAnalysisPanel: React.FC<VisionAnalysisPanelProps> = ({
  uri,
  isVideo,
  width: W,
  height: H,
  regions,
  status,
  regionsVersion,
  jobLogs,
  focusedId,
  onFocusRegion,
  player,
}) => {
  const list = regions.length > 0 ? regions : PROBE_REGIONS;
  const [idx, setIdx] = useState(0);
  const [locked, setLocked] = useState(false);
  const [tick, setTick] = useState(0);
  const pinnedRef = useRef(false);

  const focusedIndex = focusedId ? list.findIndex((item) => item.id === focusedId) : -1;
  const region = list[(focusedIndex >= 0 ? focusedIndex : idx) % list.length];
  const { wide, near } = useMemo(() => poseFor(region.bbox, W, H), [region, W, H]);
  const points = useMemo(() => featurePoints(region.id, 8), [region.id]);

  // ----- one clock drives the zoom and the reticle so they stay welded -----
  const t = useRef(new Animated.Value(0)).current;
  const boxIn = useRef(new Animated.Value(0)).current;
  const bracketIn = useRef(new Animated.Value(0)).current;
  const scan = useRef(new Animated.Value(0)).current;
  const dots = useRef(new Animated.Value(0)).current;
  const chipIn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    t.setValue(0);
    boxIn.setValue(0);
    bracketIn.setValue(0);
    scan.setValue(0);
    dots.setValue(0);
    chipIn.setValue(0);
    setLocked(false);

    Animated.parallel([
      Animated.timing(t, { toValue: 1, duration: SEEK_MS, easing: Easing.inOut(Easing.cubic), useNativeDriver: false }),
      Animated.timing(boxIn, { toValue: 1, duration: 420, easing: Easing.out(Easing.quad), useNativeDriver: false }),
    ]).start(({ finished }) => {
      if (!finished || cancelled) return;

      Animated.timing(bracketIn, { toValue: 1, duration: 280, easing: Easing.out(Easing.back(2.2)), useNativeDriver: false }).start();
      Animated.timing(scan, { toValue: 1, duration: 640, easing: Easing.inOut(Easing.quad), useNativeDriver: false }).start();
      Animated.timing(dots, { toValue: 1, duration: 560, delay: 170, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();

      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          setLocked(true);
          Animated.timing(chipIn, { toValue: 1, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
        }, LOCK_AT_MS),
      );

      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          if (pinnedRef.current) return;
          Animated.parallel([
            Animated.timing(t, { toValue: 0, duration: RELEASE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: false }),
            Animated.timing(boxIn, { toValue: 0, duration: RELEASE_MS - 60, useNativeDriver: false }),
            Animated.timing(chipIn, { toValue: 0, duration: 200, useNativeDriver: false }),
          ]).start(({ finished: done }) => {
            if (done && !cancelled && !pinnedRef.current) setIdx((v) => v + 1);
          });
        }, DWELL_MS),
      );
    });

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [idx, regionsVersion, W, H, t, boxIn, bracketIn, scan, dots, chipIn]);

  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // ----- machine-register feed -----
  // The headline below the panel narrates the job in English, so the HUD keeps
  // the other half: a rolling ledger of the boxes already taken, with the call
  // running right now pinned to the prompt line underneath them.
  const [ledger, setLedger] = useState<string[]>([]);
  useEffect(() => {
    if (!locked) return;
    const fmt = (n: number) => n.toFixed(2).replace(/^0/, '');
    const [x1, y1, x2, y2] = region.bbox;
    const line = `bbox ${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)}`;
    setLedger((prev) => (prev[prev.length - 1] === line ? prev : [...prev, line].slice(-2)));
  }, [locked, region]);

  const lastJobLog = jobLogs && jobLogs.length > 0 ? jobLogs[jobLogs.length - 1] : undefined;
  const hudLogs = useMemo(
    () => [...ledger, machineLine(lastJobLog?.message, lastJobLog?.status ?? status)],
    [ledger, lastJobLog, status],
  );

  const pinRegion = (index: number) => {
    const next = list[index];
    if (!next) return;
    const currentIndex = focusedIndex >= 0 ? focusedIndex : idx % list.length;
    const already = pinnedRef.current && currentIndex === index;
    if (already) {
      pinnedRef.current = false;
      onFocusRegion?.(null);
      return;
    }
    pinnedRef.current = true;
    setIdx(index);
    onFocusRegion?.(next);
  };

  const boxColor = locked ? HUD_BRIGHT : HUD_TEXT;
  const shownConfidence = locked
    ? region.confidence
    : clamp(0.38 + ((tick % 9) * 0.045 + (idx % 3) * 0.02), 0, 0.93);

  // The chip has to dodge the header and the log stack, so it only sits below
  // the reticle when there is clear room; otherwise it rides above it.
  const chipFloor = H - FOOTER_SAFE - CHIP_H;
  const belowTop = near.top + near.height + 7;
  const chipBelow = belowTop <= chipFloor;
  const chipTop = chipBelow ? belowTop : clamp(near.top - CHIP_H - 5, HEADER_SAFE, chipFloor);
  const frameNo = String(1024 + tick * 2).slice(-4);

  const scaleI = t.interpolate({ inputRange: [0, 1], outputRange: [1, near.scale] });
  const txI = t.interpolate({ inputRange: [0, 1], outputRange: [0, near.tx] });
  const tyI = t.interpolate({ inputRange: [0, 1], outputRange: [0, near.ty] });
  const leftI = t.interpolate({ inputRange: [0, 1], outputRange: [wide.left, near.left] });
  const topI = t.interpolate({ inputRange: [0, 1], outputRange: [wide.top, near.top] });
  const widthI = t.interpolate({ inputRange: [0, 1], outputRange: [wide.width, near.width] });
  const heightI = t.interpolate({ inputRange: [0, 1], outputRange: [wide.height, near.height] });

  const scanY = scan.interpolate({ inputRange: [0, 1], outputRange: [-SCAN_BAND, near.height] });
  const scanOpacity = scan.interpolate({ inputRange: [0, 0.12, 0.85, 1], outputRange: [0, 1, 1, 0] });

  return (
    <View style={[styles.panel, { width: W, height: H }]}>
      <Animated.View
        style={{
          width: W,
          height: H,
          transform: [{ translateX: txI }, { translateY: tyI }, { scale: scaleI }],
        }}
      >
        <MediaLayer uri={uri} isVideo={isVideo} width={W} height={H} sharedPlayer={player} />
      </Animated.View>

      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.tint]} />
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(24,16,9,0.5)', 'rgba(24,16,9,0)', 'rgba(24,16,9,0.66)']}
        locations={[0, 0.34, 1]}
        style={StyleSheet.absoluteFill}
      />

      {/* fixed camera furniture: corner ticks and a centre crosshair */}
      <View pointerEvents="none" style={[styles.tick, { top: 8, left: 8, borderTopWidth: 1, borderLeftWidth: 1 }]} />
      <View pointerEvents="none" style={[styles.tick, { top: 8, right: 8, borderTopWidth: 1, borderRightWidth: 1 }]} />
      <View pointerEvents="none" style={[styles.tick, { bottom: 8, left: 8, borderBottomWidth: 1, borderLeftWidth: 1 }]} />
      <View pointerEvents="none" style={[styles.tick, { bottom: 8, right: 8, borderBottomWidth: 1, borderRightWidth: 1 }]} />

      {/* the tracking reticle */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.box,
          { left: leftI, top: topI, width: widthI, height: heightI, opacity: boxIn, borderColor: boxColor },
          locked && styles.boxLocked,
        ]}
      >
        <Brackets progress={bracketIn} color={boxColor} />

        <Animated.View style={[styles.scanBand, { transform: [{ translateY: scanY }], opacity: scanOpacity }]}>
          <LinearGradient
            colors={['rgba(247,240,228,0)', 'rgba(247,240,228,0.42)']}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>

        {points.map((p, i) => {
          const start = i / (points.length + 2);
          return (
            <Animated.View
              key={i}
              style={[
                styles.point,
                {
                  left: `${p.x * 100}%`,
                  top: `${p.y * 100}%`,
                  opacity: dots.interpolate({
                    inputRange: [start, Math.min(start + 0.3, 1)],
                    outputRange: [0, 0.85],
                    extrapolate: 'clamp',
                  }),
                },
              ]}
            />
          );
        })}

        <Text style={styles.kind} numberOfLines={1}>
          {region.kind}
        </Text>
      </Animated.View>

      {/* detection chip pinned just outside the reticle */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.chip,
          {
            opacity: chipIn,
            transform: [{ translateY: chipIn.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
          },
          { top: chipTop, left: clamp(near.left, 10, Math.max(10, W - CHIP_W)) },
        ]}
      >
        <Text style={styles.chipLabel} numberOfLines={1}>
          {region.label}
        </Text>
        <Text style={styles.chipScore}>{Math.round(shownConfidence * 100)}%</Text>
      </Animated.View>

      {/* header */}
      <View pointerEvents="none" style={styles.header}>
        <LiveDot />
        <Text style={styles.headerText}>SEESCENE</Text>
        <View style={styles.headerSpacer} />
        <Text style={styles.headerText}>FRM {frameNo}</Text>
      </View>

      {/* tap the frame to pin/unpin the current region */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => pinRegion(focusedIndex >= 0 ? focusedIndex : idx % list.length)}
        accessibilityRole="button"
        accessibilityLabel="Tap to pin this garment"
      />

      {/* footer: pipeline log + roi progress */}
      <View style={[styles.footer, { pointerEvents: 'box-none' }]}>
        {hudLogs.map((line, i) => (
          <Text
            key={`${line}-${i}`}
            style={[styles.logLine, { opacity: 0.3 + (i / Math.max(hudLogs.length - 1, 1)) * 0.65 }]}
            numberOfLines={1}
          >
            {i === hudLogs.length - 1 ? `› ${line}` : `  ${line}`}
          </Text>
        ))}
        <View style={styles.roiRow}>
          {list.map((r, i) => {
            const active = i === (focusedIndex >= 0 ? focusedIndex : idx % list.length);
            return (
              <Pressable
                key={r.id}
                onPress={() => pinRegion(i)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Inspect ${r.label}`}
                style={[styles.roiPip, active && styles.roiPipActive]}
              />
            );
          })}
          <Text style={styles.roiCount}>
            ROI {(focusedIndex >= 0 ? focusedIndex : idx % list.length) + 1}/{list.length}
          </Text>
        </View>
      </View>
    </View>
  );
};

function LiveDot() {
  const pulse = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 620, easing: Easing.out(Easing.quad), useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0.3, duration: 620, easing: Easing.in(Easing.quad), useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return <Animated.View style={[styles.liveDot, { opacity: pulse }]} />;
}

const styles = StyleSheet.create({
  panel: {
    overflow: 'hidden',
    backgroundColor: '#1A120A',
  },
  tint: {
    backgroundColor: 'rgba(26, 18, 10, 0.26)',
  },
  tick: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderColor: HUD_DIM,
  },
  box: {
    position: 'absolute',
    borderWidth: 1,
    overflow: 'hidden',
  },
  boxLocked: {
    backgroundColor: 'rgba(247, 240, 228, 0.07)',
    shadowColor: ACCENT,
    shadowOpacity: 0.9,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  scanBand: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: SCAN_BAND,
  },
  point: {
    position: 'absolute',
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: HUD_BRIGHT,
  },
  kind: {
    position: 'absolute',
    left: 4,
    bottom: 3,
    fontFamily: FONT_MONO,
    fontSize: 8,
    letterSpacing: 0.6,
    color: HUD_TEXT,
  },
  chip: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: CHIP_W,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: LOCK_GLOW,
  },
  chipLabel: {
    flexShrink: 1,
    fontFamily: FONT_MONO,
    fontSize: 9,
    letterSpacing: 0.2,
    color: HUD_BRIGHT,
  },
  chipScore: {
    fontFamily: FONT_MONO,
    fontSize: 9,
    color: 'rgba(247, 240, 228, 0.75)',
  },
  header: {
    position: 'absolute',
    top: 10,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  headerSpacer: {
    flex: 1,
  },
  headerText: {
    fontFamily: FONT_MONO,
    fontSize: 8.5,
    letterSpacing: 1,
    color: HUD_TEXT,
  },
  liveDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: ACCENT,
  },
  footer: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 10,
    zIndex: 2,
  },
  logLine: {
    fontFamily: FONT_MONO,
    fontSize: 8.5,
    lineHeight: 12,
    letterSpacing: 0.2,
    color: HUD_BRIGHT,
  },
  roiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 7,
  },
  roiPip: {
    width: 7,
    height: 2,
    borderRadius: 1,
    backgroundColor: HUD_DIM,
  },
  roiPipActive: {
    backgroundColor: HUD_BRIGHT,
    width: 12,
  },
  roiCount: {
    marginLeft: 'auto',
    fontFamily: FONT_MONO,
    fontSize: 8,
    letterSpacing: 0.5,
    color: HUD_TEXT,
  },
});
