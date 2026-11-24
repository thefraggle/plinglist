export type AudioAssetSource = 'cc0-synth' | 'brand-overlay';

export const CHIME_MASTER_GAIN = 0.5;

/**
 * Public open-source repo uses a neutral two-tone Web Audio API placeholder chime
 * (no proprietary brand audio in AGPLv3 source). `./cloud` overlays the original sound.
 */
export const CC0_CHIME_NOTES = [
  { frequencyHz: 880, durationMs: 70, gain: 0.07 },
  { frequencyHz: 1318.51, durationMs: 140, gain: 0.06 },
] as const;

export function resolveCompletionSoundSource(hasBrandOverlay: boolean): AudioAssetSource {
  return hasBrandOverlay ? 'brand-overlay' : 'cc0-synth';
}
