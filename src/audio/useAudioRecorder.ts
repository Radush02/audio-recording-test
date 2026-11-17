import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeToMono16k, pickMimeType, TARGET_SAMPLE_RATE } from './decode';
import { fromGetUserMediaError, RecorderError } from './errors';

export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'processing';

export interface RecordingResult {
  /** Mono PCM samples in [-1, 1]. */
  audio: Float32Array;
  sampleRate: typeof TARGET_SAMPLE_RATE;
  durationMs: number;
}

export interface UseAudioRecorderOptions {
  /** Recording stops by itself after this long. Default 60 000. */
  maxDurationMs?: number;
  /** Recordings shorter than this reject with `empty-recording`. Default 300. */
  minDurationMs?: number;
}

export interface UseAudioRecorder {
  status: RecorderStatus;
  /**
   * Asks for the mic and starts recording. The promise settles when the
   * recording ends, whether by `stop()`, the max-duration cap, or the mic
   * disconnecting: it resolves with the audio, resolves `null` if cancelled,
   * or rejects with a `RecorderError`. Calling it again while a recording is
   * in progress returns the same promise.
   */
  start: () => Promise<RecordingResult | null>;
  /** Ends the recording. Returns the same promise as `start()`. */
  stop: () => Promise<RecordingResult | null>;
  /** Discards the recording; the pending promise resolves `null`. */
  cancel: () => void;
  /** Elapsed recording time, updated about every 100 ms. */
  durationMs: number;
  error: RecorderError | null;
}

interface Session {
  promise: Promise<RecordingResult | null>;
  resolve: (result: RecordingResult | null) => void;
  reject: (err: RecorderError) => void;
  cancelled: boolean;
  /** Set once the promise has settled; later callbacks become no-ops. */
  settled: boolean;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  startedAt: number;
  ticker?: ReturnType<typeof setInterval>;
  cap?: ReturnType<typeof setTimeout>;
}

const TICK_MS = 100;

