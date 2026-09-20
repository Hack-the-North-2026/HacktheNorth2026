import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, Image, Platform, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { IDENTIFY_STATUS_COPY, IdentifyResult, IdentifyStatus } from '../lib/types';
import {
  ACCENT,
  SURFACE_MUTED,
  TEXT_PRIMARY,
  EASE_OUT_EXPO,
  FONT_SERIF_SEMIBOLD,
  FS_LG,
} from '../lib/theme';

const useNativeDriver = Platform.OS !== 'web';
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Media row is full-bleed. A little extra width on each side gives the slow
// leftward drift room to move without ever exposing a gap at the edges.
const BLEED = 30;
const GAP = 8;
const STACK_GAP = 6;
const MAX_STACK = 4;
const ROW_W = SCREEN_W + BLEED * 2;
const CELL_W = (ROW_W - GAP) / 2;
const BAND_H = Math.min(Math.round(CELL_W * 1.82), Math.round(SCREEN_H * 0.5));
const DRIFT_MS = 26000;

// Progress bar shares the app's "crawl then finish" psychology: it never
// completes on its own — it decelerates toward a ceiling and only snaps to full
// once the real job reports done.
const CRAWL_CEILING = 0.9;
const CRAWL_MS = 18000;
const FINISH_MS = 340;

const TEXT_CYCLE_MS = 1900;

// Intrinsic size cache so each source image is measured only once.
const sizeCache = new Map<string, { w: number; h: number }>();

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function validBbox(b: unknown): b is number[] {
  return Array.isArray(b) && b.length === 4 && b[2] > b[0] && b[3] > b[1];
}

function shorten(text: string, max = 26): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

// Aspect-correct "cover" crop of a normalized [x1,y1,x2,y2] region. Uses the
// image's real pixel size so the garment is never stretched — it's scaled
// uniformly and clipped, exactly framing the isolated piece.
function GarmentCrop({ uri, bbox, width, height, pad = 0.05 }: {
  uri: string;
  bbox: number[];
  width: number;
  height: number;
  pad?: number;
}) {
  const [dims, setDims] = useState(() => sizeCache.get(uri) ?? null);

  useEffect(() => {
    if (dims) return;
    let alive = true;
    Image.getSize(
      uri,
      (w, h) => {
        if (!alive) return;
        sizeCache.set(uri, { w, h });
        setDims({ w, h });
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [uri, dims]);

  if (!dims) {
    return <View style={{ width, height, backgroundColor: SURFACE_MUTED }} />;
  }

  const x1 = clamp01(bbox[0] - pad);
  const y1 = clamp01(bbox[1] - pad);
  const x2 = clamp01(bbox[2] + pad);
  const y2 = clamp01(bbox[3] + pad);
  const cropW = Math.max((x2 - x1) * dims.w, 1);
  const cropH = Math.max((y2 - y1) * dims.h, 1);
  const scale = Math.max(width / cropW, height / cropH);
  const dispW = dims.w * scale;
  const dispH = dims.h * scale;
  const left = -(x1 * dims.w * scale) + (width - cropW * scale) / 2;
  const top = -(y1 * dims.h * scale) + (height - cropH * scale) / 2;

  return (
    <View style={{ width, height, overflow: 'hidden', backgroundColor: SURFACE_MUTED }}>
      <Image source={{ uri }} style={{ position: 'absolute', width: dispW, height: dispH, left, top }} />
    </View>
  );
}

function AnimatedIn({ delay, style, children }: { delay: number; style?: object; children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(12)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 420, delay, easing: Easing.out(Easing.cubic), useNativeDriver }),
      Animated.timing(translateY, { toValue: 0, duration: 420, delay, easing: Easing.out(Easing.cubic), useNativeDriver }),
    ]).start();
  }, [opacity, translateY, delay]);
  return <Animated.View style={[style, { opacity, transform: [{ translateY }] }]}>{children}</Animated.View>;
}

