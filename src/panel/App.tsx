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
import {
  composeFromAudio,
  createPromptSession,
  getPromptAvailability,
  type PromptAvailabilityStatus
} from '@shared/ai/prompt';
import {
  ComposeDraftResult,
  coerceComposeDraft,
  composeDraftToClipboardText,
  deriveParagraphs,
  joinParagraphs
} from '@shared/compose';
import {
  DEFAULT_SETTINGS,
  getEkkoSettings,
  observeEkkoSettings,
  setEkkoSettings,
  type EkkoMode,
  type EkkoSettings
} from '@shared/settings';
import { MdKeyboardVoice } from 'react-icons/md';
import { LuAudioLines } from 'react-icons/lu';
import { IoMicOffSharp } from 'react-icons/io5';

type Mode = 'transcribe' | 'compose';

type RewritePreset =
  | 'concise-formal'
  | 'expand'
  | 'casual'
  | 'bullet'
  | 'action-items'
  | 'custom';

type MicVisualState = 'idle' | 'recording' | 'off';

function MicIcon({ state }: { state: MicVisualState }) {
  const Icon =
    state === 'recording' ? LuAudioLines : state === 'off' ? IoMicOffSharp : MdKeyboardVoice;
  return <Icon size={20} aria-hidden="true" focusable="false" />;
}

type ComposePresetId = 'freeform' | 'email-formal' | 'summary' | 'action-plan';

type HistoryEntry = {
  id: string;
  title: string;
  createdAt: string;
  actions: string[];
  summary?: string;
  rewrite?: string;
  compose?: {
    presetId: ComposePresetId;
   presetLabel: string;
    instructions?: string;
    output: string;
    subject?: string;
    raw?: string;
    paragraphs?: string[];
  };
};

type RewritePresetConfig = {
  sharedContext?: string;
  context?: string;
  tone?: string;
  format?: string;
  length?: string;
};

const BASE_SHARED_CONTEXT = 'Voice note rewrite to help organize research and meeting insights.';
const COMPOSE_MAX_DURATION_MS = 90_000;

const rewritePresets: Array<{ id: RewritePreset; label: string }> = [
  { id: 'concise-formal', label: 'Concise • Formal' },
  { id: 'expand', label: 'Expand' },
  { id: 'casual', label: 'Casual' },
  { id: 'bullet', label: 'Bullet list' },
  { id: 'action-items', label: 'Action items' },
  { id: 'custom', label: 'Custom instructions' }
];

