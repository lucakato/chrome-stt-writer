import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMicrophonePermission } from '@shared/hooks/useMicrophonePermission';
import { useSpeechRecorder } from '@shared/hooks/useSpeechRecorder';
import type { EkkoMessage, EkkoResponse } from '@shared/messages';
import { readOnboardingState, updateOnboardingState } from '@shared/storage/onboarding';
import {
  getSummarizerAvailability,
  summarizeText,
  type SummarizerAvailabilityStatus
} from '@shared/ai/summarizer';
import {
  getRewriterAvailability,
  rewriteText,
  type RewriterAvailabilityStatus
} from '@shared/ai/rewriter';

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
  summary?: string;
  rewrite?: string;
};

const rewritePresets: Array<{ id: RewritePreset; label: string }> = [
  { id: 'concise-formal', label: 'Concise • Formal' },
  { id: 'expand', label: 'Expand' },
  { id: 'casual', label: 'Casual' },
  { id: 'bullet', label: 'Bullet list' },
  { id: 'action-items', label: 'Action items' },
  { id: 'custom', label: 'Custom instructions' }
];

type RewritePresetConfig = {
  sharedContext?: string;
  context?: string;
  tone?: string;
  format?: string;
  length?: string;
};

const BASE_SHARED_CONTEXT = 'Voice note rewrite to help organize research and meeting insights.';

