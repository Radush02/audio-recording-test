import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecorderError, type RecorderErrorCode } from '../audio/errors';
import type { RecorderStatus, RecordingResult } from '../audio/useAudioRecorder';
import { TranscriberError, type LoadProgress } from '../transcriber/protocol';
import { VoiceInput } from './VoiceInput';

// --- Recorder mock: a real hook whose state the test drives --------------------

const rec = {
  options: undefined as { maxDurationMs?: number } | undefined,
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  setStatus: (_: RecorderStatus) => {},
  setDuration: (_: number) => {},
  resolve: (_: RecordingResult | null) => {},
  reject: (_: RecorderError) => {},
};

function useFakeRecorder(options?: { maxDurationMs?: number }) {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [durationMs, setDuration] = useState(0);
  rec.options = options;
  rec.setStatus = setStatus;
  rec.setDuration = setDuration;

  const start = useCallback(() => {
    rec.start();
    setStatus('requesting');
    return new Promise<RecordingResult | null>((resolve, reject) => {
      rec.resolve = (value) => {
        setStatus('idle');
        resolve(value);
      };
      rec.reject = (err) => {
        setStatus('idle');
        reject(err);
      };
    });
  }, []);
  const stop = useCallback(() => {
    rec.stop();
    return Promise.resolve(null);
  }, []);
  const cancel = useCallback(() => {
    rec.cancel();
    rec.resolve(null);
  }, []);
  return { status, start, stop, cancel, durationMs, error: null };
}

vi.mock('../audio/useAudioRecorder', () => ({
  useAudioRecorder: (options?: { maxDurationMs?: number }) => useFakeRecorder(options),
}));

// --- Transcriber mock ----------------------------------------------------------

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const tx = {
  created: 0,
  state: 'idle' as string,
  onProgress: undefined as ((p: LoadProgress) => void) | undefined,
  loadDeferred: deferred<{ device: 'webgpu' }>(),
  transcribeDeferred: deferred<string>(),
  load: vi.fn(),
  transcribe: vi.fn(),
  terminate: vi.fn(),
};

vi.mock('../transcriber/createTranscriber', () => ({
  createTranscriber: (options: { onProgress?: (p: LoadProgress) => void }) => {
    tx.created++;
    tx.onProgress = options.onProgress;
    return {
      load: () => {
        tx.load();
        if (tx.state !== 'ready') tx.state = 'loading';
        return tx.loadDeferred.promise.then(
          (v) => {
            tx.state = 'ready';
            return v;
          },
          (e) => {
            tx.state = 'error';
            throw e;
          },
        );
      },
      transcribe: (audio: Float32Array) => {
        tx.transcribe(audio);
        return tx.transcribeDeferred.promise;
      },
      terminate: tx.terminate,
      get state() {
        return tx.state;
      },
      device: null,
    };
  },
}));

// --- Helpers -------------------------------------------------------------------

const audio = new Float32Array(16_000);
const recording: RecordingResult = { audio, sampleRate: 16_000, durationMs: 1000 };

function button() {
  return screen.getAllByRole('button')[0];
}

function liveRegion() {
  return screen.getByRole('status');
}

async function settle() {
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  tx.created = 0;
  tx.state = 'idle';
  tx.loadDeferred = deferred();
  tx.transcribeDeferred = deferred();
});

// --- Tests ---------------------------------------------------------------------

