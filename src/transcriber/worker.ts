/// <reference lib="webworker" />
import { env, pipeline, type AutomaticSpeechRecognitionPipeline, type ProgressInfo } from '@huggingface/transformers';
import { assertUsableAudio, cleanTranscript } from './audioChecks';
import { TranscriberError, type Device, type WorkerRequest, type WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

// Models always come from the Hugging Face hub; the browser Cache API keeps them after the first download.
env.allowLocalModels = false;
env.useBrowserCache = true;

/**
 * WebGPU runs fp32/q4 well but q8 badly, so the encoder (most of the compute)
 * stays fp32 and the decoder uses 4-bit weights. WASM is fastest with 8-bit
 * weights throughout.
 */
const DTYPES = {
  webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
} as const;

interface Loaded {
  modelId: string;
  device: Device;
  asr: AutomaticSpeechRecognitionPipeline;
}

let loading: { modelId: string; promise: Promise<Loaded> } | null = null;
/** Transcriptions run one at a time; the pipeline isn't reentrant. */
let queue: Promise<unknown> = Promise.resolve();

function post(message: WorkerResponse) {
  self.postMessage(message);
}

async function pickDevice(): Promise<Device> {
  // navigator.gpu can exist without a usable adapter (blocklisted GPU, disabled flag).
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    return adapter ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

async function createPipeline(modelId: string, device: Device, onProgress: (info: ProgressInfo) => void) {
  return (await pipeline('automatic-speech-recognition', modelId, {
    device,
    dtype: DTYPES[device],
    progress_callback: onProgress,
  })) as AutomaticSpeechRecognitionPipeline;
}

function load(modelId: string, requestId: number): Promise<Loaded> {
  if (loading?.modelId === modelId) return loading.promise;

  const previous = loading;
  // Byte-level callbacks fire thousands of times; forward only whole-percent steps.
  let lastPercent = -1;
  const onProgress = (info: ProgressInfo) => {
    if (info.status !== 'progress_total') return;
    const percent = Math.floor(info.progress);
    if (percent <= lastPercent) return;
    lastPercent = percent;
    post({
      type: 'progress',
      id: requestId,
      progress: { percent: info.progress, loaded: info.loaded, total: info.total },
    });
  };

  const promise = (async (): Promise<Loaded> => {
    await previous?.promise.then((old) => old.asr.dispose()).catch(() => {});
    const preferred = await pickDevice();
    try {
      return { modelId, device: preferred, asr: await createPipeline(modelId, preferred, onProgress) };
    } catch (err) {
      if (preferred === 'wasm') throw err;
      // A GPU that reports an adapter can still fail to build the session.
      console.warn('[transcriber] WebGPU failed, falling back to WASM', err);
      return { modelId, device: 'wasm', asr: await createPipeline(modelId, 'wasm', onProgress) };
    }
  })();

  loading = { modelId, promise };
  // Let a later `load` retry instead of replaying the failure.
  promise.catch(() => {
    if (loading?.promise === promise) loading = null;
  });
  return promise;
}

function describe(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

async function handle(request: WorkerRequest) {
  const { id } = request;

  if (request.type === 'load') {
    try {
      const { device, modelId } = await load(request.modelId, id);
      post({ type: 'ready', id, device, modelId });
    } catch (err) {
      post({ type: 'error', id, code: 'model-load-failed', message: `Could not load the model: ${describe(err)}` });
    }
    return;
  }

  if (!loading) {
    post({ type: 'error', id, code: 'model-load-failed', message: 'Call load before transcribe.' });
    return;
  }

  const run = queue.then(async () => {
    try {
      assertUsableAudio(request.audio);
      let asr: AutomaticSpeechRecognitionPipeline;
      try {
        ({ asr } = await loading!.promise);
      } catch (err) {
        throw new TranscriberError('model-load-failed', `Could not load the model: ${describe(err)}`);
      }
      // Whisper sees 30 s windows; longer clips need chunking or they are cut off.
      // English-only models reject `language`/`task`, so neither is passed.
      const output = await asr(request.audio, { chunk_length_s: 30, stride_length_s: 5 });
      const text = cleanTranscript(Array.isArray(output) ? output.map((o) => o.text).join(' ') : output.text);
      if (!text) throw new TranscriberError('no-speech', 'No speech was detected.');
      post({ type: 'result', id, text });
    } catch (err) {
      if (err instanceof TranscriberError) {
        post({ type: 'error', id, code: err.code, message: err.message });
      } else {
        post({ type: 'error', id, code: 'transcription-failed', message: `Transcription failed: ${describe(err)}` });
      }
    }
  });
  queue = run;
  await run;
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data);
});