const rewritePresetConfig: Record<RewritePreset, RewritePresetConfig> = {
  'concise-formal': {
    sharedContext: BASE_SHARED_CONTEXT,
    context: 'Rewrite the text to be concise, professional, and suitable for business communication.',
    tone: 'more-formal',
    length: 'shorter',
    format: 'plain-text'
  },
  expand: {
    sharedContext: BASE_SHARED_CONTEXT,
    context: 'Expand the text with helpful details while keeping the original intent clear.',
    length: 'longer',
    format: 'plain-text'
  },
  casual: {
    sharedContext: BASE_SHARED_CONTEXT,
    context: 'Rewrite the text with a relaxed, friendly tone while keeping all key information.',
    tone: 'more-casual',
    format: 'plain-text'
  },
  bullet: {
    sharedContext: BASE_SHARED_CONTEXT,
    context: 'Rewrite the text as a concise bullet list highlighting the key points.',
    format: 'bullet'
  },
  'action-items': {
    sharedContext: BASE_SHARED_CONTEXT,
    context: 'Rewrite the text as a list of clear action items with imperative verbs and owners where possible.',
    format: 'plain-text',
    tone: 'more-direct'
  },
  custom: {
    sharedContext: BASE_SHARED_CONTEXT,
    context: 'Rewrite the text to improve clarity, flow, and readability while preserving the author’s intent.',
    format: 'plain-text'
  }
};

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
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [summarizerState, setSummarizerState] = useState<'idle' | 'checking' | SummarizerAvailabilityStatus | 'summarizing'>('idle');
  const [summarizerError, setSummarizerError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [summarizerMessage, setSummarizerMessage] = useState<string | null>(null);
  const [rewriterState, setRewriterState] = useState<'idle' | 'checking' | RewriterAvailabilityStatus | 'rewriting'>('idle');
  const [rewriterError, setRewriterError] = useState<string | null>(null);
  const [rewriterMessage, setRewriterMessage] = useState<string | null>(null);
  const [rewritePreview, setRewritePreview] = useState<string | null>(null);

  const pendingSyncRef = useRef<number | null>(null);
  const lastSyncedRef = useRef<string>('');
  const activeSessionIdRef = useRef<string | null>(null);

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

  const outputLanguage = useMemo(() => {
    const allowed = ['en', 'es', 'ja'];
    const locale = normalizedLanguage.toLowerCase();
    const primary = locale.split('-')[0];
    return allowed.includes(primary) ? primary : 'en';
  }, [normalizedLanguage]);

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

  const isSummarizing = summarizerState === 'summarizing';
  const isSummarizerBusy = summarizerState === 'checking' || summarizerState === 'summarizing';
  const summarizerUnavailable = summarizerState === 'unsupported' || summarizerState === 'unavailable';
  const isRewriting = rewriterState === 'rewriting';
  const isRewriterBusy = rewriterState === 'checking' || rewriterState === 'rewriting';
  const rewriterUnavailable = rewriterState === 'unsupported' || rewriterState === 'unavailable';
  const rewritePresetLabel = useMemo(
    () => rewritePresets.find((preset) => preset.id === rewritePreset)?.label ?? 'Rewrite',
    [rewritePreset]
  );

  const handleSummarize = useCallback(async () => {
    if (!activeTranscript) {
      return;
    }

    if (!isRecording || !interimTranscript.trim()) {
      setTranscript(activeTranscript);
    }
    setSummarizerError(null);
    setSummarizerState('summarizing');
    setSummarizerMessage('Generating summary…');
    setDownloadProgress(null);
    setStreamingSummary(null);

    try {
      const result = await summarizeText({
        text: activeTranscript,
        context: 'Voice transcript captured via Ekko side panel.',
        outputLanguage,
        onStatusChange: (status) => {
          if (status === 'downloadable') {
            setSummarizerError(null);
            setSummarizerMessage('Downloading on-device model…');
          }
          if (status === 'ready') {
            setSummarizerState('summarizing');
            setSummarizerError(null);
            setSummarizerMessage('Model ready. Summarizing…');
          }
        },
        onDownloadProgress: (progress) => {
          setSummarizerError(null);
          setSummarizerMessage(`Downloading on-device model… ${Math.round(progress * 100)}%`);
          setDownloadProgress(progress);
        },
        onChunk: (chunk) => {
          setStreamingSummary(chunk);
        }
      });

      setSummarizerState('ready');
      setSummarizerMessage(null);
      setSummarizerError(null);
      setDownloadProgress(null);
      setStreamingSummary(result.summary);

      const entryId = activeSessionIdRef.current ?? crypto.randomUUID();
      activeSessionIdRef.current = entryId;
      setHistory((entries) => {
        const existing = entries.find((entry) => entry.id === entryId);
        const actions = Array.from(new Set(['Summarized', ...(existing?.actions ?? [])]));
        const updatedEntry: HistoryEntry = {
          id: entryId,
          title: activeTranscript.slice(0, 60) || 'Untitled transcript',
          createdAt: existing?.createdAt ?? new Date().toLocaleTimeString(),
          actions,
          summary: result.summary,
          rewrite: existing?.rewrite
        };

        return [updatedEntry, ...entries.filter((entry) => entry.id !== entryId)];
      });

      chrome.runtime
        ?.sendMessage({
          type: 'ekko/ai/summarize',
          payload: {
            sessionId: activeSessionIdRef.current ?? undefined,
            transcript: activeTranscript,
            summary: result.summary
          }
        } satisfies EkkoMessage)
        .then((response: EkkoResponse | undefined) => {
          if (response?.ok && response.data && typeof response.data === 'object') {
            const { id } = response.data as { id?: string };
            if (typeof id === 'string') {
          const persistedId = id;
          setHistory((entries) => {
            const index = entries.findIndex((entry) => entry.id === entryId);
            if (index === -1) {
              return entries;
            }

            const existingEntry = entries[index];
            const updatedEntry: HistoryEntry = {
              ...existingEntry,
              id: persistedId
            };

            const next = [...entries];
            next.splice(index, 1);
            return [updatedEntry, ...next];
          });

          activeSessionIdRef.current = persistedId;
            }
          }
        })
        .catch((error: unknown) => {
          console.warn('Unable to persist summary to background', error);
        });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Summarization failed.';
      let message = rawMessage;
      if (/enough space/i.test(rawMessage)) {
        message = 'Chrome needs about 22 GB of free space on the profile drive to download the Gemini Nano model. Clear space and try again.';
      }
      setSummarizerState('error');
      setSummarizerError(message);
      setSummarizerMessage(null);
      setDownloadProgress(null);
    }
  }, [activeTranscript, outputLanguage, isRecording, interimTranscript]);

  const handleRewrite = useCallback(async () => {
    if (!activeTranscript) {
      return;
    }

    const presetConfig = rewritePresetConfig[rewritePreset] ?? rewritePresetConfig.custom;
    if (!isRecording || !interimTranscript.trim()) {
      setTranscript(activeTranscript);
    }
    setRewriterError(null);
    setRewriterMessage('Generating rewrite…');
    setRewriterState('rewriting');
    setRewritePreview(null);

    try {
      const result = await rewriteText({
        text: activeTranscript,
        sharedContext: presetConfig.sharedContext ?? BASE_SHARED_CONTEXT,
        context: presetConfig.context,
        tone: presetConfig.tone,
        format: presetConfig.format,
        length: presetConfig.length,
        outputLanguage,
        onStatusChange: (status) => {
          if (status === 'downloadable') {
            setRewriterError(null);
            setRewriterMessage('Downloading on-device model…');
          }
          if (status === 'ready') {
            setRewriterState('rewriting');
            setRewriterError(null);
            setRewriterMessage('Model ready. Rewriting…');
          }
        },
        onDownloadProgress: (progress) => {
          setRewriterError(null);
          setRewriterMessage(`Downloading on-device model… ${Math.round(progress * 100)}%`);
        },
        onChunk: (chunk) => {
          setRewritePreview(chunk);
        }
      });

      setRewriterState('ready');
      setRewriterMessage(null);
      setRewriterError(null);
      setRewritePreview(result.content);

      const entryId = activeSessionIdRef.current ?? crypto.randomUUID();
      activeSessionIdRef.current = entryId;
      const rewriteActionLabel = `Rewritten (${rewritePresetLabel})`;
      setHistory((entries) => {
        const existing = entries.find((entry) => entry.id === entryId);
        const actions = Array.from(new Set([rewriteActionLabel, ...(existing?.actions ?? [])]));
        const updatedEntry: HistoryEntry = {
          id: entryId,
          title: activeTranscript.slice(0, 60) || 'Untitled transcript',
          createdAt: existing?.createdAt ?? new Date().toLocaleTimeString(),
          actions,
          summary: existing?.summary,
          rewrite: result.content
        };

        return [updatedEntry, ...entries.filter((entry) => entry.id !== entryId)];
      });

      chrome.runtime
        ?.sendMessage({
          type: 'ekko/ai/rewrite',
          payload: {
            sessionId: activeSessionIdRef.current ?? undefined,
            preset: rewritePreset,
            transcript: activeTranscript,
            rewrite: result.content
          }
        } satisfies EkkoMessage)
        .then((response: EkkoResponse | undefined) => {
          if (response?.ok && response.data && typeof response.data === 'object') {
            const { id } = response.data as { id?: string };
            if (typeof id === 'string') {
              const persistedId = id;
              setHistory((entries) => {
                const index = entries.findIndex((entry) => entry.id === entryId);
                if (index === -1) {
                  return entries;
                }

                const existingEntry = entries[index];
                const updatedEntry: HistoryEntry = {
                  ...existingEntry,
                  id: persistedId
                };

                const next = [...entries];
                next.splice(index, 1);
                return [updatedEntry, ...next];
              });

              activeSessionIdRef.current = persistedId;
            }
          }
        })
        .catch((error: unknown) => {
          console.warn('Unable to persist rewrite to background', error);
        });
    } catch (error) {
      let message = error instanceof Error ? error.message : 'Rewrite failed.';
      if (/enough space/i.test(message)) {
        message =
          'Chrome still reports insufficient disk space for Gemini Nano (~22 GB free required). Check chrome://on-device-internals and retry.';
      }
      setRewriterState('error');
      setRewriterError(message);
      setRewriterMessage(null);
      setRewritePreview(null);
    }
  }, [activeTranscript, outputLanguage, rewritePreset, rewritePresetLabel, isRecording, interimTranscript]);

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

  const openMicrophoneSettings = useCallback(() => {
    chrome.tabs
      .create({ url: 'chrome://settings/content/microphone' })
      .catch((error: unknown) => {
        console.warn('Unable to open microphone settings', error);
      });
  }, []);

  useEffect(() => {
    void (async () => {
      const onboarding = await readOnboardingState();
      setOnboardingDismissed(onboarding.microphoneAccepted);
    })();
  }, []);

  useEffect(() => {
    if (micStatus === 'granted') {
      setOnboardingDismissed(true);
      void updateOnboardingState({ microphoneAccepted: true });
    }
  }, [micStatus]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setSummarizerState('checking');
      const availability = await getSummarizerAvailability();
      if (cancelled) {
        return;
      }

      if (availability.status === 'error') {
        const message = availability.message ?? 'Summarizer API error.';
        setSummarizerState('error');
        setSummarizerError(message);
        setSummarizerMessage(null);
        return;
      }

      if (availability.status === 'unsupported') {
        const message = availability.message ?? 'Summarizer API is not supported on this device.';
        setSummarizerState('unsupported');
        setSummarizerError(message);
        setSummarizerMessage(null);
        return;
      }

      if (availability.status === 'unavailable') {
        const message = availability.message ?? 'Summarizer is currently unavailable.';
        setSummarizerState('unavailable');
        setSummarizerError(message);
        setSummarizerMessage(null);
        return;
      }

      if (availability.status === 'downloadable') {
        setSummarizerState('idle');
        setSummarizerError(null);
        setSummarizerMessage('First summary may take a moment while the on-device model downloads.');
        return;
      }

      setSummarizerState('ready');
      setSummarizerError(null);
      setSummarizerMessage(null);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setRewriterState('checking');
      const availability = await getRewriterAvailability();
      if (cancelled) {
        return;
      }

      if (availability.status === 'error') {
        const message = availability.message ?? 'Rewriter API error.';
        setRewriterState('error');
        setRewriterError(message);
        setRewriterMessage(null);
        return;
      }

      if (availability.status === 'unsupported') {
        const message = availability.message ?? 'Rewriter API is not supported on this device.';
        setRewriterState('unsupported');
        setRewriterError(message);
        setRewriterMessage(null);
        return;
      }

      if (availability.status === 'unavailable') {
        const message = availability.message ?? 'Rewriter is currently unavailable.';
        setRewriterState('unavailable');
        setRewriterError(message);
        setRewriterMessage(null);
        return;
      }

      if (availability.status === 'downloadable') {
        setRewriterState('idle');
        setRewriterError(null);
        setRewriterMessage('First rewrite may take a moment while the on-device model downloads.');
        return;
      }

      setRewriterState('ready');
      setRewriterError(null);
      setRewriterMessage(null);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (pendingSyncRef.current) {
      window.clearTimeout(pendingSyncRef.current);
    }

    const payloadTranscript = displayTranscript;

    pendingSyncRef.current = window.setTimeout(() => {
      if (payloadTranscript === lastSyncedRef.current) {
        return;
      }

      if (!payloadTranscript.trim()) {
        activeSessionIdRef.current = null;
      }

      chrome.runtime
        ?.sendMessage({
          type: 'ekko/transcript/update',
          payload: {
            transcript: payloadTranscript,
            origin: 'panel'
          }
        } satisfies EkkoMessage)
        .then((response: EkkoResponse | undefined) => {
          if (response?.ok && response.data && typeof response.data === 'object') {
            const { id } = response.data as { id?: string };
            if (typeof id === 'string') {
              activeSessionIdRef.current = id;
            }
          }
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
          <div className="record-controls__main">
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
          </div>
          {micStatus !== 'granted' && (
            <button
              type="button"
              className="button button--outline record-controls__cta"
              onClick={() => {
                resetSttError();
                void requestPermission();
              }}
            >
              Allow microphone access
            </button>
          )}
        </div>
        <div className="record-controls__messages" aria-live="polite">
          {micError && <p className="helper-text danger">{micError}</p>}
          {!micError && micStatus === 'denied' && (
            <p className="helper-text danger">
              Microphone access is blocked. Click the lock icon next to the address bar, set Microphone to
              "Allow", then try again.
            </p>
          )}
          {!micError && micStatus === 'prompt' && (
            <p className="helper-text">When Chrome prompts for access, choose Allow to start recording.</p>
          )}
          {micStatus === 'denied' && (
            <button type="button" className="text-button" onClick={openMicrophoneSettings}>
              Open Chrome microphone settings
            </button>
          )}
          {sttError && <p className="helper-text danger">{sttError}</p>}
          {!sttSupported && (
            <p className="helper-text danger">
              Live speech-to-text is not available in this browser. Try Chrome on desktop (138+) for Gemini Nano.
            </p>
          )}
        </div>
        {!onboardingDismissed && micStatus !== 'granted' && (
          <div className="onboarding-card" role="note">
            <h3 className="onboarding-card__title">First-time setup</h3>
            <ol className="onboarding-card__list">
              <li>Click the lock icon next to the address bar.</li>
              <li>Set <strong>Microphone</strong> to <strong>Allow</strong>.</li>
              <li>Return here and start recording.</li>
            </ol>
            <button
              type="button"
              className="button button--outline"
              onClick={openMicrophoneSettings}
            >
              Open settings in a new tab
            </button>
          </div>
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
            disabled={!activeTranscript || isSummarizerBusy || summarizerUnavailable}
            onClick={handleSummarize}
          >
            {isSummarizerBusy ? 'Summarizing…' : 'Summarize'}
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
              disabled={!activeTranscript || isRewriterBusy || rewriterUnavailable}
              onClick={handleRewrite}
            >
              {isRewriterBusy ? 'Polishing…' : 'Polish'}
            </button>
          </div>
          <button type="button" className="button" disabled={!activeTranscript} onClick={handleCopy}>
            Copy
          </button>
        </div>
        <div className="summary-status" aria-live="polite">
          {summarizerMessage && <p className="helper-text">{summarizerMessage}</p>}
          {summarizerError && <p className="helper-text danger">{summarizerError}</p>}
        </div>
        {streamingSummary && (
          <div className="summary-preview">
            <strong className="summary-preview__title">Summary Preview</strong>
            <p className="summary-preview__body">{streamingSummary}</p>
          </div>
        )}
        <div className="rewrite-status" aria-live="polite">
          {rewriterMessage && <p className="helper-text">{rewriterMessage}</p>}
          {rewriterError && <p className="helper-text danger">{rewriterError}</p>}
        </div>
        {rewritePreview && (
          <div className="summary-preview rewrite-preview">
            <strong className="summary-preview__title">Rewrite Preview • {rewritePresetLabel}</strong>
            <p className="summary-preview__body">{rewritePreview}</p>
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
                  {entry.summary && (
                    <p className="history-item__summary">
                      <strong className="history-item__summary-label">Summary:</strong> {entry.summary}
                    </p>
                  )}
                  {entry.rewrite && (
                    <p className="history-item__summary">
                      <strong className="history-item__summary-label">Rewrite:</strong> {entry.rewrite}
                    </p>
                  )}
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
