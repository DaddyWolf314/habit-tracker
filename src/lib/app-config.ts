/**
 * Cover identity for discretion (handoff §3.5, #42). The app presents under a
 * deliberately bland name and a generic icon so its presence — in an app
 * switcher, a home screen, a notification badge — gives nothing away. This is a
 * neutral *placeholder*; final naming/positioning is tracked separately (#45).
 * Kept in one constant so the whole surface (title, manifest, headings) stays
 * consistent and is trivial to re-skin.
 */

/** The neutral display name shown everywhere the app is titled. */
export const APP_NAME = "Habits";

/** A neutral one-liner — no hint of the relationship dynamic. */
export const APP_TAGLINE = "Track your daily habits.";
