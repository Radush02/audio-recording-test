import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAudioRecorder } from '../audio/useAudioRecorder';
import { RecorderError, type RecorderErrorCode } from '../audio/errors';
import { createTranscriber, type Transcriber } from '../transcriber/createTranscriber';
import { TranscriberError, type LoadProgress, type TranscriberErrorCode } from '../transcriber/protocol';
import './VoiceInput.css';

export interface VoiceInputProps {
  onTranscript: (text: string) => void;
  /** Recording stops by itself after this many seconds. Default 60. */
  maxDurationSec?: number;
  disabled?: boolean;
  className?: string;
}

export type VoiceInputStatus =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'loading-model'
  | 'transcribing'
  | 'done'
  | 'error';

const ERROR_MESSAGES: Record<RecorderErrorCode | Exclude<TranscriberErrorCode, 'terminated'>, string> = {
  'permission-denied':
    'Microphone access is blocked. Allow it from the icon in the address bar, then try again.',
  'no-device': 'No microphone was found. Connect one and try again.',
  'device-busy': 'Your microphone is being used by another app. Close it and try again.',
  'insecure-context': 'Voice input needs a secure page (HTTPS or localhost).',
  unsupported: "This browser can't record audio. Use a recent version of Chrome.",
  'empty-recording': 'That recording was too short. Try again and speak for a moment before stopping.',
  'decode-failed': "The recording couldn't be processed. Please try again.",
  unknown: 'Something went wrong with the microphone. Please try again.',
  'model-load-failed': "The speech model couldn't be downloaded. Check your connection and try again.",
  'no-speech': "No speech was detected. Try again a little closer to the microphone.",
  'invalid-audio': "The recording couldn't be processed. Please try again.",
  'transcription-failed': 'Transcription failed. Please try again.',
};

const ANNOUNCEMENTS: Partial<Record<VoiceInputStatus, string>> = {
  requesting: 'Waiting for microphone permission.',
  recording: 'Recording. Press the button again to stop, or Escape to cancel.',
  'loading-model': 'Loading the speech model.',
  transcribing: 'Transcribing.',
  done: 'Transcription ready.',
};

function formatTime(ms: number) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function errorMessage(err: unknown): string | null {
  if (err instanceof RecorderError) return ERROR_MESSAGES[err.code];
  if (err instanceof TranscriberError) return err.code === 'terminated' ? null : ERROR_MESSAGES[err.code];
  return ERROR_MESSAGES.unknown;
}

export function VoiceInput({ onTranscript, maxDurationSec = 60, disabled = false, className }: VoiceInputProps) {
  const maxDurationMs = maxDurationSec * 1000;
  const recorder = useAudioRecorder({ maxDurationMs });
  const { start: startRecording, stop: stopRecording, cancel } = recorder;
  const [phase, setPhase] = useState<'idle' | 'loading-model' | 'transcribing' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [modelLoading, setModelLoading] = useState(false);

  const transcriberRef = useRef<Transcriber | null>(null);
  const runRef = useRef(0);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const errorId = useId();

  // The recorder owns the first half of the flow; this component owns the rest.
  const status: VoiceInputStatus =
    recorder.status === 'requesting' || recorder.status === 'recording'
      ? recorder.status
      : recorder.status === 'processing'
        ? 'transcribing'
        : phase;

  /** Creates the worker and starts the model download, once. */
  const warmUp = useCallback(() => {
    if (!transcriberRef.current) {
      transcriberRef.current = createTranscriber({ onProgress: setProgress });
    }
    const transcriber = transcriberRef.current;
    if (transcriber.state === 'idle' || transcriber.state === 'error') {
      setModelLoading(true);
      transcriber
        .load()
        .catch(() => {}) // surfaced when transcribe() calls load() again
        .finally(() => setModelLoading(false));
    }
    return transcriber;
  }, []);

  useEffect(
    () => () => {
      runRef.current++;
      transcriberRef.current?.terminate();
    },
    [],
  );

  const run = useCallback(async () => {
    const id = ++runRef.current;
    const isCurrent = () => runRef.current === id;
    setError(null);
    setPhase('idle');
    const transcriber = warmUp();

    try {
      const recording = await startRecording();
      if (!isCurrent()) return;
      if (!recording) {
        setPhase('idle');
        return;
      }

      if (transcriber.state !== 'ready') {
        setPhase('loading-model');
        await transcriber.load();
        if (!isCurrent()) return;
      }
      setPhase('transcribing');
      const text = await transcriber.transcribe(recording.audio);
      if (!isCurrent()) return;
      setPhase('done');
      onTranscriptRef.current(text);
    } catch (err) {
      if (!isCurrent()) return;
      const message = errorMessage(err);
      if (message === null) return;
      setError(message);
      setPhase('error');
    }
  }, [startRecording, warmUp]);

  const busy = status === 'requesting' || status === 'loading-model' || status === 'transcribing';
  const recording = status === 'recording';

  const handleClick = () => {
    if (recording) void stopRecording();
    else if (!busy) void run();
  };

  // Becoming disabled mid-recording discards the recording.
  useEffect(() => {
    if (disabled && (recorder.status === 'recording' || recorder.status === 'requesting')) cancel();
  }, [disabled, recorder.status, cancel]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && (recording || status === 'requesting')) {
      event.preventDefault();
      cancel();
    }
  };

  const label = (() => {
    switch (status) {
      case 'requesting':
        return 'Waiting for microphone…';
      case 'recording':
        return 'Stop recording';
      case 'loading-model':
        return 'Loading speech model…';
      case 'transcribing':
        return 'Transcribing…';
      case 'done':
        return 'Record again';
      case 'error':
        return 'Try again';
      default:
        return 'Start voice input';
    }
  })();

  const showProgress = modelLoading || status === 'loading-model';
  const percent = progress ? Math.round(progress.percent) : null;

  return (
    <div className={['voice-input', className].filter(Boolean).join(' ')} data-status={status} onKeyDown={handleKeyDown}>
      <div className="voice-input__row">
        <button
          type="button"
          className="voice-input__button"
          onClick={handleClick}
          onPointerEnter={disabled ? undefined : warmUp}
          onFocus={disabled ? undefined : warmUp}
          // aria-disabled rather than disabled while busy, so keyboard focus stays on the button.
          disabled={disabled}
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          aria-describedby={error ? errorId : undefined}
        >
          <span className="voice-input__icon" aria-hidden="true">
            {recording ? '■' : busy ? '…' : '●'}
          </span>
          <span>{label}</span>
        </button>

        {recording && (
          <>
            <span className="voice-input__timer" aria-hidden="true">
              {formatTime(recorder.durationMs)} / {formatTime(maxDurationMs)}
            </span>
            <button type="button" className="voice-input__cancel" onClick={cancel}>
              Cancel
            </button>
          </>
        )}
      </div>

      {showProgress && (
        <div className="voice-input__progress">
          <progress
            max={100}
            value={percent ?? undefined}
            aria-label="Speech model download"
            aria-valuetext={percent === null ? 'Starting download' : `${percent}%`}
          />
          <span aria-hidden="true">
            {percent === null ? 'Preparing speech model…' : `Downloading speech model… ${percent}%`}
          </span>
        </div>
      )}

      {error && (
        <p id={errorId} className="voice-input__error" role="alert">
          {error}
        </p>
      )}

      <div className="voice-input__sr-only" role="status" aria-live="polite">
        {ANNOUNCEMENTS[status] ?? ''}
      </div>
    </div>
  );
}
