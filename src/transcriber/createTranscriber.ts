import {
  TranscriberError,
  type Device,
  type LoadProgress,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol';

export const DEFAULT_MODEL_ID = 'onnx-community/whisper-base.en';

export type TranscriberState = 'idle' | 'loading' | 'ready' | 'error' | 'terminated';

export interface CreateTranscriberOptions {
  /** Any English Whisper ONNX model on the hub, e.g. `onnx-community/whisper-tiny.en`. */
  modelId?: string;
  /** Called with download/initialisation progress while the model loads. */
  onProgress?: (progress: LoadProgress) => void;
  /** Overrides how the worker is created. Used by tests. */
  createWorker?: () => Worker;
}

export interface Transcriber {
  /**
   * Downloads (first time) and initialises the model. Safe to call repeatedly:
   * concurrent and later calls share the same load. After a failure, calling
   * it again retries.
   */
  load: () => Promise<{ device: Device }>;
  /**
   * Transcribes 16 kHz mono audio, loading the model first if needed. The
   * array's buffer is transferred to the worker, so the caller's copy is
   * empty afterwards. Rejects with a `TranscriberError`.
   */
  transcribe: (audio: Float32Array) => Promise<string>;
  /** Stops the worker. Pending calls reject with `terminated`. */
  terminate: () => void;
  readonly state: TranscriberState;
  /** The backend in use once loaded. */
  readonly device: Device | null;
}

type RequestBody = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never;

type Pending = {
  resolve: (message: WorkerResponse) => void;
  reject: (err: TranscriberError) => void;
};

function defaultWorker() {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}

export function createTranscriber({
  modelId = DEFAULT_MODEL_ID,
  onProgress,
  createWorker = defaultWorker,
}: CreateTranscriberOptions = {}): Transcriber {
  let state: TranscriberState = 'idle';
  let device: Device | null = null;
  let loadPromise: Promise<{ device: Device }> | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const worker = createWorker();

  function failAll(err: TranscriberError) {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.type === 'progress') {
      onProgress?.(message.progress);
      return;
    }
    pending.delete(message.id);
    if (message.type === 'error') entry.reject(new TranscriberError(message.code, message.message));
    else entry.resolve(message);
  });

  // Fires when the worker script itself fails to load or throws at top level.
  worker.addEventListener('error', (event) => {
    event.preventDefault();
    state = 'error';
    loadPromise = null;
    failAll(new TranscriberError('model-load-failed', event.message || 'The transcription worker failed to start.'));
  });

  function request(message: RequestBody, transfer: Transferable[] = []) {
    if (state === 'terminated') {
      return Promise.reject(new TranscriberError('terminated', 'The transcriber was terminated.'));
    }
    const id = nextId++;
    const full = { ...message, id } as WorkerRequest;
    return new Promise<WorkerResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage(full, transfer);
      } catch {
        // Some buffers can't be transferred (e.g. a view of shared memory); copy instead.
        worker.postMessage(full);
      }
    });
  }

  function load() {
    if (state === 'terminated') {
      return Promise.reject(new TranscriberError('terminated', 'The transcriber was terminated.'));
    }
    if (loadPromise) return loadPromise;
    state = 'loading';
    const promise = request({ type: 'load', modelId }).then(
      (message) => {
        if (message.type !== 'ready') throw new TranscriberError('model-load-failed', 'Unexpected worker reply.');
        state = 'ready';
        device = message.device;
        return { device: message.device };
      },
      (err: TranscriberError) => {
        if (loadPromise === promise) {
          loadPromise = null;
          if (state !== 'terminated') state = 'error';
        }
        throw err;
      },
    );
    loadPromise = promise;
    return promise;
  }

  async function transcribe(audio: Float32Array) {
    if (!(audio instanceof Float32Array)) {
      throw new TranscriberError('invalid-audio', 'Audio must be a Float32Array of 16 kHz mono samples.');
    }
    await load();
    // Transfer only when the view covers its whole buffer; otherwise send a compact copy.
    const payload =
      audio.byteOffset === 0 && audio.byteLength === audio.buffer.byteLength ? audio : audio.slice();
    const message = await request({ type: 'transcribe', audio: payload }, [payload.buffer as ArrayBuffer]);
    if (message.type !== 'result') throw new TranscriberError('transcription-failed', 'Unexpected worker reply.');
    return message.text;
  }

  function terminate() {
    if (state === 'terminated') return;
    state = 'terminated';
    loadPromise = null;
    worker.terminate();
    failAll(new TranscriberError('terminated', 'The transcriber was terminated.'));
  }

  return {
    load,
    transcribe,
    terminate,
    get state() {
      return state;
    },
    get device() {
      return device;
    },
  };
}
