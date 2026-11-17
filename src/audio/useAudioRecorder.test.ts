import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudioRecorder } from './useAudioRecorder';
import type { RecorderError } from './errors';

// --- Browser API fakes -------------------------------------------------------

class FakeTrack {
  stop = vi.fn();
  onended: (() => void) | null = null;
}

class FakeStream {
  tracks = [new FakeTrack()];
  getTracks = () => this.tracks;
  getAudioTracks = () => this.tracks;
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static supported = new Set(['audio/webm;codecs=opus', 'audio/webm']);
  static isTypeSupported = (type: string) => FakeMediaRecorder.supported.has(type);

  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  /** Bytes emitted on stop; set to 0 to simulate an empty recording. */
  emitBytes = 1024;

  constructor(
    public stream: FakeStream,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? '';
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(this.emitBytes)]) });
      this.onstop?.();
    });
  }
}

const decodeAudioData = vi.fn(async () => ({ duration: 2, numberOfChannels: 2, sampleRate: 48_000 }));
const offlineContexts: { channels: number; length: number; rate: number }[] = [];

class FakeAudioContext {
  decodeAudioData = decodeAudioData;
  close = vi.fn(async () => {});
}

class FakeOfflineAudioContext {
  destination = {};
  constructor(
    public channels: number,
    public length: number,
    public rate: number,
  ) {
    offlineContexts.push({ channels, length, rate });
  }
  createBufferSource() {
    return { buffer: null, connect: vi.fn(), start: vi.fn() };
  }
  async startRendering() {
    return { getChannelData: () => new Float32Array(this.length) };
  }
}

let getUserMedia: ReturnType<typeof vi.fn>;
let lastStream: FakeStream;

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
}

