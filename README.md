# VoiceInput

A React button that records up to 60 seconds of speech and turns it into English text **on the user's device**: no backend, no API key, and no audio leaves the browser. Transcription uses Whisper through [Transformers.js](https://github.com/huggingface/transformers.js), in a Web Worker, on WebGPU with a WASM fallback.

Target: Chrome on macOS. Safari and Firefox are not handled.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173 for the demo page. `npm test` runs the unit tests and `npm run build` typechecks and builds.

## Usage

```tsx
import { VoiceInput } from './components/VoiceInput';

<VoiceInput onTranscript={(text) => setNotes((n) => `${n} ${text}`)} />;
```

| Prop | Type | Default | |
|---|---|---|---|
| `onTranscript` | `(text: string) => void` | required | Called once per successful recording. |
| `maxDurationSec` | `number` | `60` | Recording stops by itself at this length. |
| `disabled` | `boolean` | `false` | Disables the button; cancels a recording in progress. |
| `className` | `string` | | Added to the root element. |

States: idle → requesting (permission prompt) → recording (timer, Cancel button, Escape cancels) → loading model (only if the download hasn't finished yet) → transcribing → done, or error with a message specific to the cause. The model starts downloading when the pointer enters or focus reaches the button, never at page load, and progress is shown under the button.

## Layout

```
src/
  audio/
    useAudioRecorder.ts   mic → MediaRecorder → mono 16 kHz Float32Array
    decode.ts             MIME selection, decode + resample
    errors.ts             RecorderError and its codes
  transcriber/
    createTranscriber.ts  main-thread promise API over the worker
    worker.ts             Transformers.js pipeline, device/dtype choice
    protocol.ts           typed messages and TranscriberError
    audioChecks.ts        silence gate, transcript cleanup
  components/
    VoiceInput.tsx/.css   the button
  main.tsx                demo page
```

## `useAudioRecorder` contract

```ts
const { status, start, stop, cancel, durationMs, error } = useAudioRecorder({
  maxDurationMs: 60_000, // auto-stop
  minDurationMs: 300,    // shorter recordings reject with 'empty-recording'
});
```

- `status`: `'idle' | 'requesting' | 'recording' | 'processing'`.
- `start(): Promise<RecordingResult | null>` asks for the mic and starts recording. **The promise settles when the recording ends**, however it ends (`stop()`, the max-duration cap, or the mic disconnecting): it resolves `{ audio: Float32Array, sampleRate: 16000, durationMs }`, resolves `null` if cancelled, or rejects with a `RecorderError`. Calling `start()` again while a recording is in progress returns the same promise.
- `stop()` returns that same promise. `cancel()` discards the recording.
- `durationMs` updates about every 100 ms. `error` holds the last `RecorderError` and clears on the next `start()`.
- Mic tracks are released on stop, cancel, error and unmount.
- `audio` is mono PCM at exactly 16 kHz: decoded with `AudioContext.decodeAudioData`, then downmixed and resampled with an `OfflineAudioContext`.

`RecorderError.code`: `permission-denied`, `no-device`, `device-busy`, `insecure-context`, `unsupported`, `empty-recording`, `decode-failed`, `unknown`.

## `createTranscriber` contract

```ts
const transcriber = createTranscriber({
  modelId: 'onnx-community/whisper-base.en', // default
  onProgress: ({ percent, loaded, total }) => {},
});
await transcriber.load();                 // { device: 'webgpu' | 'wasm' }
const text = await transcriber.transcribe(audio);
transcriber.terminate();
```

- `load()` is idempotent; concurrent calls share one load, and calling it again after a failure retries. `transcribe()` calls it for you.
- `transcribe()` **transfers** the audio buffer to the worker, so the caller's array is empty afterwards. A view onto a larger buffer is copied instead.
- Calls run one at a time in the worker. Clips over 30 s are chunked (30 s windows, 5 s overlap).
- Silent or near-silent clips, and clips under 250 ms, are rejected with `no-speech` **before** the model runs, because Whisper makes up text ("Thank you.") for silence. Bracketed tags like `[BLANK_AUDIO]` are stripped from output.
- `TranscriberError.code`: `model-load-failed`, `no-speech`, `invalid-audio`, `transcription-failed`, `terminated`.

## Model, device and download size

The worker uses WebGPU when `navigator.gpu.requestAdapter()` returns an adapter, and falls back to WASM if it doesn't, or if building the WebGPU session fails.

| | WebGPU (default on Chrome/macOS) | WASM fallback |
|---|---|---|
| Weights | encoder fp32, decoder q4 | encoder q8, decoder q8 |
| `whisper-base.en` download | ~206 MB | ~77 MB |
| `whisper-tiny.en` download | ~120 MB | ~41 MB |

Measured on an 11 s clip with `base.en` (Chromium 152, Windows desktop GPU; expect different numbers on a Mac): WebGPU fp32/q4 took 1.4 s warm, WebGPU with a q8 decoder 6.0 s, WASM q8 3.8 s. q8 runs poorly on WebGPU, so the WebGPU path keeps the larger q4 decoder in exchange for speed. If first-use download matters more than speed, change `DTYPES.webgpu` in `src/transcriber/worker.ts` or force WASM there. Files are cached by the browser after the first download (cached load: ~3.7 s here).

## Vite setup

Already configured in `vite.config.ts`:

- `worker: { format: 'es' }`: the worker is an ES module so it can `import` Transformers.js. It is created with `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`, which Vite detects and bundles as a separate chunk.
- `optimizeDeps.exclude: ['@huggingface/transformers']`: dependency pre-bundling breaks how onnxruntime-web finds its `.wasm`/`.mjs` files at runtime.
- Nothing else is needed: Vite emits the ONNX Runtime `.wasm` (~27 MB, ~6.7 MB gzipped) as a hashed asset next to the worker, so it is served from your origin rather than a CDN. Only the model weights come from huggingface.co. If your server sets a CSP, allow `huggingface.co` and `*.hf.co` in `connect-src`, and `'wasm-unsafe-eval'` in `script-src`.
- Transformers.js stays out of the main bundle; the page loads it only when the worker starts.

## Testing

`npm test` runs Vitest in jsdom. The browser APIs (MediaRecorder, getUserMedia, Web Audio), the worker and Transformers.js are mocked, so the tests cover state and error handling, not real audio or inference. Real behavior was checked manually in Chromium: a known speech clip fed through a fake `getUserMedia` went through MediaRecorder, decoding, the WebGPU worker and the UI, and came out as the correct text.
