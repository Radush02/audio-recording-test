export type RecorderErrorCode =
  /** The user (or a browser policy) blocked microphone access. */
  | 'permission-denied'
  /** No audio input device is connected. */
  | 'no-device'
  /** The microphone exists but another app or the OS is holding it. */
  | 'device-busy'
  /** The page is not served over HTTPS or localhost, so getUserMedia is unavailable. */
  | 'insecure-context'
  /** MediaRecorder, getUserMedia or Web Audio is missing. */
  | 'unsupported'
  /** Nothing usable was captured: no data, or shorter than `minDurationMs`. */
  | 'empty-recording'
  /** The recorded audio could not be decoded or resampled. */
  | 'decode-failed'
  | 'unknown';

export class RecorderError extends Error {
  readonly code: RecorderErrorCode;

  constructor(code: RecorderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RecorderError';
    this.code = code;
  }
}

/** Maps a getUserMedia rejection to a typed error. */
export function fromGetUserMediaError(err: unknown): RecorderError {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new RecorderError('permission-denied', 'Microphone access was denied.', { cause: err });
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new RecorderError('no-device', 'No microphone was found.', { cause: err });
    case 'NotReadableError':
    case 'AbortError':
      return new RecorderError('device-busy', 'The microphone could not be started.', { cause: err });
    default:
      return new RecorderError('unknown', 'Could not access the microphone.', { cause: err });
  }
}
