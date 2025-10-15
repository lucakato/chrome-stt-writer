import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EkkoMessage } from '@shared/messages';
import { useMicrophonePermission } from '@shared/hooks/useMicrophonePermission';

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
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [rewritePreset, setRewritePreset] = useState<RewritePreset>('concise-formal');
  const [directInsertEnabled, setDirectInsertEnabled] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [streamingSummary, setStreamingSummary] = useState<string | null>(null);
  const [pendingSync, setPendingSync] = useState<number | null>(null);

  const permissionMeta = useMemo(() => formatPermission(micStatus), [micStatus]);
  const isMicGranted = micStatus === 'granted';

  const handleToggleRecording = useCallback(async () => {
    if (!isMicGranted) {
      const granted = await requestPermission();
      if (!granted) {
        return;
      }
    }

    setIsRecording((prev) => !prev);
  }, [isMicGranted, requestPermission]);

  const handleSummarize = useCallback(() => {
    if (!transcript.trim()) {
      return;
    }
    // Placeholder for Summarizer API integration.
    setStreamingSummary('Summaries will appear here once the Summarizer API is wired in.');
    setHistory((entries) => [
      {
        id: crypto.randomUUID(),
        title: transcript.slice(0, 60) || 'Untitled transcript',
        createdAt: new Date().toLocaleTimeString(),
        actions: ['Summarized']
      },
      ...entries
    ]);
  }, [transcript]);

  const handleRewrite = useCallback(() => {
    if (!transcript.trim()) {
      return;
    }
    setHistory((entries) => [
      {
        id: crypto.randomUUID(),
        title: transcript.slice(0, 60) || 'Untitled transcript',
        createdAt: new Date().toLocaleTimeString(),
        actions: [`Rewritten (${rewritePreset})`]
      },
      ...entries
    ]);
  }, [transcript, rewritePreset]);

  const handleCopy = useCallback(async () => {
    if (!transcript.trim()) return;
    try {
      await navigator.clipboard.writeText(transcript);
    } catch (copyError) {
      console.warn('Unable to copy transcript', copyError);
    }
  }, [transcript]);

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
    if (pendingSync) {
      window.clearTimeout(pendingSync);
    }

    const timeout = window.setTimeout(() => {
      chrome.runtime
        ?.sendMessage({
          type: 'ekko/transcript/update',
          payload: {
            transcript,
            origin: 'panel'
          }
        } satisfies EkkoMessage)
        .catch((error: unknown) => {
          console.warn('Unable to sync transcript to background', error);
        });
    }, 150);

    setPendingSync(timeout);

    return () => window.clearTimeout(timeout);
  }, [transcript]);

  return (
    <div className="app" role="application">
      <header className="app__header">
        <div className="brand">
          <span className="brand__title">Ekko: Write with Voice</span>
          <span className="brand__subtitle">Live capture • On-device AI polish</span>
        </div>
        <span className="pill">Chrome {navigator.userAgentData?.brands?.[0]?.version ?? '138+'}</span>
      </header>

      <section className="panel-section" aria-labelledby="capture-section-title">
        <div className="record-controls">
          <button
            type="button"
            className="record-button"
            onClick={handleToggleRecording}
            disabled={micStatus === 'pending'}
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
      </section>

      <section className="panel-section" aria-labelledby="transcript-title">
        <h2 id="transcript-title" className="section-title">
          Transcript
        </h2>
        <textarea
          className="transcript-area"
          value={transcript}
          placeholder="Start speaking to see your transcript…"
          onChange={(event) => setTranscript(event.target.value)}
        />
        <div className="actions-toolbar" role="toolbar" aria-label="AI Actions">
          <button
            type="button"
            className="button button--primary"
            disabled={!transcript.trim()}
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
            <button
              type="button"
              className="button"
              disabled={!transcript.trim()}
              onClick={handleRewrite}
            >
              Polish
            </button>
          </div>
          <button type="button" className="button" disabled={!transcript.trim()} onClick={handleCopy}>
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
