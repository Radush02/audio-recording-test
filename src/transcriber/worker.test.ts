import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRequest, WorkerResponse } from './protocol';

const pipelineMock = vi.fn();
vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: (...args: unknown[]) => pipelineMock(...args),
}));

/** Stands in for DedicatedWorkerGlobalScope. */
class FakeScope extends EventTarget {
  posted: WorkerResponse[] = [];
  postMessage(message: WorkerResponse) {
    this.posted.push(message);
  }
  send(message: WorkerRequest) {
    this.dispatchEvent(new MessageEvent('message', { data: message }));
  }
}

let scope: FakeScope;

function speech(seconds = 1) {
  const out = new Float32Array(16_000 * seconds);
  for (let i = 0; i < out.length; i++) out[i] = 0.2 * Math.sin(i / 10);
  return out;
}

function fakeAsr(text = ' Hello. ') {
  const asr = Object.assign(vi.fn(async () => ({ text })), { dispose: vi.fn(async () => {}) });
  return asr;
}

function setGpu(adapter: unknown) {
  Object.defineProperty(navigator, 'gpu', {
    value: adapter === undefined ? undefined : { requestAdapter: vi.fn(async () => adapter) },
    configurable: true,
  });
}

/** Resolves once the worker has posted a final (non-progress) reply for `id`. */
async function replyFor(id: number) {
  await vi.waitFor(() => {
    if (!scope.posted.some((m) => m.id === id && m.type !== 'progress')) throw new Error('waiting');
  });
  return scope.posted.find((m) => m.id === id && m.type !== 'progress')!;
}

beforeEach(async () => {
  vi.resetModules();
  pipelineMock.mockReset();
  scope = new FakeScope();
  vi.stubGlobal('self', scope);
  setGpu({});
  await import('./worker');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('transcription worker', () => {
  it('uses WebGPU with fp32 encoder and q4 decoder when an adapter exists', async () => {
    pipelineMock.mockResolvedValue(fakeAsr());
    scope.send({ type: 'load', id: 1, modelId: 'm' });
    expect(await replyFor(1)).toEqual({ type: 'ready', id: 1, device: 'webgpu', modelId: 'm' });
    expect(pipelineMock).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      'm',
      expect.objectContaining({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }),
    );
  });

  it('uses WASM with q8 weights when requestAdapter returns null', async () => {
    setGpu(null);
    pipelineMock.mockResolvedValue(fakeAsr());
    scope.send({ type: 'load', id: 1, modelId: 'm' });
    expect(await replyFor(1)).toMatchObject({ device: 'wasm' });
    expect(pipelineMock).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      'm',
      expect.objectContaining({ device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } }),
    );
  });

  it('falls back to WASM when WebGPU session creation fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    pipelineMock.mockRejectedValueOnce(new Error('webgpu boom')).mockResolvedValueOnce(fakeAsr());
    scope.send({ type: 'load', id: 1, modelId: 'm' });
    expect(await replyFor(1)).toMatchObject({ type: 'ready', device: 'wasm' });
  });

  it('forwards aggregate download progress in whole-percent steps', async () => {
    pipelineMock.mockImplementation(async (_t, _m, opts: { progress_callback: (i: unknown) => void }) => {
      const total = (progress: number) =>
        opts.progress_callback({ status: 'progress_total', progress, loaded: progress, total: 100, files: {} });
      opts.progress_callback({ status: 'progress', file: 'a', progress: 50, loaded: 5, total: 10 });
      total(25.1);
      total(25.7);
      total(26.2);
      total(100);
      return fakeAsr();
    });
    scope.send({ type: 'load', id: 1, modelId: 'm' });
    await replyFor(1);
    expect(scope.posted.filter((m) => m.type === 'progress').map((m) => 'progress' in m && m.progress.percent)).toEqual([
      25.1, 26.2, 100,
    ]);
  });

  it('reports model-load-failed and allows a retry', async () => {
    setGpu(null);
    pipelineMock.mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce(fakeAsr());
    scope.send({ type: 'load', id: 1, modelId: 'm' });
    expect(await replyFor(1)).toMatchObject({ type: 'error', code: 'model-load-failed' });
    scope.send({ type: 'load', id: 2, modelId: 'm' });
    expect(await replyFor(2)).toMatchObject({ type: 'ready' });
  });

  it('loads a model once for repeated load calls', async () => {
    pipelineMock.mockResolvedValue(fakeAsr());
    scope.send({ type: 'load', id: 1, modelId: 'm' });
    scope.send({ type: 'load', id: 2, modelId: 'm' });
    await replyFor(1);
    await replyFor(2);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('transcribes with 30 s chunking and cleans the text', async () => {
    const asr = fakeAsr(' [BLANK_AUDIO] Hello world. ');
    pipelineMock.mockResolvedValue(asr);
    scope.send({ type: 'load', id: 1, modelId: 'm' });
    const audio = speech();
    scope.send({ type: 'transcribe', id: 2, audio });
    expect(await replyFor(2)).toEqual({ type: 'result', id: 2, text: 'Hello world.' });
    expect(asr).toHaveBeenCalledWith(audio, { chunk_length_s: 30, stride_length_s: 5 });
  });

  it('rejects silent audio without running the model', async () => {
    const asr = fakeAsr();
    pipelineMock.mockResolvedValue(asr);
    scope.send({ type: 'load', id: 1, modelId: 'm' });
    scope.send({ type: 'transcribe', id: 2, audio: new Float32Array(16_000) });
    expect(await replyFor(2)).toMatchObject({ type: 'error', code: 'no-speech' });
    expect(asr).not.toHaveBeenCalled();
  });

  it('reports no-speech when the model returns only tags', async () => {
    pipelineMock.mockResolvedValue(fakeAsr('[BLANK_AUDIO]'));
    scope.send({ type: 'load', id: 1, modelId: 'm' });
    scope.send({ type: 'transcribe', id: 2, audio: speech() });
    expect(await replyFor(2)).toMatchObject({ type: 'error', code: 'no-speech' });
  });

  it('requires load before transcribe', async () => {
    scope.send({ type: 'transcribe', id: 1, audio: speech() });
    expect(await replyFor(1)).toMatchObject({ type: 'error', code: 'model-load-failed' });
  });

  it('runs transcriptions one at a time', async () => {
    let active = 0;
    let maxActive = 0;
    const asr = Object.assign(
      vi.fn(async () => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { text: 'ok' };
      }),
      { dispose: vi.fn() },
    );
    pipelineMock.mockResolvedValue(asr);
    scope.send({ type: 'load', id: 1, modelId: 'm' });
    scope.send({ type: 'transcribe', id: 2, audio: speech() });
    scope.send({ type: 'transcribe', id: 3, audio: speech() });
    await replyFor(2);
    await replyFor(3);
    expect(maxActive).toBe(1);
  });

  it('maps inference errors to transcription-failed', async () => {
    const asr = Object.assign(vi.fn(async () => Promise.reject(new Error('OOM'))), { dispose: vi.fn() });
    pipelineMock.mockResolvedValue(asr);
    scope.send({ type: 'load', id: 1, modelId: 'm' });
    scope.send({ type: 'transcribe', id: 2, audio: speech() });
    expect(await replyFor(2)).toMatchObject({ type: 'error', code: 'transcription-failed' });
  });
});