function domError(name: string) {
  return new DOMException('x', name);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  FakeMediaRecorder.instances = [];
  offlineContexts.length = 0;
  decodeAudioData.mockClear();
  setSecureContext(true);
  getUserMedia = vi.fn(async () => {
    lastStream = new FakeStream();
    return lastStream;
  });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Starts recording and waits until the hook reports `recording`. The pending
 * promise is wrapped so `await` doesn't wait for the recording to end.
 */
async function startRecording(result: { current: ReturnType<typeof useAudioRecorder> }) {
  let pending!: ReturnType<typeof result.current.start>;
  await act(async () => {
    pending = result.current.start();
    pending.catch(() => {}); // asserted by the caller
  });
  expect(result.current.status).toBe('recording');
  return { pending };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// --- Tests -------------------------------------------------------------------

describe('useAudioRecorder', () => {
  it('records, then returns mono 16 kHz audio and releases the mic', async () => {
    const { result } = renderHook(() => useAudioRecorder());
    const { pending } = await startRecording(result);

    await advance(2000);
    expect(result.current.durationMs).toBeGreaterThanOrEqual(1900);

    let recording: Awaited<typeof pending> = null;
    await act(async () => {
      recording = await result.current.stop();
    });
    await expect(pending).resolves.toBe(recording);

    expect(recording!.sampleRate).toBe(16_000);
    expect(recording!.audio).toBeInstanceOf(Float32Array);
    expect(recording!.audio.length).toBe(32_000);
    expect(offlineContexts[0]).toEqual({ channels: 1, length: 32_000, rate: 16_000 });
    expect(lastStream.tracks[0].stop).toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('picks a supported MIME type at runtime', async () => {
    const { result } = renderHook(() => useAudioRecorder());
    await startRecording(result);
    expect(FakeMediaRecorder.instances[0].mimeType).toBe('audio/webm;codecs=opus');
  });

  it('lets the browser choose when no candidate type is supported', async () => {
    FakeMediaRecorder.supported = new Set();
    const { result } = renderHook(() => useAudioRecorder());
    await startRecording(result);
    expect(FakeMediaRecorder.instances[0].mimeType).toBe('');
    FakeMediaRecorder.supported = new Set(['audio/webm;codecs=opus', 'audio/webm']);
  });

  it('auto-stops at maxDurationMs', async () => {
    const { result } = renderHook(() => useAudioRecorder({ maxDurationMs: 5000 }));
    const { pending } = await startRecording(result);

    await advance(4900);
    expect(result.current.status).toBe('recording');
    await advance(200);

    const recording = await pending;
    expect(recording?.durationMs).toBe(5000);
    expect(lastStream.tracks[0].stop).toHaveBeenCalled();
  });

  it('returns the same promise when start is called twice', async () => {
    const { result } = renderHook(() => useAudioRecorder());
    let a!: Promise<unknown>;
    let b!: Promise<unknown>;
    await act(async () => {
      a = result.current.start();
      b = result.current.start();
    });
    expect(a).toBe(b);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('cancel resolves null and releases the mic', async () => {
    const { result } = renderHook(() => useAudioRecorder());
    const { pending } = await startRecording(result);
    await advance(1000);

    await act(async () => {
      result.current.cancel();
    });
    await expect(pending).resolves.toBeNull();
    expect(lastStream.tracks[0].stop).toHaveBeenCalled();
    expect(decodeAudioData).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('cancel during the permission prompt releases the stream once granted', async () => {
    let grant!: (s: FakeStream) => void;
    getUserMedia.mockImplementationOnce(() => new Promise((res) => (grant = res)));
    const { result } = renderHook(() => useAudioRecorder());

    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.start();
    });
    expect(result.current.status).toBe('requesting');

    act(() => result.current.cancel());
    const stream = new FakeStream();
    await act(async () => grant(stream));

    await expect(pending).resolves.toBeNull();
    expect(stream.tracks[0].stop).toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it('keeps the audio if the mic disconnects mid-recording', async () => {
    const { result } = renderHook(() => useAudioRecorder());
    const { pending } = await startRecording(result);
    await advance(1000);
    await act(async () => lastStream.tracks[0].onended?.());
    await expect(pending).resolves.toMatchObject({ durationMs: 1000 });
  });

  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'no-device'],
    ['NotReadableError', 'device-busy'],
    ['TypeError', 'unknown'],
  ])('maps getUserMedia %s to %s', async (name, code) => {
    getUserMedia.mockRejectedValueOnce(domError(name));
    const { result } = renderHook(() => useAudioRecorder());
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.start().catch((e) => e);
    });
    expect(((await pending) as RecorderError).code).toBe(code);
    expect(result.current.error?.code).toBe(code);
    expect(result.current.status).toBe('idle');
  });

  it('reports insecure-context before touching the mic', async () => {
    setSecureContext(false);
    const { result } = renderHook(() => useAudioRecorder());
    await act(async () => {
      await expect(result.current.start()).rejects.toMatchObject({ code: 'insecure-context' });
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('reports unsupported when MediaRecorder is missing', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const { result } = renderHook(() => useAudioRecorder());
    await act(async () => {
      await expect(result.current.start()).rejects.toMatchObject({ code: 'unsupported' });
    });
  });

  it('rejects recordings shorter than minDurationMs', async () => {
    const { result } = renderHook(() => useAudioRecorder({ minDurationMs: 500 }));
    const { pending } = await startRecording(result);
    await advance(100);
    await act(async () => {
      await result.current.stop().catch(() => {});
    });
    await expect(pending).rejects.toMatchObject({ code: 'empty-recording' });
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('rejects when the recorder produced no data', async () => {
    const { result } = renderHook(() => useAudioRecorder());
    const { pending } = await startRecording(result);
    FakeMediaRecorder.instances[0].emitBytes = 0;
    await advance(1000);
    await act(async () => {
      await result.current.stop().catch(() => {});
    });
    await expect(pending).rejects.toMatchObject({ code: 'empty-recording' });
  });

  it('maps decode failures to decode-failed', async () => {
    decodeAudioData.mockRejectedValueOnce(new Error('bad data'));
    const { result } = renderHook(() => useAudioRecorder());
    const { pending } = await startRecording(result);
    await advance(1000);
    await act(async () => {
      await result.current.stop().catch(() => {});
    });
    await expect(pending).rejects.toMatchObject({ code: 'decode-failed' });
    expect(result.current.error?.code).toBe('decode-failed');
  });

  it('releases the mic on unmount', async () => {
    const { result, unmount } = renderHook(() => useAudioRecorder());
    const { pending } = await startRecording(result);
    unmount();
    expect(lastStream.tracks[0].stop).toHaveBeenCalled();
    await expect(pending).resolves.toBeNull();
  });
});
