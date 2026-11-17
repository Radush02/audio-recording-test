import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VoiceInput } from './components/VoiceInput';

function Demo() {
  const [text, setText] = useState('');
  const [disabled, setDisabled] = useState(false);

  return (
    <main style={{ maxWidth: 640, margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>VoiceInput demo</h1>
      <p>
        Click to record (up to a minute), click again to stop. Audio is transcribed on this device and never
        uploaded. The first use downloads the speech model.
      </p>

      <label htmlFor="notes" style={{ display: 'block', fontWeight: 600, marginTop: '1.5rem' }}>
        Notes
      </label>
      <textarea
        id="notes"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        style={{ width: '100%', boxSizing: 'border-box', font: 'inherit', marginBlock: '0.5rem' }}
      />

      <VoiceInput
        onTranscript={(transcript) => setText((prev) => (prev ? `${prev} ${transcript}` : transcript))}
        disabled={disabled}
      />

      <label style={{ display: 'block', marginTop: '1.5rem' }}>
        <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} /> Disable
        voice input
      </label>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
