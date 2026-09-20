// Warm, classy neutral palette — ivory/beige surfaces with a caramel-brown accent.
export const ACCENT = '#9C6B41';
export const ACCENT_DARK = '#6B4423';
export const BACKGROUND = '#F7F0E4';

export const SURFACE = '#FFFDF8';
export const SURFACE_MUTED = '#ECE0CC';
export const BORDER = 'rgba(43, 32, 24, 0.10)';

export const TEXT_PRIMARY = '#4A3728';
export const TEXT_SECONDARY = '#8A7860';
export const TEXT_MUTED = '#B3A28C';

export const SUCCESS = '#3F6B4A';

export const ACCENT_GRADIENT = [ACCENT, ACCENT_DARK] as const;

// Manrope — an elegant, humanist sans used for body text and labels.
export const FONT_REGULAR = 'Manrope_400Regular';
export const FONT_MEDIUM = 'Manrope_500Medium';
export const FONT_SEMIBOLD = 'Manrope_600SemiBold';
export const FONT_BOLD = 'Manrope_700Bold';
export const FONT_EXTRABOLD = 'Manrope_800ExtraBold';

// Fraunces — a warm editorial serif used for headlines, for extra polish.
export const FONT_SERIF = 'Fraunces_500Medium';
export const FONT_SERIF_SEMIBOLD = 'Fraunces_600SemiBold';
export const FONT_SERIF_BOLD = 'Fraunces_700Bold';
export const FONT_SERIF_ITALIC = 'Fraunces_500Medium_Italic';

// One small, shared type scale — three sizes only. LG for serif headlines and
// titles, MD for body/labels/buttons, SM for meta and captions.
export const FS_LG = 24;
export const FS_MD = 15;
export const FS_SM = 12.5;

// Bezier control points for a fast-start, long-decelerating curve — used
// anywhere a wait should feel like it's rushing toward completion rather
// than ticking by at a constant rate.
export const EASE_OUT_EXPO: [number, number, number, number] = [0.11, 0.85, 0.25, 1];
