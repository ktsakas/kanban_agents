import { useEffect, useRef, useState } from 'react';

const SpeechRecognitionImpl =
  typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

const ERROR_MESSAGES = {
  'not-allowed':
    'Microphone blocked. Click the padlock in the address bar and allow the microphone — or open this page in Chrome or Edge directly, since embedded browsers block capture entirely.',
  'service-not-allowed':
    'Windows is blocking the speech service. Turn on Settings > Privacy & security > Speech > Online speech recognition.',
  'audio-capture': 'No microphone was found.',
  network: 'Could not reach the speech service. Dictation needs an internet connection.',
  'no-speech': 'Nothing was heard.',
  'start-failed': 'The microphone could not be started.',
  unsupported: 'Dictation needs Chrome or Edge — this browser has no Web Speech API.',
};

function errorMessage(code) {
  return ERROR_MESSAGES[code] || `Dictation failed (${code}).`;
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
  const silentCyclesRef = useRef(0);
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
        silentCyclesRef.current = 0;
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
      // Chrome ends on silence even in continuous mode, so we respawn. Cap the
      // respawns that heard nothing at all, or a mic left on by accident loops
      // forever with no visible sign of it.
      if (wantRef.current && silentCyclesRef.current < 4) {
        silentCyclesRef.current += 1;
        restartTimerRef.current = setTimeout(() => {
          if (wantRef.current) attempt();
        }, 250);
        return;
      }
      if (wantRef.current) {
        wantRef.current = false;
        setError('no-speech');
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
    silentCyclesRef.current = 0;
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

  const failure = !supported ? 'unsupported' : error;

  let label = '🎤';
  let tip = title;
  let stateClass = '';
  if (failure) {
    label = '⚠';
    tip = errorMessage(failure);
    stateClass = 'has-error';
  } else if (listening) {
    label = '●';
    tip = 'Listening — click to stop';
    stateClass = 'is-listening';
  }

  return (
    <>
      <button
        type="button"
        className={`mic-btn ${stateClass} ${className}`}
        onClick={toggle}
        disabled={!supported}
        title={tip}
      >
        {label}
      </button>
      {/* A 26px button's tooltip is not a place to explain a failure. */}
      {failure && <p className="mic-status is-error">{errorMessage(failure)}</p>}
      {listening && <p className="mic-status">Listening — click the dot to stop.</p>}
    </>
  );
}

/** Appends a new chunk to existing text, adding a separating space when needed. */
export function appendDictation(existing, chunk) {
  if (!existing) return chunk;
  return /\s$/.test(existing) ? existing + chunk : `${existing} ${chunk}`;
}
