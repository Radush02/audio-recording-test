/** Message protocol between `createTranscriber()` and `worker.ts`. */

export type Device = 'webgpu' | 'wasm';

export type TranscriberErrorCode =
  /** Model files failed to download, or the runtime could not start. */
  | 'model-load-failed'
  /** The clip is silent, or the model heard nothing it could transcribe. */
  | 'no-speech'
  /** The input was not a usable 16 kHz mono Float32Array. */
  | 'invalid-audio'
  | 'transcription-failed'
  /** `terminate()` was called while the request was pending. */
  | 'terminated';

export interface LoadProgress {
  /** 0–100 across all model files. */
  percent: number;
  loaded: number;
  total: number;
}

export type WorkerRequest =
  | { type: 'load'; id: number; modelId: string }
  | { type: 'transcribe'; id: number; audio: Float32Array };

export type WorkerResponse =
  | { type: 'progress'; id: number; progress: LoadProgress }
  | { type: 'ready'; id: number; device: Device; modelId: string }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; code: TranscriberErrorCode; message: string };

export class TranscriberError extends Error {
  readonly code: TranscriberErrorCode;

  constructor(code: TranscriberErrorCode, message: string) {
    super(message);
    this.name = 'TranscriberError';
    this.code = code;
  }
}
