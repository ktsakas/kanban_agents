import { useEffect, useRef, useState } from 'react';

const SpeechRecognitionImpl =
  typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

const ERROR_MESSAGES = {
  'not-allowed': 'Microphone permission was denied',
  'service-not-allowed':
    'Speech service blocked — on Windows, check Settings > Privacy & security > Speech > Online speech recognition',
  'audio-capture': 'No microphone found',
  network: 'Speech service unreachable — check your internet connection',
  'no-speech': "Didn't hear anything",
  'start-failed': 'Could not start the microphone',
};

function errorMessage(code) {
  return ERROR_MESSAGES[code] || `Dictation error (${code})`;
}

/**
 * Drives browser SpeechRecognition sessions and hands finished phrases back
 * to the caller. Interim (not-yet-final) words are never surfaced — only
 * committed transcript chunks — so callers can just append text.
 *
 * Chrome/Edge end the recognition object after a few seconds of silence even
 * in `continuous` mode, and — critically — calling `.start()` again on that
 * same (now-ended) instance throws `InvalidStateError` in most builds because
 * it hasn't finished tearing down yet. So a restart always spins up a **new**
 * instance, after a short delay, rather than reusing the old one.
 */
function useDictation(onFinalText) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const recognitionRef = useRef(null);
  const wantRef = useRef(false);
  const restartTimerRef = useRef(null);
  const onFinalRef = useRef(onFinalText);
  onFinalRef.current = onFinalText;

  useEffect(
    () => () => {
      wantRef.current = false;
      clearTimeout(restartTimerRef.current);
      recognitionRef.current?.stop();
    },
    [],
  );

  const spawn = () => {
    const rec = new SpeechRecognitionImpl();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
      let chunk = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const res = e.results[i];
        if (res.isFinal) chunk += res[0].transcript;
      }
      if (chunk.trim()) {
        setError(null);
        onFinalRef.current(chunk.trim());
      }
    };

    // 'no-speech' just means the current instance timed out with silence —
    // onend fires right after and decides whether to spin up a fresh one.
    // Anything else (permission, service, network, mic hardware) is fatal:
    // stop trying and surface it instead of flapping silently.
    rec.onerror = (e) => {
      if (e.error === 'no-speech') return;
      wantRef.current = false;
      setError(e.error);
    };

    rec.onend = () => {
      recognitionRef.current = null;
      if (wantRef.current) {
        restartTimerRef.current = setTimeout(() => {
          if (wantRef.current) attempt();
        }, 250);
        return;
      }
      setListening(false);
    };

    return rec;
  };

  const attempt = () => {
    const rec = spawn();
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      wantRef.current = false;
      setListening(false);
      setError('start-failed');
    }
  };

  const start = () => {
    if (!SpeechRecognitionImpl) return;
    setError(null);
    wantRef.current = true;
    attempt();
  };

  const stop = () => {
    wantRef.current = false;
    clearTimeout(restartTimerRef.current);
    recognitionRef.current?.stop();
    setListening(false);
  };

  return {
    supported: !!SpeechRecognitionImpl,
    listening,
    error,
    toggle: () => (listening ? stop() : start()),
  };
}

/**
 * A mic toggle that appends dictated speech to whatever the caller is
 * holding. Pass `onText(chunk)` to append `chunk` to your field's value —
 * this component owns no text state itself.
 */
export default function MicButton({ onText, title = 'Dictate', className = '' }) {
  const { supported, listening, error, toggle } = useDictation(onText);

  let label = '🎤';
  let tip = title;
  let stateClass = '';
  if (!supported) {
    tip = 'Voice dictation needs Chrome or Edge';
  } else if (listening) {
    label = '●';
    tip = 'Listening… click to stop';
    stateClass = 'is-listening';
  } else if (error) {
    label = '⚠';
    tip = errorMessage(error);
    stateClass = 'has-error';
  }

  return (
    <button
      type="button"
      className={`mic-btn ${stateClass} ${className}`}
      onClick={toggle}
      disabled={!supported}
      title={tip}
    >
      {label}
    </button>
  );
}

/** Appends a new chunk to existing text, adding a separating space when needed. */
export function appendDictation(existing, chunk) {
  if (!existing) return chunk;
  return /\s$/.test(existing) ? existing + chunk : `${existing} ${chunk}`;
}
