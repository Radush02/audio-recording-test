# Click-to-Record Voice Input (React, on-device Whisper)

Nov 17, 2026 · @Radu

## End result

A React component, `<VoiceInput />`, with a single button that records a clip of up to 60 seconds and turns it into English text entirely on the user's device, with no backend and no API key.

**Flow**

1. The first click asks for microphone permission and starts recording. The button shows a recording state with a timer.
2. The next click stops recording. A 60-second cap auto-stops it.
3. The audio is transcribed on-device with a small English Whisper model (`whisper-tiny.en` or `base.en`) through Transformers.js, inside a Web Worker so the UI stays responsive. It uses WebGPU where available and WASM otherwise.
4. The text is returned through an `onTranscript(text)` callback.

**States:** idle, requesting permission, recording, loading model (with progress), transcribing, done, error.

**Behaviors**

- The first use downloads the model and shows a progress bar. After that the browser cache makes loading fast.
- Audio is converted to mono 16 kHz before transcription. Whisper gives wrong output with no error if the sample rate is off.
- No audio leaves the device.

**Edge cases to handle**

- Microphone permission denied, or no microphone present.
- Insecure context (needs HTTPS or localhost).
- Target is Chrome on macOS only, so no Safari or Firefox handling is needed.
- Empty or too-short clips.
- Model failing to load.

**Out of scope:** live streaming text, multiple languages, speaker labels, recordings longer than a minute.

## Prompt 1: audio capture

Run the three prompts in order, one per agent.

> Build a React hook `useAudioRecorder` in TypeScript. It requests microphone access, records with `MediaRecorder`, and exposes `{ status, start, stop, cancel, durationMs, error }`. It must pick a supported MIME type at runtime (webm/opus on Chrome), auto-stop at a configurable max duration (default 60s), release the mic tracks on stop, cancel, and unmount, and map failures (permission denied, no device, insecure context, unsupported browser) to typed error codes. When recording stops, it should return a decoded, mono, 16 kHz `Float32Array` (decode with `AudioContext.decodeAudioData`, then resample with `OfflineAudioContext`). Don't add UI or transcription. Include unit tests with mocked browser APIs and a short README section on the hook's contract.

## Prompt 2: transcription worker

> Build an on-device speech-to-text module using `@huggingface/transformers`. Create a Web Worker that loads the `automatic-speech-recognition` pipeline with an English-only Whisper model (make the model id configurable, default to a tiny/base English model from `onnx-community`). Use WebGPU when `navigator.gpu.requestAdapter()` actually returns an adapter, otherwise fall back to WASM, and use quantized weights. Define a typed message protocol: `load` (emits progress events), `transcribe` (takes a 16 kHz mono `Float32Array`, returns text), plus `error` and `ready`. Add a small main-thread wrapper `createTranscriber()` that returns promises, reports load progress, and can be terminated. Handle the model failing to download, empty or silent audio, and repeated calls. No React and no recording code. Document how Vite (the project's bundler) must be configured for workers and WASM files.

## Prompt 3: the component

> Build the `<VoiceInput />` React component by combining `useAudioRecorder` and `createTranscriber`. Props: `onTranscript(text: string)`, `maxDurationSec` (default 60), `disabled`, and optional `className`. A single button cycles through idle → recording (with timer) → transcribing → done, and shows model-download progress on first use. Start loading the model lazily on the first click (or on hover or focus), not at page load. Show clear, accessible error messages for each error code, use proper ARIA labels and live-region announcements for state changes, and let the user cancel while recording. Add tests for the state transitions with the hook and worker mocked, and a minimal demo page. Don't change the hook's or transcriber's public APIs. If they're awkward to use, tell me instead of editing them.

## Notes before running the prompts

- **Model size:** the download is the main UX cost. `tiny.en` is the smallest and fastest but makes more mistakes. `base.en` is noticeably more accurate and still reasonable for clips under a minute. Sizes are approximate, from memory: tens to a few hundred MB.
- **Bundler:** The project uses Vite, so Prompt 2 asks for Vite-specific worker and WASM setup.
- **Safari and iOS:** not targets. The component only needs to run on Chrome on macOS, where WebGPU is available, so the WASM fallback is a safety net.
- **Why not the Web Speech API:** in Chrome it sends audio to Google's servers, which breaks the on-device requirement.