function Shimmer({ height }: { height: number }) {
  const pulse = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 720, easing: Easing.inOut(Easing.ease), useNativeDriver }),
        Animated.timing(pulse, { toValue: 0.5, duration: 720, easing: Easing.inOut(Easing.ease), useNativeDriver }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return <Animated.View style={{ width: '100%', height, backgroundColor: SURFACE_MUTED, opacity: pulse }} />;
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

interface InspectingViewProps {
  uri: string;
  isVideo: boolean;
  status: IdentifyStatus;
  items: IdentifyResult['items'];
  keyframes?: string[];
  done: boolean;
  onFinished: () => void;
}

export const InspectingView: React.FC<InspectingViewProps> = ({
  uri,
  isVideo,
  status,
  items,
  keyframes,
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

  // ----- slow, one-directional leftward drift of the media row -----
  const drift = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.timing(drift, { toValue: -BLEED, duration: DRIFT_MS, easing: Easing.linear, useNativeDriver });
    anim.start();
    return () => anim.stop();
  }, [drift]);

  // ----- video player (created only for video, else null source) -----
  const player = useVideoPlayer(isVideo ? uri : null, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  // #region agent log
  useEffect(() => {
    fetch('http://127.0.0.1:7786/ingest/14f230d3-70c9-4ad3-a18f-383a84fda265',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'a21ccc'},body:JSON.stringify({sessionId:'a21ccc',runId:'pre-fix',hypothesisId:'D',location:'InspectingView.tsx:player',message:'inspecting video player setup',data:{isVideo,uriScheme:uri?uri.slice(0,40):null,uriLooksLikeVideo:/\.(mp4|mov|webm|m4v|mkv)$/i.test((uri||'').split('?')[0]),uriIsBlob:Boolean(uri?.startsWith('blob:')),playerStatus:(player as {status?: string})?.status||null,playing:Boolean((player as {playing?: boolean})?.playing)},timestamp:Date.now()})}).catch(()=>{});
  }, [isVideo, uri, player]);
  // #endregion

  // ----- right column: the isolated garments the pipeline detected -----
  const garments = useMemo(
    () => (isVideo ? [] : items.map((i) => i.garment).filter((g) => validBbox(g.bbox)).slice(0, MAX_STACK)),
    [items, isVideo],
  );
  const videoFrames = useMemo(() => (isVideo ? (keyframes || []).slice(0, 3) : []), [isVideo, keyframes]);

  const rightStack = (() => {
    if (garments.length > 0) {
      const n = garments.length;
      const slotH = (BAND_H - (n - 1) * STACK_GAP) / n;
      return garments.map((g, idx) => (
        <AnimatedIn key={g.id} delay={idx * 150} style={{ marginTop: idx ? STACK_GAP : 0 }}>
          <GarmentCrop uri={uri} bbox={g.bbox} width={CELL_W} height={slotH} />
        </AnimatedIn>
      ));
    }
    if (videoFrames.length > 0) {
      const n = videoFrames.length;
      const slotH = (BAND_H - (n - 1) * STACK_GAP) / n;
      return videoFrames.map((frame, idx) => (
        <AnimatedIn key={`${frame.slice(0, 24)}-${idx}`} delay={idx * 150} style={{ marginTop: idx ? STACK_GAP : 0 }}>
          <Image source={{ uri: frame }} style={{ width: CELL_W, height: slotH }} resizeMode="cover" />
        </AnimatedIn>
      ));
    }
    // Nothing detected yet — quiet shimmer, never silhouettes or random crops.
    const slotH = (BAND_H - 2 * STACK_GAP) / 3;
    return [0, 1, 2].map((i) => (
      <View key={i} style={{ marginTop: i ? STACK_GAP : 0 }}>
        <Shimmer height={slotH} />
      </View>
    ));
  })();

  // ----- cycling status text -----
  const messages = useMemo(() => {
    const base = IDENTIFY_STATUS_COPY[status] || 'Analyzing photo';
    const list = [base];
    items.forEach(({ garment }) => {
      const label = garment.description || garment.category;
      if (label) list.push(`Finding matching ${shorten(label)}`);
    });
    return list;
  }, [status, items]);

  const [msgTick, setMsgTick] = useState(0);
  const textOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const timer = setInterval(() => {
      Animated.timing(textOpacity, { toValue: 0, duration: 220, easing: Easing.in(Easing.quad), useNativeDriver }).start(
        ({ finished }) => {
          if (!finished) return;
          setMsgTick((t) => t + 1);
          Animated.timing(textOpacity, { toValue: 1, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver }).start();
        },
      );
    }, TEXT_CYCLE_MS);
    return () => clearInterval(timer);
  }, [textOpacity]);
  const message = messages[msgTick % messages.length];

  // ----- progress bar -----
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (done) return;
    progress.setValue(0);
    const crawl = Animated.timing(progress, {
      toValue: CRAWL_CEILING,
      duration: CRAWL_MS,
      easing: Easing.bezier(...EASE_OUT_EXPO),
      useNativeDriver: false,
    });
    crawl.start();
    return () => crawl.stop();
  }, [done, progress]);
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

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.body, { opacity: contentIn }]}>
        <View style={styles.mediaClip}>
          <Animated.View style={[styles.row, { transform: [{ translateX: drift }] }]}>
            <View style={styles.cell}>
              {isVideo ? (
                <VideoView player={player} style={styles.media} contentFit="cover" nativeControls={false} />
              ) : (
                <Image source={{ uri }} style={styles.media} resizeMode="cover" />
              )}
            </View>

            <View style={styles.gap} />

            <View style={styles.cell}>{rightStack}</View>
          </Animated.View>
        </View>

        <View style={styles.footer}>
          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, { width: fillWidth }]} />
          </View>

          <View style={styles.statusRow}>
            <Animated.Text style={[styles.statusText, { opacity: textOpacity }]} numberOfLines={1}>
              {message}
            </Animated.Text>
            <BouncingDots />
          </View>
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
    width: ROW_W,
    height: BAND_H,
    marginLeft: -BLEED,
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
  footer: {
    width: SCREEN_W - 48,
  },
  progressTrack: {
    width: '100%',
    height: 5,
    borderRadius: 999,
    backgroundColor: SURFACE_MUTED,
    marginTop: 28,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: ACCENT,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
    minHeight: 28,
  },
  statusText: {
    fontFamily: FONT_SERIF_SEMIBOLD,
    fontSize: FS_LG,
    color: TEXT_PRIMARY,
    letterSpacing: 0.2,
    textAlign: 'center',
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
  flash: {
    backgroundColor: '#FFFFFF',
  },
});