describe('<VoiceInput />', () => {
  it('starts idle and does not load the model at render', () => {
    render(<VoiceInput onTranscript={() => {}} />);
    expect(button()).toHaveAccessibleName('Start voice input');
    expect(tx.created).toBe(0);
  });

  it('starts loading the model on hover or focus', () => {
    render(<VoiceInput onTranscript={() => {}} />);
    fireEvent.pointerEnter(button());
    expect(tx.created).toBe(1);
    expect(tx.load).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('progressbar', { name: 'Speech model download' })).toBeInTheDocument();
  });

  it('goes idle → requesting → recording → loading model → transcribing → done', async () => {
    const onTranscript = vi.fn();
    const user = userEvent.setup();
    render(<VoiceInput onTranscript={onTranscript} />);

    await user.click(button());
    expect(rec.start).toHaveBeenCalled();
    expect(button()).toHaveAccessibleName('Waiting for microphone…');
    expect(liveRegion()).toHaveTextContent('Waiting for microphone permission.');

    act(() => {
      rec.setStatus('recording');
      rec.setDuration(12_000);
    });
    expect(button()).toHaveAccessibleName('Stop recording');
    expect(screen.getByText('0:12 / 1:00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent(/Recording/);

    act(() => tx.onProgress?.({ percent: 42.4, loaded: 42, total: 100 }));
    expect(screen.getByText('Downloading speech model… 42%')).toBeInTheDocument();

    await user.click(button());
    expect(rec.stop).toHaveBeenCalled();

    await act(async () => rec.resolve(recording));
    expect(button()).toHaveAccessibleName('Loading speech model…');
    expect(button()).toHaveAttribute('aria-busy', 'true');
    expect(liveRegion()).toHaveTextContent('Loading the speech model.');

    await act(async () => tx.loadDeferred.resolve({ device: 'webgpu' }));
    expect(button()).toHaveAccessibleName('Transcribing…');
    expect(tx.transcribe).toHaveBeenCalledWith(audio);

    await act(async () => tx.transcribeDeferred.resolve('hello world'));
    expect(onTranscript).toHaveBeenCalledWith('hello world');
    expect(button()).toHaveAccessibleName('Record again');
    expect(liveRegion()).toHaveTextContent('Transcription ready.');
  });

  it('skips the loading state when the model is already ready', async () => {
    tx.loadDeferred.resolve({ device: 'webgpu' });
    const user = userEvent.setup();
    render(<VoiceInput onTranscript={() => {}} />);
    fireEvent.focus(button());
    await settle();
    expect(tx.state).toBe('ready');

    await user.click(button());
    await act(async () => rec.resolve(recording));
    expect(button()).toHaveAccessibleName('Transcribing…');
  });

  it('ignores clicks while busy', async () => {
    const user = userEvent.setup();
    render(<VoiceInput onTranscript={() => {}} />);
    await user.click(button());
    await act(async () => rec.resolve(recording));
    expect(button()).toHaveAttribute('aria-disabled', 'true');
    await user.click(button());
    expect(rec.start).toHaveBeenCalledTimes(1);
  });

  it('cancel discards the recording', async () => {
    const user = userEvent.setup();
    render(<VoiceInput onTranscript={() => {}} />);
    await user.click(button());
    act(() => rec.setStatus('recording'));

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(rec.cancel).toHaveBeenCalled();
    await settle();
    expect(button()).toHaveAccessibleName('Start voice input');
    expect(tx.transcribe).not.toHaveBeenCalled();
  });

  it('Escape cancels while recording', async () => {
    const user = userEvent.setup();
    render(<VoiceInput onTranscript={() => {}} />);
    await user.click(button());
    act(() => rec.setStatus('recording'));
    await user.keyboard('{Escape}');
    expect(rec.cancel).toHaveBeenCalled();
  });

  it.each<[RecorderErrorCode, RegExp]>([
    ['permission-denied', /Microphone access is blocked/],
    ['no-device', /No microphone was found/],
    ['insecure-context', /HTTPS or localhost/],
    ['unsupported', /recent version of Chrome/],
    ['empty-recording', /too short/],
    ['device-busy', /another app/],
  ])('shows an accessible message for recorder error %s', async (code, message) => {
    const user = userEvent.setup();
    render(<VoiceInput onTranscript={() => {}} />);
    await user.click(button());
    await act(async () => rec.reject(new RecorderError(code, 'x')));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(button()).toHaveAccessibleName('Try again');
    expect(button()).toHaveAccessibleDescription(alert.textContent!);
  });

  it('shows no-speech from the transcriber', async () => {
    tx.loadDeferred.resolve({ device: 'webgpu' });
    const user = userEvent.setup();
    render(<VoiceInput onTranscript={() => {}} />);
    await user.click(button());
    await act(async () => rec.resolve(recording));
    await act(async () => tx.transcribeDeferred.reject(new TranscriberError('no-speech', 'x')));
    expect(screen.getByRole('alert')).toHaveTextContent(/No speech was detected/);
  });

  it('shows model-load-failed and retries the download on the next attempt', async () => {
    const onTranscript = vi.fn();
    const user = userEvent.setup();
    render(<VoiceInput onTranscript={onTranscript} />);
    await user.click(button());
    await act(async () => tx.loadDeferred.reject(new TranscriberError('model-load-failed', 'offline')));
    await act(async () => rec.resolve(recording));
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't be downloaded/);

    tx.loadDeferred = deferred();
    await user.click(button());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(tx.load.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not record or warm up when disabled', async () => {
    const user = userEvent.setup();
    render(<VoiceInput onTranscript={() => {}} disabled />);
    expect(button()).toBeDisabled();
    fireEvent.pointerEnter(button());
    await user.click(button());
    expect(rec.start).not.toHaveBeenCalled();
    expect(tx.created).toBe(0);
  });

  it('cancels a recording when it becomes disabled', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<VoiceInput onTranscript={() => {}} />);
    await user.click(button());
    act(() => rec.setStatus('recording'));
    rerender(<VoiceInput onTranscript={() => {}} disabled />);
    expect(rec.cancel).toHaveBeenCalled();
  });

  it('passes maxDurationSec to the recorder and timer', async () => {
    const user = userEvent.setup();
    render(<VoiceInput onTranscript={() => {}} maxDurationSec={30} />);
    expect(rec.options).toEqual({ maxDurationMs: 30_000 });
    await user.click(button());
    act(() => rec.setStatus('recording'));
    expect(screen.getByText('0:00 / 0:30')).toBeInTheDocument();
  });

  it('applies className', () => {
    const { container } = render(<VoiceInput onTranscript={() => {}} className="custom" />);
    expect(container.firstChild).toHaveClass('voice-input', 'custom');
  });

  it('terminates the worker on unmount and drops late results', async () => {
    const onTranscript = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(<VoiceInput onTranscript={onTranscript} />);
    await user.click(button());
    unmount();
    expect(tx.terminate).toHaveBeenCalled();
    await act(async () => rec.resolve(recording));
    expect(tx.transcribe).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });
});
