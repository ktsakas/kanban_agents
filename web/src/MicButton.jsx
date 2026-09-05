import { useCallback, useEffect, useRef, useState } from 'react';

const SpeechRecognitionImpl =
  typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

const ERROR_MESSAGES = {
  'not-allowed':
    'Microphone blocked. Click the padlock in the address bar and allow the microphone — or open this page in Chrome or Edge directly, since embedded browsers block capture entirely.',
  'service-not-allowed':
    'Windows is blocking the speech service. Turn on Settings > Privacy & security > Speech > Online speech recognition.',
  'audio-capture': 'No microphone was found.',
  network:
    "Chrome could not reach Google's speech service. This is usually a VPN, proxy, DNS filter or extension blocking it rather than your connection.",
  'no-speech': 'Nothing was heard.',
  'start-failed': 'The microphone could not be started.',
  unsupported: 'Dictation needs Chrome or Edge — this browser has no Web Speech API.',
};

function errorMessage(code) {
  return ERROR_MESSAGES[code] || `Dictation failed (${code}).`;
}

/* --------------------------------- Brave --------------------------------- */

/**
 * Brave is Chromium, so `webkitSpeechRecognition` exists — but Brave ships
 * without Google's Web Speech API keys, so every cloud recognition fails with
 * `network` no matter how good the connection is. Worth naming explicitly
 * instead of telling the user to check their internet.
 */
let isBrave = false;
if (typeof navigator !== 'undefined' && navigator.brave?.isBrave) {
  navigator.brave
    .isBrave()
    .then((v) => {
      isBrave = v;
    })
    .catch(() => {});
}

/* ------------------------- on-device recognition ------------------------- */

/**
 * Chrome 137+ can run recognition locally, which both avoids the cloud
 * service (the usual cause of a `network` error on a perfectly good
 * connection) and keeps the audio on the machine. It needs a language pack
 * downloaded once.
 */
const localApi = {
  supported:
    !!SpeechRecognitionImpl &&
    typeof SpeechRecognitionImpl.available === 'function' &&
    'processLocally' in (SpeechRecognitionImpl.prototype ?? {}),

  async availability(lang) {
    if (!this.supported) return 'unsupported';
    try {
      return await SpeechRecognitionImpl.available({ langs: [lang], processLocally: true });
    } catch {
      return 'unsupported';
    }
  },

  /** Must be called from a user gesture; downloads the pack (tens of MB). */
  async install(lang) {
    const fn = SpeechRecognitionImpl.install ?? SpeechRecognitionImpl.installOnDevice;
    if (typeof fn !== 'function') return false;
    try {
      return await fn.call(SpeechRecognitionImpl, { langs: [lang] });
    } catch {
      return false;
    }
  },
};

/* -------------------------------- hook ----------------------------------- */

/**
 * Drives browser SpeechRecognition sessions and hands finished phrases back
 * to the caller. Interim (not-yet-final) words are never surfaced — only
 * committed transcript chunks — so callers can just append text.
 *
 * Chrome/Edge end the recognition object after a few seconds of silence even
 * in `continuous` mode, and calling `.start()` again on that same (now-ended)
 * instance throws `InvalidStateError` because it hasn't finished tearing down.
 * So a restart always spins up a **new** instance after a short delay.
 */
