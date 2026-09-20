import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { CATEGORY_LABELS, IdentifyResult, IdentifyStatus } from '../lib/types';
import {
  formatIdentifyLog,
  IDENTIFY_STAGE_ORDER,
  identifyProgressCeiling,
  identifyProgressFloor,
  identifyStageIndex,
  identifyStatusCopy,
} from '../lib/identifyCopy';
import { AnalysisRegion, PROBE_REGIONS, VisionAnalysisPanel } from './VisionAnalysisPanel';
import {
  ACCENT,
  BORDER,
  FONT_BOLD,
  FONT_MEDIUM,
  FONT_SEMIBOLD,
  FONT_SERIF_SEMIBOLD,
  FS_SM,
  SURFACE,
  SURFACE_MUTED,
  TEXT_MUTED,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
} from '../lib/theme';

const useNativeDriver = Platform.OS !== 'web';
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Media row is full-bleed and sits flush with the screen: the analysis panel
// paints HUD chrome against its own edges, so nothing may overhang the clip.
const GAP = 8;
const CELL_W = (SCREEN_W - GAP) / 2;
const BAND_H = Math.min(Math.round(CELL_W * 1.82), Math.round(SCREEN_H * 0.5));
const FINISH_MS = 340;
const LOG_LIMIT = 2;

function validBbox(b: unknown): b is number[] {
  return Array.isArray(b) && b.length === 4 && b[2] > b[0] && b[3] > b[1];
}

function shorten(text: string, max = 26): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function BouncingDots() {
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    const loops = dots.map((value, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(value, { toValue: -5, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver }),
          Animated.timing(value, { toValue: 0, duration: 260, easing: Easing.in(Easing.quad), useNativeDriver }),
          Animated.delay((2 - i) * 160),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots]);
  return (
    <View style={styles.dotsRow}>
      {dots.map((value, i) => (
        <Animated.View key={i} style={[styles.dot, { transform: [{ translateY: value }] }]} />
      ))}
    </View>
  );
}

function ScanBeam({ width, height, active }: { width: number; height: number; active: boolean }) {
  const y = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      y.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(y, { toValue: 1, duration: 2400, easing: Easing.inOut(Easing.quad), useNativeDriver }),
        Animated.timing(y, { toValue: 0, duration: 2400, easing: Easing.inOut(Easing.quad), useNativeDriver }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, y]);
  const translateY = y.interpolate({ inputRange: [0, 1], outputRange: [-36, height] });
  return (
    <Animated.View pointerEvents="none" style={[styles.scanWrap, { width, height }]}>
      <Animated.View style={[styles.scanBeam, { width, transform: [{ translateY }] }]}>
        <LinearGradient
          colors={['rgba(156,107,65,0)', 'rgba(156,107,65,0.55)', 'rgba(156,107,65,0)']}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </Animated.View>
  );
}

type JobLog = { at?: string; message: string; status?: IdentifyStatus };
type JobStep = { status: IdentifyStatus; at: string; note?: string };

interface InspectingViewProps {
  uri: string;
  isVideo: boolean;
  status: IdentifyStatus;
  items: IdentifyResult['items'];
  steps?: JobStep[];
  logs?: JobLog[];
  keyframes?: string[];
  done: boolean;
  onFinished: () => void;
}

