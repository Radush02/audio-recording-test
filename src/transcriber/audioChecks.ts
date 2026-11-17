import { TranscriberError } from './protocol';

export const SAMPLE_RATE = 16_000;

/** Clips shorter than this rarely contain a word and make Whisper guess. */
const MIN_SAMPLES = SAMPLE_RATE / 4;
const FRAME_SAMPLES = SAMPLE_RATE * 0.03;
/**
 * A clip whose loudest 30 ms frame stays below this RMS is treated as silence.
 * Speech at normal distance is ~0.02–0.2; a quiet room with noise suppression
 * is well under 0.005.
 */
const SILENCE_RMS = 0.008;

/**
 * Throws before inference when the input is unusable or silent. Whisper
 * invents text ("Thank you.", "you") for silence, so this must run first.
 */
export function assertUsableAudio(audio: unknown): asserts audio is Float32Array {
  if (!(audio instanceof Float32Array)) {
    throw new TranscriberError('invalid-audio', 'Audio must be a Float32Array of 16 kHz mono samples.');
  }
  if (audio.length < MIN_SAMPLES) {
    throw new TranscriberError('no-speech', 'The clip is too short to contain speech.');
  }

  let loudest = 0;
  for (let start = 0; start < audio.length; start += FRAME_SAMPLES) {
    const end = Math.min(start + FRAME_SAMPLES, audio.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += audio[i] * audio[i];
    const rms = Math.sqrt(sum / (end - start));
    if (Number.isNaN(rms)) {
      throw new TranscriberError('invalid-audio', 'Audio contains invalid samples.');
    }
    if (rms > loudest) loudest = rms;
  }
  if (loudest < SILENCE_RMS) {
    throw new TranscriberError('no-speech', 'No speech was detected.');
  }
}

/**
 * Whisper marks non-speech with bracketed tags like "[BLANK_AUDIO]" or
 * "(music)". Returns the cleaned text, or '' when nothing real is left.
 */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
