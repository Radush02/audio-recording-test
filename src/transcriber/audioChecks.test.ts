import { describe, expect, it } from 'vitest';
import { assertUsableAudio, cleanTranscript, SAMPLE_RATE } from './audioChecks';

function tone(seconds: number, amplitude: number) {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
  return out;
}

describe('assertUsableAudio', () => {
  it('accepts audible audio', () => {
    expect(() => assertUsableAudio(tone(1, 0.2))).not.toThrow();
  });

  it('accepts mostly-silent audio with a short audible burst', () => {
    const audio = new Float32Array(SAMPLE_RATE * 3);
    audio.set(tone(0.1, 0.2), SAMPLE_RATE);
    expect(() => assertUsableAudio(audio)).not.toThrow();
  });

  it('rejects silence as no-speech', () => {
    expect(() => assertUsableAudio(new Float32Array(SAMPLE_RATE * 2))).toThrow(
      expect.objectContaining({ code: 'no-speech' }),
    );
  });

  it('rejects low-level noise as no-speech', () => {
    expect(() => assertUsableAudio(tone(2, 0.002))).toThrow(expect.objectContaining({ code: 'no-speech' }));
  });

  it('rejects clips under 250 ms', () => {
    expect(() => assertUsableAudio(tone(0.2, 0.5))).toThrow(expect.objectContaining({ code: 'no-speech' }));
  });

  it('rejects non-Float32Array input', () => {
    expect(() => assertUsableAudio([0.1, 0.2])).toThrow(expect.objectContaining({ code: 'invalid-audio' }));
  });

  it('rejects NaN samples', () => {
    const audio = tone(1, 0.2);
    audio[100] = NaN;
    expect(() => assertUsableAudio(audio)).toThrow(expect.objectContaining({ code: 'invalid-audio' }));
  });
});

describe('cleanTranscript', () => {
  it.each([
    [' Hello there. ', 'Hello there.'],
    ['[BLANK_AUDIO]', ''],
    ['(music) Hi [noise] there', 'Hi there'],
    ['  ', ''],
  ])('%j -> %j', (input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });
});