export const InspectingView: React.FC<InspectingViewProps> = ({
  uri,
  isVideo,
  status,
  items,
  steps,
  logs,
  done,
  onFinished,
}) => {
  // ----- opening flash + content reveal -----
  const flash = useRef(new Animated.Value(1)).current;
  const contentIn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(flash, { toValue: 0, duration: 440, easing: Easing.out(Easing.cubic), useNativeDriver }).start();
    Animated.timing(contentIn, { toValue: 1, duration: 460, delay: 150, easing: Easing.out(Easing.cubic), useNativeDriver }).start();
  }, [flash, contentIn]);

  // ----- video player (created only for video, else null source) -----
  const player = useVideoPlayer(isVideo ? uri : null, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  useEffect(() => {
    if (!isVideo) return;
    player.loop = true;
    player.muted = true;
    player.play();
  }, [isVideo, uri, player]);

  // ----- right column: regions the analysis panel walks through -----
  // Until the pipeline reports real detections the panel probes a generic
  // top-down sweep of the body; once garments land it switches to their real
  // boxes and never shrinks back to a shorter list mid-run.
  const detected = useMemo<AnalysisRegion[]>(
    () =>
      items
        .map((i) => i.garment)
        .filter((g) => validBbox(g.bbox))
        .slice()
        .sort((a, b) => a.bbox[1] - b.bbox[1])
        .map((g) => ({
          id: g.id,
          kind: g.category,
          label: shorten(g.description || CATEGORY_LABELS[g.category] || g.category, 22),
          confidence: g.confidence ?? 0.9,
          bbox: g.bbox,
        })),
    [items],
  );

  const [regions, setRegions] = useState<AnalysisRegion[]>(PROBE_REGIONS);
  useEffect(() => {
    if (detected.length === 0) return;
    setRegions((prev) => {
      const real = prev !== PROBE_REGIONS;
      return real && prev.length >= detected.length ? prev : detected;
    });
  }, [detected]);

  const [regionsVersion, setRegionsVersion] = useState(0);
  useEffect(() => {
    setRegionsVersion((v) => v + 1);
  }, [regions]);

  const [inspecting, setInspecting] = useState(false);
  const inspectScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.spring(inspectScale, {
      toValue: inspecting ? 1.06 : 1,
      friction: 7,
      useNativeDriver,
    }).start();
  }, [inspecting, inspectScale]);

  const [focused, setFocused] = useState<AnalysisRegion | null>(null);
  const mediaType = isVideo ? 'video' : 'image';
  const latestNote = steps?.[steps.length - 1]?.note;
  const headline = focused
    ? `Matching ${shorten(focused.label)}`
    : identifyStatusCopy(status, mediaType, latestNote) || 'Analyzing photo';

  const [shownHeadline, setShownHeadline] = useState(headline);
  const textOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (headline === shownHeadline) return;
    let alive = true;
    Animated.timing(textOpacity, { toValue: 0, duration: 160, easing: Easing.in(Easing.quad), useNativeDriver }).start(
      ({ finished }) => {
        if (!finished || !alive) return;
        setShownHeadline(headline);
        Animated.timing(textOpacity, { toValue: 1, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver }).start();
      },
    );
    return () => {
      alive = false;
    };
  }, [headline, shownHeadline, textOpacity]);

  const stageIndex = identifyStageIndex(status);
  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current === status) return;
    prevStatus.current = status;
    Haptics.selectionAsync().catch(() => {});
  }, [status]);

  // ----- progress bar: jumps to the real stage, then crawls inside it -----
  const progress = useRef(new Animated.Value(0)).current;
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const id = progress.addListener(({ value }) => setPct(Math.round(value * 100)));
    return () => progress.removeListener(id);
  }, [progress]);

  useEffect(() => {
    if (done) return;
    const floor = identifyProgressFloor(status);
    const ceil = identifyProgressCeiling(status);
    let crawl: Animated.CompositeAnimation | null = null;
    const jump = Animated.timing(progress, {
      toValue: floor,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    jump.start(({ finished }) => {
      if (!finished) return;
      crawl = Animated.timing(progress, {
        toValue: ceil,
        duration: 16000,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      });
      crawl.start();
    });
    return () => {
      jump.stop();
      crawl?.stop();
    };
  }, [status, done, progress]);

  useEffect(() => {
    if (!done) return;
    const finish = Animated.timing(progress, {
      toValue: 1,
      duration: FINISH_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    finish.start(({ finished }) => {
      if (finished) onFinished();
    });
    return () => finish.stop();
  }, [done, progress, onFinished]);
  const fillWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  const onFocusRegion = (region: AnalysisRegion | null) => {
    setFocused(region);
    if (region) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  };

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.body, { opacity: contentIn }]}>
        <View style={styles.mediaClip}>
          <View style={styles.row}>
            <Pressable
              onPressIn={() => setInspecting(true)}
              onPressOut={() => setInspecting(false)}
              style={styles.cell}
              accessibilityRole="button"
              accessibilityLabel="Hold to inspect the original photo"
            >
              <Animated.View style={{ transform: [{ scale: inspectScale }] }}>
                {isVideo ? (
                  <VideoView player={player} style={styles.media} contentFit="cover" nativeControls={false} playsInline />
                ) : (
                  <Image source={{ uri }} style={styles.media} resizeMode="cover" />
                )}
              </Animated.View>
              <ScanBeam width={CELL_W} height={BAND_H} active={!inspecting && !done} />
              {inspecting ? (
                <View style={styles.inspectBadge}>
                  <Text style={styles.inspectBadgeText}>INSPECT</Text>
                </View>
              ) : null}
            </Pressable>

            <View style={styles.gap} />

            <View style={styles.cell}>
              <VisionAnalysisPanel
                uri={uri}
                isVideo={isVideo}
                width={CELL_W}
                height={BAND_H}
                regions={regions}
                status={status}
                regionsVersion={regionsVersion}
                player={isVideo ? player : undefined}
                jobLogs={logs}
                focusedId={focused?.id}
                onFocusRegion={onFocusRegion}
              />
            </View>
          </View>
        </View>

        <View style={styles.footer}>
          <View style={styles.progressMeta}>
            <Text style={styles.progressLabel}>{done ? 'Ready' : 'Progress'}</Text>
            <Text style={styles.progressPct}>{pct}%</Text>
          </View>
          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, { width: fillWidth }]} />
          </View>

          <View style={styles.stageRow}>
            {IDENTIFY_STAGE_ORDER.map((stage, index) => {
              const active = index <= stageIndex;
              const current = index === stageIndex && !done;
              return (
                <View
                  key={stage}
                  style={[styles.stagePip, active && styles.stagePipActive, current && styles.stagePipCurrent]}
                />
              );
            })}
          </View>

          <View style={styles.statusRow}>
            <Animated.Text style={[styles.statusText, { opacity: textOpacity }]} numberOfLines={2}>
              {shownHeadline}
            </Animated.Text>
            {done ? null : <BouncingDots />}
          </View>

          <Text style={styles.hint}>
            {detected.length > 0
              ? 'Hold the photo to inspect · Tap a piece to follow it'
              : 'Hold the photo to inspect'}
          </Text>
        </View>
      </Animated.View>

      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.flash, { opacity: flash }]} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    width: '100%',
    alignItems: 'center',
  },
  mediaClip: {
    width: SCREEN_W,
    height: BAND_H,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    width: SCREEN_W,
    height: BAND_H,
  },
  gap: {
    width: GAP,
  },
  cell: {
    width: CELL_W,
    height: BAND_H,
    overflow: 'hidden',
    backgroundColor: SURFACE_MUTED,
  },
  media: {
    width: CELL_W,
    height: BAND_H,
  },
  scanWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
  },
  scanBeam: {
    height: 36,
  },
  inspectBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: 'rgba(43,32,24,0.72)',
  },
  inspectBadgeText: {
    fontFamily: FONT_BOLD,
    fontSize: 9,
    letterSpacing: 1.2,
    color: '#FBF3E7',
  },
  footer: {
    width: SCREEN_W - 48,
  },
  progressMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: 16,
    marginBottom: 6,
  },
  progressLabel: {
    fontFamily: FONT_BOLD,
    fontSize: 10.5,
    letterSpacing: 1.3,
    color: ACCENT,
    textTransform: 'uppercase',
  },
  progressPct: {
    fontFamily: FONT_SEMIBOLD,
    fontSize: FS_SM,
    color: TEXT_SECONDARY,
    fontVariant: ['tabular-nums'],
  },
  progressTrack: {
    width: '100%',
    height: 5,
    borderRadius: 999,
    backgroundColor: SURFACE_MUTED,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: ACCENT,
  },
  stageRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 12,
  },
  stagePip: {
    flex: 1,
    height: 3,
    borderRadius: 99,
    backgroundColor: SURFACE_MUTED,
  },
  stagePipActive: {
    backgroundColor: 'rgba(156,107,65,0.45)',
  },
  stagePipCurrent: {
    backgroundColor: ACCENT,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 32,
  },
  statusText: {
    fontFamily: FONT_SERIF_SEMIBOLD,
    fontSize: 22,
    color: TEXT_PRIMARY,
    letterSpacing: 0.2,
    textAlign: 'center',
    flexShrink: 1,
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginLeft: 4,
    marginBottom: 4,
    gap: 3,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: ACCENT,
  },
  hint: {
    marginTop: 14,
    fontFamily: FONT_MEDIUM,
    fontSize: 11,
    color: TEXT_MUTED,
    textAlign: 'center',
  },
  flash: {
    backgroundColor: '#FFFFFF',
  },
});
