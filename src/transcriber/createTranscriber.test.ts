import { describe, expect, it, vi } from 'vitest';
import { createTranscriber, DEFAULT_MODEL_ID } from './createTranscriber';
import type { WorkerRequest, WorkerResponse } from './protocol';

/** A Worker stand-in that records requests and lets the test reply. */
class FakeWorker extends EventTarget {
  sent: { message: WorkerRequest; transfer?: Transferable[] }[] = [];
  terminate = vi.fn();

  postMessage(message: WorkerRequest, transfer?: Transferable[]) {
    this.sent.push({ message, transfer });
  }
  reply(message: WorkerResponse) {
    this.dispatchEvent(new MessageEvent('message', { data: message }));
  }
  last() {
    return this.sent[this.sent.length - 1].message;
  }
  crash(message: string) {
    const event = new Event('error', { cancelable: true }) as Event & { message: string };
    event.message = message;
    this.dispatchEvent(event);
  }
}

function setup(options: Parameters<typeof createTranscriber>[0] = {}) {
  const worker = new FakeWorker();
  const transcriber = createTranscriber({ ...options, createWorker: () => worker as unknown as Worker });
  return { worker, transcriber };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createTranscriber', () => {
  it('loads the default model and reports progress', async () => {
    const onProgress = vi.fn();
    const { worker, transcriber } = setup({ onProgress });

    const loaded = transcriber.load();
    expect(transcriber.state).toBe('loading');
    const req = worker.last();
    expect(req).toMatchObject({ type: 'load', modelId: DEFAULT_MODEL_ID });

    worker.reply({ type: 'progress', id: req.id, progress: { percent: 40, loaded: 4, total: 10 } });
    expect(onProgress).toHaveBeenCalledWith({ percent: 40, loaded: 4, total: 10 });

    worker.reply({ type: 'ready', id: req.id, device: 'webgpu', modelId: DEFAULT_MODEL_ID });
    await expect(loaded).resolves.toEqual({ device: 'webgpu' });
    expect(transcriber.state).toBe('ready');
    expect(transcriber.device).toBe('webgpu');
  });

  it('shares one load between concurrent calls', () => {
    const { worker, transcriber } = setup();
    expect(transcriber.load()).toBe(transcriber.load());
    expect(worker.sent).toHaveLength(1);
  });

  it('uses the configured model id', () => {
    const { worker, transcriber } = setup({ modelId: 'onnx-community/whisper-tiny.en' });
    void transcriber.load();
    expect(worker.last()).toMatchObject({ modelId: 'onnx-community/whisper-tiny.en' });
  });

  it('retries after a failed load', async () => {
    const { worker, transcriber } = setup();
    const first = transcriber.load();
    worker.reply({ type: 'error', id: worker.last().id, code: 'model-load-failed', message: 'offline' });
    await expect(first).rejects.toMatchObject({ code: 'model-load-failed', message: 'offline' });
    expect(transcriber.state).toBe('error');

    const second = transcriber.load();
    expect(second).not.toBe(first);
    expect(worker.sent).toHaveLength(2);
  });

  it('loads before transcribing and transfers the audio buffer', async () => {
    const { worker, transcriber } = setup();
    const audio = new Float32Array(16_000);
    const result = transcriber.transcribe(audio);

    const load = worker.last();
    worker.reply({ type: 'ready', id: load.id, device: 'wasm', modelId: DEFAULT_MODEL_ID });
    await flush();

    const { message, transfer } = worker.sent[1];
    expect(message.type).toBe('transcribe');
    expect(transfer).toEqual([audio.buffer]);
    worker.reply({ type: 'result', id: message.id, text: 'hello world' });
    await expect(result).resolves.toBe('hello world');
  });

  it('copies a view instead of transferring its larger buffer', async () => {
    const { worker, transcriber } = setup();
    const backing = new Float32Array(32_000);
    const view = backing.subarray(16_000);
    void transcriber.transcribe(view);
    worker.reply({ type: 'ready', id: worker.last().id, device: 'wasm', modelId: DEFAULT_MODEL_ID });
    await flush();
    expect(worker.sent[1].transfer?.[0]).not.toBe(backing.buffer);
  });

  it('routes concurrent results by request id', async () => {
    const { worker, transcriber } = setup();
    void transcriber.load();
    worker.reply({ type: 'ready', id: worker.last().id, device: 'wasm', modelId: DEFAULT_MODEL_ID });
    const a = transcriber.transcribe(new Float32Array(10));
    const b = transcriber.transcribe(new Float32Array(10));
    await flush();
    const [, reqA, reqB] = worker.sent.map((s) => s.message);
    worker.reply({ type: 'result', id: reqB.id, text: 'second' });
    worker.reply({ type: 'result', id: reqA.id, text: 'first' });
    await expect(a).resolves.toBe('first');
    await expect(b).resolves.toBe('second');
  });

  it('passes worker error codes through', async () => {
    const { worker, transcriber } = setup();
    void transcriber.load();
    worker.reply({ type: 'ready', id: worker.last().id, device: 'wasm', modelId: DEFAULT_MODEL_ID });
    const result = transcriber.transcribe(new Float32Array(10));
    await flush();
    worker.reply({ type: 'error', id: worker.last().id, code: 'no-speech', message: 'silence' });
    await expect(result).rejects.toMatchObject({ name: 'TranscriberError', code: 'no-speech' });
  });

  it('rejects non-Float32Array input without contacting the worker', async () => {
    const { worker, transcriber } = setup();
    await expect(transcriber.transcribe([1, 2] as unknown as Float32Array)).rejects.toMatchObject({
      code: 'invalid-audio',
    });
    expect(worker.sent).toHaveLength(0);
  });

  it('terminate rejects pending calls and blocks new ones', async () => {
    const { worker, transcriber } = setup();
    const loading = transcriber.load();
    transcriber.terminate();
    expect(worker.terminate).toHaveBeenCalled();
    await expect(loading).rejects.toMatchObject({ code: 'terminated' });
    await expect(transcriber.transcribe(new Float32Array(10))).rejects.toMatchObject({ code: 'terminated' });
    expect(transcriber.state).toBe('terminated');
  });

  it('fails pending calls when the worker script crashes', async () => {
    const { worker, transcriber } = setup();
    const loading = transcriber.load();
    worker.crash('SyntaxError in worker');
    await expect(loading).rejects.toMatchObject({ code: 'model-load-failed', message: 'SyntaxError in worker' });
    expect(transcriber.state).toBe('error');
  });
});