function useDictation(onFinalText) {
  const lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';

  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const [local, setLocal] = useState('unknown');
  const [installing, setInstalling] = useState(false);

  const recognitionRef = useRef(null);
  const wantRef = useRef(false);
  const restartTimerRef = useRef(null);
  const silentCyclesRef = useRef(0);
  const localRef = useRef('unknown');
  const onFinalRef = useRef(onFinalText);
  onFinalRef.current = onFinalText;

  const setLocalState = useCallback((value) => {
    localRef.current = value;
    setLocal(value);
  }, []);

  useEffect(() => {
    let alive = true;
    localApi.availability(lang).then((state) => {
      if (alive) setLocalState(state);
    });
    return () => {
      alive = false;
      wantRef.current = false;
      clearTimeout(restartTimerRef.current);
      recognitionRef.current?.stop();
    };
  }, [lang, setLocalState]);

  const spawn = () => {
    const rec = new SpeechRecognitionImpl();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    // Only claim local processing when the pack is actually present; asking
    // for it otherwise fails the whole session rather than falling back.
    if (localApi.supported && localRef.current === 'available') {
      try {
        rec.processLocally = true;
      } catch {
        /* older builds expose the property but reject the assignment */
      }
    }

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

    // 'no-speech' just means this instance timed out on silence — onend
    // decides whether to respawn. Anything else (permission, service, network,
    // hardware) is fatal: stop and surface it instead of flapping silently.
    rec.onerror = (e) => {
      if (e.error === 'no-speech') return;
      wantRef.current = false;
      setError(e.error);
    };

    rec.onend = () => {
      recognitionRef.current = null;
      // Cap respawns that heard nothing, or a mic left on by accident loops
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

  const start = async () => {
    if (!SpeechRecognitionImpl) return;
    setError(null);
    silentCyclesRef.current = 0;
    // Re-check: a pack installed since mount flips us to local for free.
    if (localApi.supported && localRef.current !== 'available') {
      setLocalState(await localApi.availability(lang));
    }
    wantRef.current = true;
    attempt();
  };

  const stop = () => {
    wantRef.current = false;
    clearTimeout(restartTimerRef.current);
    recognitionRef.current?.stop();
    setListening(false);
  };

  /** Download the local pack, then start listening on it. */
  const installLocal = async () => {
    setInstalling(true);
    setError(null);
    await localApi.install(lang);
    const state = await localApi.availability(lang);
    setLocalState(state);
    setInstalling(false);
    if (state === 'available') start();
    else setError('install-failed');
  };

  return {
    supported: !!SpeechRecognitionImpl,
    brave: isBrave,
    listening,
    error,
    local,
    installing,
    lang,
    installLocal,
    canInstallLocal: localApi.supported && ['downloadable', 'downloading'].includes(local),
    toggle: () => (listening ? stop() : start()),
  };
}

/* ------------------------------- component -------------------------------- */

/**
 * A mic toggle that appends dictated speech to whatever the caller is
 * holding. Pass `onText(chunk)` to append `chunk` to your field's value —
 * this component owns no text state itself.
 */
export default function MicButton({ onText, title = 'Dictate', className = '' }) {
  const {
    supported,
    brave,
    listening,
    error,
    local,
    installing,
    lang,
    installLocal,
    canInstallLocal,
    toggle,
  } = useDictation(onText);

  const failure = !supported ? 'unsupported' : error;

  let label = '🎤';
  let tip = local === 'available' ? `${title} (on-device)` : title;
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
        disabled={!supported || installing}
        title={tip}
      >
        {label}
      </button>

      {/* A 26px button's tooltip is not a place to explain a failure. */}
      {failure && (
        <p className="mic-status is-error">
          {failure === 'install-failed'
            ? 'The offline speech pack could not be installed.'
            : failure === 'network' && brave
              ? "Brave ships without Google's speech API keys, so cloud dictation can never work here."
              : errorMessage(failure)}
          {canInstallLocal ? (
            <>
              {' '}
              <button type="button" className="mic-link" onClick={installLocal}>
                Install offline speech ({lang})
              </button>{' '}
              to dictate on-device instead.
            </>
          ) : (
            failure === 'network' &&
            brave && <> Use Chrome or Edge for dictation.</>
          )}
        </p>
      )}

      {installing && <p className="mic-status">Downloading the offline speech pack…</p>}

      {!failure && !installing && listening && (
        <p className="mic-status">
          Listening{local === 'available' ? ' on-device' : ''} — click the dot to stop.
        </p>
      )}
    </>
  );
}

/** Appends a new chunk to existing text, adding a separating space when needed. */
export function appendDictation(existing, chunk) {
  if (!existing) return chunk;
  return /\s$/.test(existing) ? existing + chunk : `${existing} ${chunk}`;
}
