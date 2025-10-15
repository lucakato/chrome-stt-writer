import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMicrophonePermission } from '@shared/hooks/useMicrophonePermission';
import { useSpeechRecorder } from '@shared/hooks/useSpeechRecorder';
import type { EkkoMessage } from '@shared/messages';

type RewritePreset =
  | 'concise-formal'
  | 'expand'
  | 'casual'
  | 'bullet'
  | 'action-items'
  | 'custom';

type HistoryEntry = {
  id: string;
  title: string;
  createdAt: string;
  actions: string[];
};

const rewritePresets: Array<{ id: RewritePreset; label: string }> = [
  { id: 'concise-formal', label: 'Concise • Formal' },
  { id: 'expand', label: 'Expand' },
  { id: 'casual', label: 'Casual' },
  { id: 'bullet', label: 'Bullet list' },
  { id: 'action-items', label: 'Action items' },
  { id: 'custom', label: 'Custom instructions' }
];

const languageOptions: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto (browser locale)' },
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'fr-FR', label: 'Français (France)' },
  { value: 'es-ES', label: 'Español (España)' },
  { value: 'de-DE', label: 'Deutsch (Deutschland)' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'zh-CN', label: '中文（简体）' }
];

function formatPermission(status: ReturnType<typeof useMicrophonePermission>['status']) {
  switch (status) {
    case 'granted':
      return { text: 'Mic ready', active: true };
    case 'prompt':
      return { text: 'Permission required', active: false };
    case 'denied':
      return { text: 'Permission denied', active: false };
    case 'unsupported':
      return { text: 'Not supported', active: false };
    case 'pending':
    default:
      return { text: 'Checking permissions…', active: false };
  }
}

