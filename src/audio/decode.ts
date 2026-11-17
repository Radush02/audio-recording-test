import { RecorderError } from './errors';

/** Whisper expects exactly this. A wrong rate produces wrong text with no error. */
export const TARGET_SAMPLE_RATE = 16_000;

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

/** Returns the first MIME type this browser can record, or '' to let it choose. */
export function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

/**
 * Decodes a recorded blob and returns mono PCM at 16 kHz.
 *
 * Decoding happens at the device rate in a regular AudioContext; an
 * OfflineAudioContext with one output channel then downmixes and resamples.
 */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  if (typeof AudioContext === 'undefined' || typeof OfflineAudioContext === 'undefined') {
    throw new RecorderError('unsupported', 'Web Audio is not available in this browser.');
  }

  let decoded: AudioBuffer;
  const ctx = new AudioContext();
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch (err) {
    throw new RecorderError('decode-failed', 'The recording could not be decoded.', { cause: err });
  } finally {
    void ctx.close();
  }

  const length = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
  if (length === 0) {
    throw new RecorderError('empty-recording', 'The recording contained no audio.');
  }

  try {
    const offline = new OfflineAudioContext(1, length, TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } catch (err) {
    throw new RecorderError('decode-failed', 'The recording could not be resampled.', { cause: err });
  }
}
