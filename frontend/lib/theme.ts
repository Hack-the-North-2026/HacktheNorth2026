export const ACCENT = '#7C7CFF';
export const ACCENT_DARK = '#3F3FBD';
export const BACKGROUND = '#050509';

export const ACCENT_GRADIENT = [ACCENT, ACCENT_DARK] as const;

// Bezier control points for a fast-start, long-decelerating curve — used
// anywhere a wait should feel like it's rushing toward completion rather
// than ticking by at a constant rate.
export const EASE_OUT_EXPO: [number, number, number, number] = [0.11, 0.85, 0.25, 1];