export default function App() {
  const { status: micStatus, requestPermission, error: micError } = useMicrophonePermission();
  const [transcript, setTranscript] = useState('');
  const [rewritePreset, setRewritePreset] = useState<RewritePreset>('concise-formal');
  const [directInsertEnabled, setDirectInsertEnabled] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [streamingSummary, setStreamingSummary] = useState<string | null>(null);
  const [language, setLanguage] = useState<string>(() => navigator.language ?? 'en-US');

  const pendingSyncRef = useRef<number | null>(null);
  const lastSyncedRef = useRef<string>('');

  const permissionMeta = useMemo(() => formatPermission(micStatus), [micStatus]);
  const isMicGranted = micStatus === 'granted';

  const chromeVersion = useMemo(() => {
    const uaData = (navigator as unknown as { userAgentData?: { brands?: Array<{ version?: string }> } }).userAgentData;
    if (uaData?.brands?.length) {
      return uaData.brands[0]?.version ?? '138+';
    }
    const match = navigator.userAgent.match(/Chrome\/(\d+)/);
    return match ? match[1] : '138+';
  }, []);

  const normalizedLanguage = useMemo(() => {
    if (language === 'auto') {
      return navigator.language ?? 'en-US';
    }
    return language;
  }, [language]);

  const appendFinalSegment = useCallback((segment: string) => {
    setTranscript((prev) => {
      if (!prev) {
        return segment;
      }
      const needsSpace = /[\s\n\r]$/.test(prev) ? '' : ' ';
      return `${prev}${needsSpace}${segment}`.trimStart();
    });
  }, []);

  const {
    isSupported: sttSupported,
    isListening,
    error: sttError,
    interimTranscript,
    start: startRecording,
    stop: stopRecording,
    resetError: resetSttError,
    clearInterim
  } = useSpeechRecorder({
    language: normalizedLanguage,
    onFinalResult: appendFinalSegment
  });

  const isRecording = isListening;

  const handleToggleRecording = useCallback(async () => {
    if (!isMicGranted) {
      const granted = await requestPermission();
      if (!granted) {
        return;
      }
    }

    if (isRecording) {
      stopRecording();
      return;
    }

    if (!sttSupported) {
      return;
    }

    resetSttError();
    const started = startRecording();
    if (!started) {
      console.warn('Speech recognition failed to start.');
    }
  }, [isMicGranted, isRecording, requestPermission, resetSttError, startRecording, stopRecording, sttSupported]);

  const displayTranscript = useMemo(() => {
    if (!isRecording || !interimTranscript) {
      return transcript;
    }

    const needsSpace =
      transcript.length === 0 || /[\s\n\r]$/.test(transcript) ? '' : ' ';
    return `${transcript}${needsSpace}${interimTranscript}`;
  }, [interimTranscript, isRecording, transcript]);

  const activeTranscript = useMemo(() => displayTranscript.trim(), [displayTranscript]);

  const handleSummarize = useCallback(() => {
    if (!activeTranscript) {
      return;
    }

    setTranscript(activeTranscript);
    // Placeholder for Summarizer API integration.
    setStreamingSummary('Summaries will appear here once the Summarizer API is wired in.');
    setHistory((entries) => [
      {
        id: crypto.randomUUID(),
        title: activeTranscript.slice(0, 60) || 'Untitled transcript',
        createdAt: new Date().toLocaleTimeString(),
        actions: ['Summarized']
      },
      ...entries
    ]);
  }, [activeTranscript]);

  const handleRewrite = useCallback(() => {
    if (!activeTranscript) {
      return;
    }

    setTranscript(activeTranscript);
    setHistory((entries) => [
      {
        id: crypto.randomUUID(),
        title: activeTranscript.slice(0, 60) || 'Untitled transcript',
        createdAt: new Date().toLocaleTimeString(),
        actions: [`Rewritten (${rewritePreset})`]
      },
      ...entries
    ]);
  }, [activeTranscript, rewritePreset]);

  const handleCopy = useCallback(async () => {
    if (!activeTranscript) return;
    try {
      await navigator.clipboard.writeText(activeTranscript);
    } catch (copyError) {
      console.warn('Unable to copy transcript', copyError);
    }
  }, [activeTranscript]);

  const handleDirectInsertToggle = useCallback(
    (enabled: boolean) => {
      setDirectInsertEnabled(enabled);
      chrome.runtime
        ?.sendMessage({
          type: 'ekko/direct-insert/toggle',
          payload: { enabled }
        } satisfies EkkoMessage)
        .catch((error: unknown) => {
          console.warn('Unable to toggle direct insert bridge', error);
        });
    },
    []
  );

  useEffect(() => {
    if (pendingSyncRef.current) {
      window.clearTimeout(pendingSyncRef.current);
    }

    const payloadTranscript = displayTranscript;

    pendingSyncRef.current = window.setTimeout(() => {
      if (payloadTranscript === lastSyncedRef.current) {
        return;
      }

      chrome.runtime
        ?.sendMessage({
          type: 'ekko/transcript/update',
          payload: {
            transcript: payloadTranscript,
            origin: 'panel'
          }
        } satisfies EkkoMessage)
        .then(() => {
          lastSyncedRef.current = payloadTranscript;
        })
        .catch((error: unknown) => {
          console.warn('Unable to sync transcript to background', error);
        });
    }, 150);

    return () => {
      if (pendingSyncRef.current) {
        window.clearTimeout(pendingSyncRef.current);
        pendingSyncRef.current = null;
      }
    };
  }, [displayTranscript]);

  return (
    <div className="app" role="application">
      <header className="app__header">
        <div className="brand">
          <span className="brand__title">Ekko: Write with Voice</span>
          <span className="brand__subtitle">Live capture • On-device AI polish</span>
        </div>
        <span className="pill">Chrome {chromeVersion}</span>
      </header>

      <section className="panel-section" aria-labelledby="capture-section-title">
        <div className="record-controls">
          <button
            type="button"
            className="record-button"
            onClick={handleToggleRecording}
            disabled={micStatus === 'pending' || (!sttSupported && !isRecording)}
          >
            {isRecording ? 'Stop recording' : 'Start recording'}
            <span
              className={`status-chip ${isRecording ? 'status-chip--active' : ''}`}
              aria-live="polite"
            >
              {isRecording ? 'Listening…' : 'Idle'}
            </span>
          </button>
          <span
            className={`status-chip ${permissionMeta.active ? 'status-chip--active' : ''}`}
            aria-live="polite"
          >
            {permissionMeta.text}
          </span>
          {micStatus !== 'granted' && (
            <button type="button" className="button" onClick={requestPermission}>
              Grant microphone access
            </button>
          )}
        </div>
        {micError && <p className="danger">{micError}</p>}
        {sttError && <p className="danger">{sttError}</p>}
        {!sttSupported && (
          <p className="danger">
            Live speech-to-text is not available in this browser. Try Chrome on desktop (138+).
          </p>
        )}
      </section>

      <section className="panel-section" aria-labelledby="transcript-title">
        <h2 id="transcript-title" className="section-title">
          Transcript
        </h2>
        <textarea
          className="transcript-area"
          value={displayTranscript}
          placeholder="Start speaking to see your transcript…"
          onChange={(event) => {
            setTranscript(event.target.value);
            clearInterim();
          }}
        />
        <div className="actions-toolbar" role="toolbar" aria-label="AI Actions">
          <button
            type="button"
            className="button button--primary"
            disabled={!activeTranscript}
            onClick={handleSummarize}
          >
            Summarize
          </button>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <select
              className="select"
              value={rewritePreset}
              onChange={(event) => setRewritePreset(event.target.value as RewritePreset)}
            >
              {rewritePresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
            <button type="button" className="button" disabled={!activeTranscript} onClick={handleRewrite}>
              Polish
            </button>
          </div>
          <button type="button" className="button" disabled={!activeTranscript} onClick={handleCopy}>
            Copy
          </button>
        </div>
        {streamingSummary && (
          <div className="panel-section" style={{ gap: '8px', background: 'var(--surface-variant)' }}>
            <strong>Summary Preview</strong>
            <p>{streamingSummary}</p>
          </div>
        )}
      </section>

      <section className="panel-section" aria-labelledby="settings-title">
        <h2 id="settings-title" className="section-title">
          Session Settings
        </h2>
        <div className="toggle-row">
          <label htmlFor="language-select">Recognition language</label>
          <select
            id="language-select"
            className="select"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
          >
            {languageOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="toggle-row">
          <label htmlFor="direct-insert-toggle">Direct Insert Mode</label>
          <input
            id="direct-insert-toggle"
            type="checkbox"
            checked={directInsertEnabled}
            onChange={(event) => handleDirectInsertToggle(event.target.checked)}
          />
        </div>
        <div className="toggle-row">
          <label htmlFor="autosave-toggle">Auto-save sessions locally</label>
          <input id="autosave-toggle" type="checkbox" defaultChecked />
        </div>
      </section>

      <section className="panel-section" aria-labelledby="history-title">
        <h2 id="history-title" className="section-title">
          History
        </h2>
        {history.length === 0 ? (
          <div className="empty-state">
            Your sessions will appear here once you summarize or rewrite a transcript.
          </div>
        ) : (
          <div className="history-list">
            {history.map((entry) => (
              <div key={entry.id} className="history-item">
                <div className="history-item__meta">
                  <p className="history-item__title">{entry.title}</p>
                  <p className="history-item__subtitle">
                    {entry.createdAt} • {entry.actions.join(', ')}
                  </p>
                </div>
                <button type="button" className="button">
                  Open
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