export function useAudioRecorder({
  maxDurationMs = 60_000,
  minDurationMs = 300,
}: UseAudioRecorderOptions = {}): UseAudioRecorder {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [durationMs, setDurationMs] = useState(0);
  const [error, setError] = useState<RecorderError | null>(null);
  const sessionRef = useRef<Session | null>(null);

  // Read inside long-lived callbacks so they always see the latest props.
  const limitsRef = useRef({ maxDurationMs, minDurationMs });
  limitsRef.current = { maxDurationMs, minDurationMs };

  const releaseHardware = useCallback((session: Session) => {
    clearInterval(session.ticker);
    clearTimeout(session.cap);
    session.stream?.getTracks().forEach((track) => track.stop());
    session.stream = null;
  }, []);

  const finish = useCallback(
    (session: Session, outcome: { result: RecordingResult | null } | { error: RecorderError }) => {
      releaseHardware(session);
      if (session.settled) return;
      session.settled = true;
      if (sessionRef.current === session) sessionRef.current = null;
      setStatus('idle');
      if ('error' in outcome) {
        setError(outcome.error);
        session.reject(outcome.error);
      } else {
        session.resolve(outcome.result);
      }
    },
    [releaseHardware],
  );

  const stopRecorder = useCallback((session: Session) => {
    if (session.recorder && session.recorder.state !== 'inactive') {
      session.recorder.stop();
    }
  }, []);

  const handleStop = useCallback(
    async (session: Session) => {
      if (session.settled) return;
      const elapsed = Date.now() - session.startedAt;
      releaseHardware(session);
      setDurationMs(elapsed);

      if (session.cancelled) {
        finish(session, { result: null });
        return;
      }

      setStatus('processing');
      try {
        const blob = new Blob(session.chunks, { type: session.recorder?.mimeType || undefined });
        if (blob.size === 0 || elapsed < limitsRef.current.minDurationMs) {
          throw new RecorderError('empty-recording', 'The recording was too short.');
        }
        const audio = await decodeToMono16k(blob);
        if (session.cancelled) {
          finish(session, { result: null });
          return;
        }
        finish(session, { result: { audio, sampleRate: TARGET_SAMPLE_RATE, durationMs: elapsed } });
      } catch (err) {
        const error =
          err instanceof RecorderError
            ? err
            : new RecorderError('decode-failed', 'The recording could not be processed.', { cause: err });
        finish(session, { error });
      }
    },
    [finish, releaseHardware],
  );

  const start = useCallback((): Promise<RecordingResult | null> => {
    if (sessionRef.current) return sessionRef.current.promise;

    let resolve!: Session['resolve'];
    let reject!: Session['reject'];
    const promise = new Promise<RecordingResult | null>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const session: Session = {
      promise,
      resolve,
      reject,
      cancelled: false,
      settled: false,
      stream: null,
      recorder: null,
      chunks: [],
      startedAt: 0,
    };
    sessionRef.current = session;
    setError(null);
    setDurationMs(0);

    // The order matters: in an insecure context navigator.mediaDevices is undefined,
    // which would otherwise be reported as "unsupported".
    if (!window.isSecureContext) {
      finish(session, {
        error: new RecorderError('insecure-context', 'Recording needs HTTPS or localhost.'),
      });
      return promise;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      finish(session, {
        error: new RecorderError('unsupported', 'This browser cannot record audio.'),
      });
      return promise;
    }

    setStatus('requesting');
    navigator.mediaDevices
      .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then(
        (stream) => {
          session.stream = stream;
          if (session.cancelled) {
            finish(session, { result: null });
            return;
          }

          let recorder: MediaRecorder;
          try {
            const mimeType = pickMimeType();
            recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
          } catch (err) {
            finish(session, {
              error: new RecorderError('unsupported', 'This browser cannot record audio.', { cause: err }),
            });
            return;
          }
          session.recorder = recorder;

          recorder.ondataavailable = (event) => {
            if (event.data.size > 0) session.chunks.push(event.data);
          };
          recorder.onstop = () => void handleStop(session);
          recorder.onerror = (event) => {
            session.cancelled = true;
            finish(session, {
              error: new RecorderError('unknown', 'Recording failed.', { cause: event }),
            });
          };
          // If the mic is unplugged mid-recording, keep what was captured.
          stream.getAudioTracks().forEach((track) => {
            track.onended = () => stopRecorder(session);
          });

          recorder.start();
          session.startedAt = Date.now();
          setStatus('recording');
          session.ticker = setInterval(() => setDurationMs(Date.now() - session.startedAt), TICK_MS);
          session.cap = setTimeout(() => stopRecorder(session), limitsRef.current.maxDurationMs);
        },
        (err: unknown) => finish(session, { error: fromGetUserMediaError(err) }),
      );

    return promise;
  }, [finish, handleStop, stopRecorder]);

  const stop = useCallback((): Promise<RecordingResult | null> => {
    const session = sessionRef.current;
    if (!session) return Promise.resolve(null);
    // Stopping while still waiting for permission has nothing to keep.
    if (!session.recorder) session.cancelled = true;
    else stopRecorder(session);
    return session.promise;
  }, [stopRecorder]);

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    session.cancelled = true;
    if (session.recorder && session.recorder.state !== 'inactive') {
      session.recorder.stop(); // onstop resolves null
    } else if (session.recorder) {
      finish(session, { result: null }); // already processing
    }
    // Otherwise getUserMedia is pending; its callback sees `cancelled`.
  }, [finish]);

  useEffect(
    () => () => {
      const session = sessionRef.current;
      if (!session) return;
      session.cancelled = true;
      stopRecorder(session);
      releaseHardware(session);
      session.settled = true;
      session.resolve(null);
      sessionRef.current = null;
    },
    [releaseHardware, stopRecorder],
  );

  return { status, start, stop, cancel, durationMs, error };
}