const composePresets: Array<{ id: ComposePresetId; label: string; systemPrompt: string; helper: string }> = [
  {
    id: 'freeform',
    label: 'Freeform',
    helper: 'Great for open-ended questions or ideation.',
    systemPrompt:
      'You are Ekko, an on-device writing assistant. Listen carefully and return a direct, helpful answer the user can use immediately. Reply in the user’s language, keep it concise, and avoid meta commentary or extra instructions.'
  },
  {
    id: 'email-formal',
    label: 'Formal email',
    helper: 'Draft polished outreach or apology emails.',
    systemPrompt:
      'You help users draft formal, polite emails. Produce the finished email text (include a subject line and sign-off when appropriate). Provide only the email—do not add guidance or commentary.'
  },
  {
    id: 'summary',
    label: 'Summary',
    helper: 'Turn thoughts into concise summaries.',
    systemPrompt:
      'You summarize the user’s spoken input into a concise digest. Present only the distilled summary in clear prose or bullet points, without extra advice or explanation.'
  },
  {
    id: 'action-plan',
    label: 'Action plan',
    helper: 'Outline next steps with clarity.',
    systemPrompt:
      'You produce a clear action plan based on the user’s spoken intent. Return only the actionable steps (numbered or bullet list), keeping each step direct and free of meta commentary.'
  }
];

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

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0:00';
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export default function App() {
  const { status: micStatus, requestPermission, error: micError } = useMicrophonePermission();
  const [settings, setSettings] = useState<EkkoSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);

  const [transcript, setTranscript] = useState('');
  const [rewritePreset, setRewritePreset] = useState<RewritePreset>('concise-formal');
  const [directInsertEnabled, setDirectInsertEnabled] = useState(true);
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

  const [promptAvailabilityState, setPromptAvailabilityState] = useState<'idle' | 'checking' | PromptAvailabilityStatus>('idle');
  const [promptAvailabilityMessage, setPromptAvailabilityMessage] = useState<string | null>(null);
  const [composePreset, setComposePreset] = useState<ComposePresetId>('freeform');
  const [composeState, setComposeState] = useState<'idle' | 'recording' | 'processing' | 'streaming'>('idle');
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeDraft, setComposeDraft] = useState<ComposeDraftResult | null>(null);
  const [composeRawPreview, setComposeRawPreview] = useState('');
  const [composeElapsedMs, setComposeElapsedMs] = useState(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const lastDirectInsertValueRef = useRef<string>('');
  const composeRecorderRef = useRef<MediaRecorder | null>(null);
  const composeChunksRef = useRef<Blob[]>([]);
  const composeTimerRef = useRef<number | null>(null);
  const composeStartTimeRef = useRef<number | null>(null);
  const composeAbortRef = useRef<AbortController | null>(null);
  const composeStreamRef = useRef<MediaStream | null>(null);
  const composeEntryIdRef = useRef<string | null>(null);
const composeSessionRef = useRef<LanguageModelSession | null>(null);
const composeSessionPromiseRef = useRef<Promise<LanguageModelSession> | null>(null);

  useEffect(() => {
    const sendState = (open: boolean, tabId?: number, windowId?: number) => {
      chrome.runtime
        ?.sendMessage({
          type: 'ekko/sidepanel/state',
          payload: { open, tabId, windowId }
        } satisfies EkkoMessage)
        .catch(() => {});
    };

    const getActiveContext = async (): Promise<{ tabId?: number; windowId?: number }> => {
      if (!chrome.tabs?.query) return {};
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return { tabId: tab?.id ?? undefined, windowId: tab?.windowId ?? undefined };
      } catch {
        return {};
      }
    };

    const broadcast = async (open: boolean) => {
      const { tabId, windowId } = await getActiveContext();
      sendState(open, tabId, windowId);
    };

    const handleVisibility = () => {
      void broadcast(document.visibilityState !== 'hidden');
    };

    handleVisibility();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      void broadcast(false);
    };
  }, []);

  useEffect(() => {
    let active = true;

    getEkkoSettings()
      .then((value) => {
        if (!active) return;
        setSettings(value);
        setSettingsReady(true);
      })
      .catch((error) => {
        console.warn('Unable to load Ekko settings', error);
      });

    const dispose = observeEkkoSettings((value, changed) => {
      setSettings((prev) => ({
        floatingWidgetEnabled: changed.floatingWidgetEnabled ? value.floatingWidgetEnabled : prev.floatingWidgetEnabled,
        mode: changed.mode ? value.mode : prev.mode,
        composePrompt: changed.composePrompt ? value.composePrompt : prev.composePrompt
      }));
      setSettingsReady(true);
    });

    return () => {
      active = false;
      dispose();
    };
  }, []);

  const applySettings = useCallback((partial: Partial<EkkoSettings>) => {
    setSettings((prev) => {
      const optimistic = { ...prev, ...partial };
      setEkkoSettings(partial).catch((error) => {
        console.warn('Unable to update Ekko settings', error);
        setSettings(prev);
      });
      return optimistic;
    });
  }, []);

  const mode = settings.mode;
  const composePrompt = settings.composePrompt;
  const floatingWidgetEnabled = settings.floatingWidgetEnabled;
  const composePromptDebounceRef = useRef<number | null>(null);

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

  const activeComposePreset = useMemo(
    () => composePresets.find((preset) => preset.id === composePreset) ?? composePresets[0],
    [composePreset]
  );

  const isPromptUnavailable =
    promptAvailabilityState === 'unsupported' ||
    promptAvailabilityState === 'unavailable' ||
    promptAvailabilityState === 'error';

  const composeSubject = composeDraft?.subject?.trim() ?? '';
  const composeParagraphs =
    composeDraft?.paragraphs && composeDraft.paragraphs.length > 0
      ? composeDraft.paragraphs
      : composeDraft?.content
      ? deriveParagraphs(composeDraft.content)
      : [];
  const composeContent =
    composeParagraphs.length > 0
      ? joinParagraphs(composeParagraphs).trim()
      : composeDraft?.content?.trim() ?? '';
  const composeHasOutput = composeContent.length > 0;
  const composeDisplayText = composeHasOutput ? composeContent : composeRawPreview.trim();
  const isComposeRecording = composeState === 'recording';
  const isComposeBusy = composeState === 'processing' || composeState === 'streaming';
  const transcribeMicReady = micStatus === 'granted' && (sttSupported || isRecording);
  const transcribeMicState: MicVisualState = isRecording ? 'recording' : transcribeMicReady ? 'idle' : 'off';
  const transcribeStatusText = isRecording
    ? 'Listening…'
    : transcribeMicReady
    ? 'Ready'
    : 'Microphone unavailable';
  const composeMicAvailable = micStatus === 'granted';
  const composeMicState: MicVisualState = isComposeRecording ? 'recording' : composeMicAvailable ? 'idle' : 'off';
  const composeStatusText =
    isComposeRecording
      ? 'Recording…'
      : composeState === 'streaming'
      ? 'Generating…'
      : composeMicAvailable
      ? 'Ready'
      : 'Microphone unavailable';

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
          rewrite: existing?.rewrite,
          compose: existing?.compose
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
          rewrite: result.content,
          compose: existing?.compose
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
      if (!enabled) {
        lastDirectInsertValueRef.current = '';
      }
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

  const ensurePromptSession = useCallback((): Promise<LanguageModelSession> => {
    if (composeSessionRef.current) {
      return Promise.resolve(composeSessionRef.current);
    }

    if (composeSessionPromiseRef.current) {
      return composeSessionPromiseRef.current;
    }

    const promise = createPromptSession({
      outputLanguage,
      onStatusChange: (status) => {
        setPromptAvailabilityState(status);
        if (status === 'downloadable') {
          setPromptAvailabilityMessage('Downloading the on-device model… keep this tab open while Chrome finishes.');
        } else if (status === 'ready') {
          setPromptAvailabilityMessage(null);
        }
      },
      monitor: (monitor) => {
        const handler = (event: Event) => {
          const loaded = Math.min(
            Math.max((event as { loaded?: number }).loaded ?? 0, 0),
            1
          );
          setPromptAvailabilityState('downloadable');
          setPromptAvailabilityMessage(
            `Downloading the on-device model… ${Math.round(loaded * 100)}%`
          );
        };
        monitor.addEventListener('downloadprogress', handler);
      }
    })
      .then((session) => {
        composeSessionRef.current = session;
        composeSessionPromiseRef.current = null;
        return session;
      })
      .catch((error) => {
        composeSessionPromiseRef.current = null;
        throw error;
      });

    composeSessionPromiseRef.current = promise;
    return promise;
  }, [outputLanguage]);

  const runCompose = useCallback(
    async (audioBuffer: ArrayBuffer) => {
      const preset = activeComposePreset;
      const instructions = composePrompt.trim();
      console.info('[Ekko] side panel instruction:', instructions);
      const systemPrompt = instructions
        ? `${preset.systemPrompt}\n\nFollow these additional instructions exactly:\n${instructions}`
        : preset.systemPrompt;

      setComposeError(null);
      setComposeState('streaming');
      setComposeDraft(null);
      setComposeRawPreview('');

      const abortController = new AbortController();
      composeAbortRef.current = abortController;

      try {
        let session: LanguageModelSession | null = composeSessionRef.current;
        if (!session) {
          const availability = await getPromptAvailability({
            expectedInputs: [{ type: 'audio', languages: [outputLanguage] }],
            expectedOutputs: [{ type: 'text', languages: [outputLanguage] }]
          });

          setPromptAvailabilityState(availability.status);
          setPromptAvailabilityMessage(availability.message ?? null);

          if (availability.status === 'unsupported' || availability.status === 'unavailable' || availability.status === 'error') {
            const message = availability.message ?? 'Prompt API is not ready yet on this device.';
            setComposeError(message);
            setComposeState('idle');
            return;
          }

          session = await ensurePromptSession();
        }

        const text = await composeFromAudio({
          audio: audioBuffer,
          systemPrompt,
          instruction: instructions || undefined,
          outputLanguage,
          onStatusChange: (status) => {
            setPromptAvailabilityState(status);
            if (status === 'downloadable') {
              setPromptAvailabilityMessage('Downloading the on-device model… keep this tab open while Chrome finishes.');
            } else if (status === 'ready') {
              setPromptAvailabilityMessage(null);
            }
          },
          onChunk: (chunk) => {
            setComposeRawPreview(chunk);
            const parsed = coerceComposeDraft(chunk);
            if (parsed) {
              const chunkParagraphs =
                parsed.paragraphs && parsed.paragraphs.length > 0
                  ? parsed.paragraphs
                  : deriveParagraphs(parsed.content);
              setComposeDraft({
                ...parsed,
                content: joinParagraphs(chunkParagraphs).trim(),
                paragraphs: chunkParagraphs
              });
            }
          },
          signal: abortController.signal,
          session
        });

        const normalizedParagraphs =
          text.paragraphs && text.paragraphs.length > 0 ? text.paragraphs : deriveParagraphs(text.content);
        const normalizedDraft: ComposeDraftResult = {
          raw: text.raw,
          content: joinParagraphs(normalizedParagraphs).trim(),
          subject: text.subject && text.subject.trim().length > 0 ? text.subject.trim() : undefined,
          paragraphs: normalizedParagraphs
        };

        setComposeDraft(normalizedDraft);
        setComposeRawPreview(normalizedDraft.raw);
        setComposeState('idle');
        setComposeElapsedMs(0);
        composeAbortRef.current = null;

        const entryId = crypto.randomUUID();
        composeEntryIdRef.current = entryId;
        const createdAt = new Date().toLocaleTimeString();
        const historyTitle =
          normalizedDraft.subject ??
          (normalizedDraft.content.slice(0, 60) || `${preset.label} draft`);

        setHistory((entries) => [
          {
            id: entryId,
            title: historyTitle,
            createdAt,
            actions: ['Composed'],
            compose: {
              presetId: preset.id,
              presetLabel: preset.label,
              instructions: instructions || undefined,
              output: normalizedDraft.content,
              subject: normalizedDraft.subject,
              raw: normalizedDraft.raw,
              paragraphs: normalizedDraft.paragraphs
            }
          },
          ...entries
        ]);

        chrome.runtime
          ?.sendMessage({
            type: 'ekko/ai/compose',
              payload: {
                sessionId: undefined,
                preset: preset.id,
                instructions: instructions || undefined,
                output: {
                  content: normalizedDraft.content,
                  subject: normalizedDraft.subject,
                  raw: normalizedDraft.raw,
                  paragraphs: normalizedDraft.paragraphs
                }
              }
          } satisfies EkkoMessage)
          .then((response: EkkoResponse | undefined) => {
            if (response?.ok && response.data && typeof response.data === 'object') {
              const { id } = response.data as { id?: string };
              if (typeof id === 'string') {
                const persistedId = id;
                setHistory((entries) => {
                  const index = entries.findIndex((entry) => entry.id === entryId);
                  if (index === -1) return entries;
                  const next = [...entries];
                  next[index] = { ...next[index], id: persistedId };
                  return next;
                });
                composeEntryIdRef.current = persistedId;
              }
            }
          })
          .catch((error: unknown) => {
            console.warn('Unable to persist compose draft', error);
          });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setComposeError('Compose request cancelled.');
        } else {
          const message =
            error instanceof Error ? error.message : 'Prompt API could not generate a response.';
          setComposeError(message);
          composeSessionRef.current?.destroy?.();
          composeSessionRef.current?.close?.();
          composeSessionRef.current = null;
        }
        setComposeDraft(null);
        setComposeRawPreview('');
        setComposeState('idle');
      } finally {
        composeAbortRef.current = null;
      }
    },
    [activeComposePreset, composePrompt, ensurePromptSession, outputLanguage]
  );

  const handleStopComposeRecording = useCallback(
    (auto = false) => {
      if (composeState !== 'recording') {
        return;
      }
      const recorder = composeRecorderRef.current;
      if (!recorder) {
        setComposeState('idle');
        return;
      }
      if (composeTimerRef.current) {
        window.clearInterval(composeTimerRef.current);
        composeTimerRef.current = null;
      }
      composeStartTimeRef.current = null;
      setComposeState('processing');
      if (auto) {
        setComposeError('Recording paused after 90 seconds to keep sessions responsive.');
      }
      try {
        recorder.stop();
      } catch (error) {
        console.warn('Unable to stop compose recorder', error);
        setComposeState('idle');
      }
    },
    [composeState]
  );

  const handleStartComposeRecording = useCallback(async () => {
    if (!isMicGranted) {
      const granted = await requestPermission();
      if (!granted) {
        return;
      }
    }

    if (composeState === 'recording') {
      handleStopComposeRecording();
      return;
    }

    if (isPromptUnavailable) {
      setComposeError('Prompt API is unavailable on this device.');
      return;
    }

    try {
      setComposeError(null);
      setComposeDraft(null);
      setComposeRawPreview('');
      setComposeElapsedMs(0);
      composeChunksRef.current = [];
      composeEntryIdRef.current = null;

      ensurePromptSession().catch((error) => {
        const message =
          error instanceof Error
            ? error.message
            : 'Prompt API could not initialize the on-device model yet.';
        setComposeError(message);
      });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      composeStreamRef.current = stream;
      const recorderOptions =
        typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? { mimeType: 'audio/webm;codecs=opus' }
          : undefined;
      const recorder = new MediaRecorder(stream, recorderOptions as MediaRecorderOptions | undefined);
      composeRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          composeChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        if (composeTimerRef.current) {
          window.clearInterval(composeTimerRef.current);
          composeTimerRef.current = null;
        }
        composeStartTimeRef.current = null;
        composeRecorderRef.current = null;
        composeStreamRef.current?.getTracks().forEach((track) => track.stop());
        composeStreamRef.current = null;

        const chunks = composeChunksRef.current;
        composeChunksRef.current = [];

        if (!chunks.length) {
          setComposeError('No audio captured. Try recording again.');
          setComposeState('idle');
          return;
        }

        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          const buffer = await blob.arrayBuffer();
          await runCompose(buffer);
        } catch (processingError) {
          const message =
            processingError instanceof Error
              ? processingError.message
              : 'Unable to process recorded audio.';
          setComposeError(message);
          setComposeState('idle');
        }
      };

      recorder.onerror = (event) => {
        console.warn('MediaRecorder error', event);
        setComposeError('Chrome could not capture audio. Try again.');
        setComposeState('idle');
      };

      recorder.start();
      composeStartTimeRef.current = Date.now();
      setComposeState('recording');

      composeTimerRef.current = window.setInterval(() => {
        if (!composeStartTimeRef.current) {
          return;
        }
        const elapsed = Date.now() - composeStartTimeRef.current;
        setComposeElapsedMs(elapsed);
        if (elapsed >= COMPOSE_MAX_DURATION_MS) {
          handleStopComposeRecording(true);
        }
      }, 100);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Chrome could not access the microphone.';
      setComposeError(message);
      setComposeState('idle');
    }
  }, [composeState, ensurePromptSession, handleStopComposeRecording, isMicGranted, isPromptUnavailable, requestPermission, runCompose]);

  const handleCancelCompose = useCallback(() => {
    composeAbortRef.current?.abort();
    composeAbortRef.current = null;
    setComposeDraft(null);
    setComposeRawPreview('');
    setComposeState('idle');
    setComposeError('Compose request cancelled.');
  }, []);

  const handleCopyCompose = useCallback(async () => {
    const draft = composeDraft;
    const fallback = composeRawPreview.trim();
    const textToCopy = draft ? composeDraftToClipboardText(draft) : fallback;
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
    } catch (error) {
      console.warn('Unable to copy compose output', error);
    }
  }, [composeDraft, composeRawPreview]);

  const handleInsertCompose = useCallback(() => {
    const draft = composeDraft;
    const fallbackContent = composeRawPreview.trim();
    const fallbackParagraphs = fallbackContent ? deriveParagraphs(fallbackContent) : [];
    const payload = draft
      ? {
          content: draft.content,
          subject: draft.subject,
          paragraphs: draft.paragraphs
        }
      : fallbackContent
      ? {
          content: joinParagraphs(fallbackParagraphs),
          paragraphs: fallbackParagraphs
        }
      : null;

    if (!payload) return;

    chrome.runtime
      ?.sendMessage({
        type: 'ekko/direct-insert/apply',
        payload: { draft: payload }
      } satisfies EkkoMessage)
      .catch((error: unknown) => {
        console.warn('Unable to insert compose draft into active field', error);
      });
  }, [composeDraft, composeRawPreview]);

  useEffect(() => {
    void (async () => {
      const onboarding = await readOnboardingState();
      setOnboardingDismissed(onboarding.microphoneAccepted);
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;

    setDirectInsertEnabled(false);

    chrome.runtime
      ?.sendMessage({ type: 'ekko/direct-insert/query' } satisfies EkkoMessage)
      .then((response: EkkoResponse | undefined) => {
        if (cancelled || !response || !response.ok || !response.data) {
          return;
        }
        const enabled = !!(response.data as { enabled?: boolean }).enabled;
        setDirectInsertEnabled(enabled);
      })
      .catch(() => {
        /* ignore: we will rely on initialized event */
      });

    const handleInitMessage = (message: EkkoMessage) => {
      if (message.type === 'ekko/direct-insert/initialized' && !cancelled) {
        const enabled = !!message.payload?.enabled;
        setDirectInsertEnabled(enabled);
      }
    };

    chrome.runtime?.onMessage.addListener(handleInitMessage);

    return () => {
      cancelled = true;
      chrome.runtime?.onMessage.removeListener(handleInitMessage);
    };
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
      const availability = await getSummarizerAvailability(outputLanguage);
      if (cancelled) {
        return;
      }

      setSummarizerState(availability.status);
      if (availability.message) {
        setSummarizerMessage(availability.message);
      } else {
        setSummarizerMessage(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [outputLanguage]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setRewriterState('checking');
      const availability = await getRewriterAvailability(outputLanguage);
      if (cancelled) return;
      setRewriterState(availability.status);
      if (availability.message) {
        setRewriterMessage(availability.message);
      } else {
        setRewriterMessage(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [outputLanguage]);

  useEffect(() => {
    if (mode !== 'compose') {
      return;
    }

    let cancelled = false;
    setPromptAvailabilityState('checking');
    setPromptAvailabilityMessage('Checking on-device Prompt API availability…');

    void (async () => {
      try {
        const availability = await getPromptAvailability({
          expectedInputs: [{ type: 'audio', languages: [outputLanguage] }],
          expectedOutputs: [{ type: 'text', languages: [outputLanguage] }]
        });
        if (cancelled) {
          return;
        }
        setPromptAvailabilityState(availability.status);
        setPromptAvailabilityMessage(availability.message ?? null);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setPromptAvailabilityState('error');
        setPromptAvailabilityMessage(
          error instanceof Error ? error.message : 'Prompt API availability check failed.'
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mode, outputLanguage]);

  useEffect(() => {
    if (mode === 'compose' && isRecording) {
      stopRecording();
    }
  }, [mode, isRecording, stopRecording]);

  useEffect(() => {
    if (!directInsertEnabled) {
      return;
    }

    const text = displayTranscript;
    if (text === lastDirectInsertValueRef.current) {
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;

    const attempt = () => {
      if (cancelled || !directInsertEnabled) {
        return;
      }

      chrome.runtime
        ?.sendMessage({
          type: 'ekko/transcript/update',
          payload: {
            transcript: text,
            origin: 'panel'
          }
        } satisfies EkkoMessage)
        .then((response: EkkoResponse | undefined) => {
          if (cancelled || !directInsertEnabled) {
            return;
          }

          const delivered = !!(
            response?.ok &&
            response.data &&
            typeof response.data === 'object' &&
            (response.data as { delivered?: boolean }).delivered
          );

          if (delivered) {
            lastDirectInsertValueRef.current = text;
          } else {
            retryTimer = window.setTimeout(attempt, 200);
          }
        })
        .catch((error: unknown) => {
          console.warn('Unable to mirror transcript to page', error);
          if (!cancelled && directInsertEnabled) {
            retryTimer = window.setTimeout(attempt, 200);
          }
        });
    };

    const initialTimer = window.setTimeout(attempt, 100);

    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [directInsertEnabled, displayTranscript]);

  useEffect(() => {
    return () => {
      if (composeTimerRef.current) {
        window.clearInterval(composeTimerRef.current);
      }
      composeRecorderRef.current?.state === 'recording' && composeRecorderRef.current.stop();
      composeStreamRef.current?.getTracks().forEach((track) => track.stop());
      composeAbortRef.current?.abort();
      composeSessionRef.current?.destroy?.();
      composeSessionRef.current?.close?.();
      composeSessionRef.current = null;
      composeSessionPromiseRef.current = null;
    };
  }, []);

  const handleTranscriptChange = useCallback(
    (value: string) => {
      setTranscript(value);
      clearInterim();
    },
    [clearInterim]
  );

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__headline">
          <div className="brand" aria-live="polite">
            <span className="brand__title">Ekko: Write with Voice</span>
            <span className="brand__subtitle">Capture or compose with on-device AI.</span>
          </div>
          <span className="pill pill--muted">Chrome {chromeVersion}</span>
        </div>
        <div className="mode-switch" role="tablist" aria-label="Ekko modes">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'transcribe'}
            className={`mode-switch__button ${mode === 'transcribe' ? 'mode-switch__button--active' : ''}`}
            onClick={() => applySettings({ mode: 'transcribe' })}
          >
            Transcribe
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'compose'}
            className={`mode-switch__button ${mode === 'compose' ? 'mode-switch__button--active' : ''}`}
            onClick={() => applySettings({ mode: 'compose' })}
          >
            Compose
          </button>
        </div>
      </header>

      {mode === 'transcribe' && (
        <>
          <section className="panel-section" aria-labelledby="capture-section-title">
            <div className="record-controls">
              <div className="record-controls__main">
                <button
                  type="button"
                  className={`record-button ${isRecording ? 'record-button--active' : ''}`}
                  onClick={handleToggleRecording}
                  disabled={micStatus === 'pending' || (!sttSupported && !isRecording)}
                >
                  <span className={`record-button__icon record-button__icon--${transcribeMicState}`}>
                    <MicIcon state={transcribeMicState} />
                  </span>
                  <span>{isRecording ? 'Stop recording' : 'Start recording'}</span>
                  <span className="sr-only" aria-live="polite">
                    {transcribeStatusText}
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
              onChange={(event) => handleTranscriptChange(event.target.value)}
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
        </>
      )}

      {mode === 'compose' && (
        <>
          <section className="panel-section" aria-labelledby="compose-controls-title">
            <h2 id="compose-controls-title" className="section-title">
              Compose with AI
            </h2>
            <p className="helper-text">
              Speak naturally—Gemini Nano will listen and draft the content for you.
            </p>
            <div>
              <p className="helper-text" style={{ marginBottom: '4px' }}>
                Draft style
              </p>
              <div className="compose-chip-group" role="listbox" aria-label="Compose style">
                {composePresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    role="option"
                    aria-selected={composePreset === preset.id}
                    className={`compose-chip ${composePreset === preset.id ? 'compose-chip--active' : ''}`}
                    onClick={() => setComposePreset(preset.id)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <p className="helper-text" style={{ marginTop: '4px' }}>
                {activeComposePreset.helper}
              </p>
            </div>
            <label htmlFor="compose-instruction" className="helper-text" style={{ fontWeight: 600 }}>
              Optional typed context
            </label>
            <textarea
              id="compose-instruction"
              className="transcript-area"
              style={{ minHeight: '80px' }}
              placeholder="Add details Gemini should know (recipient, tone, bullet points)…"
              value={composePrompt}
              onChange={(event) => {
                const value = event.target.value;
                setSettings((prev) => ({ ...prev, composePrompt: value }));
                if (composePromptDebounceRef.current) {
                  window.clearTimeout(composePromptDebounceRef.current);
                }
                composePromptDebounceRef.current = window.setTimeout(() => {
                  applySettings({ composePrompt: value });
                }, 400);
              }}
              onBlur={() => {
                if (composePromptDebounceRef.current) {
                  window.clearTimeout(composePromptDebounceRef.current);
                  composePromptDebounceRef.current = null;
                }
                applySettings({ composePrompt });
              }}
            />
            <div className="compose-controls">
              <button
                type="button"
                className={`record-button ${isComposeRecording ? 'record-button--active' : ''}`}
                onClick={isComposeRecording ? () => handleStopComposeRecording(false) : handleStartComposeRecording}
                disabled={
                  isComposeBusy ||
                  promptAvailabilityState === 'checking' ||
                  promptAvailabilityState === 'unsupported' ||
                  promptAvailabilityState === 'unavailable' ||
                  promptAvailabilityState === 'error'
                }
              >
                <span className={`record-button__icon record-button__icon--${composeMicState}`}>
                  <MicIcon state={composeMicState} />
                </span>
                <span>{isComposeRecording ? 'Stop capture' : 'Start capture'}</span>
                <span className="sr-only" aria-live="polite">
                  {composeStatusText}
                </span>
              </button>
              {composeState === 'streaming' && (
                <button type="button" className="button button--outline" onClick={handleCancelCompose}>
                  Cancel
                </button>
              )}
              <span className="compose-timer" aria-live="polite">
                {formatDuration(composeElapsedMs)} / {formatDuration(COMPOSE_MAX_DURATION_MS)}
              </span>
            </div>
            <div className="compose-status" aria-live="polite">
              {promptAvailabilityState === 'downloadable' && (
                <p className="helper-text">Chrome is downloading the on-device model. Keep this tab open.</p>
              )}
              {promptAvailabilityMessage && <p className="helper-text">{promptAvailabilityMessage}</p>}
              {composeError && <p className="helper-text compose-status__error">{composeError}</p>}
            </div>
          </section>

          <section className="panel-section" aria-labelledby="compose-output-title">
            <h2 id="compose-output-title" className="section-title">
              Draft Output
            </h2>
            <div className="compose-output">
              {composeHasOutput ? (
                <div className="compose-output__scroll">
                  {composeSubject && (
                    <p className="compose-output__subject" aria-label="Suggested subject">
                      {composeSubject}
                    </p>
                  )}
                  {composeParagraphs.length > 0
                    ? composeParagraphs.map((paragraph, index) => (
                        <p key={`compose-paragraph-${index}`} className="compose-output__text">
                          {paragraph}
                        </p>
                      ))
                    : (
                        <p className="compose-output__text">{composeContent}</p>
                      )}
                </div>
              ) : composeDisplayText ? (
                <div className="compose-output__scroll">
                  <p className="compose-output__text">{composeDisplayText}</p>
                </div>
              ) : (
                <p className="compose-output__placeholder">
                  After you record, Gemini Nano will stream the generated response here.
                </p>
              )}
            </div>
            <div className="compose-actions" role="toolbar" aria-label="Compose actions">
              <button type="button" className="button" disabled={!composeHasOutput} onClick={handleCopyCompose}>
                Copy
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={!composeHasOutput}
                onClick={handleInsertCompose}
              >
                Insert into page
              </button>
            </div>
          </section>
        </>
      )}

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
          <label htmlFor="floating-widget-toggle">Show floating widget</label>
          <input
            id="floating-widget-toggle"
            type="checkbox"
            checked={floatingWidgetEnabled}
            onChange={(event) => applySettings({ floatingWidgetEnabled: event.target.checked })}
          />
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
            Your sessions will appear here once you summarize, polish, or compose.
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
                  {entry.compose && (
                    <p className="history-item__summary">
                      <strong className="history-item__summary-label">
                        Compose ({entry.compose.presetLabel}):
                      </strong>{' '}
                      {entry.compose.paragraphs && entry.compose.paragraphs.length > 0
                        ? joinParagraphs(entry.compose.paragraphs)
                        : entry.compose.output}
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
