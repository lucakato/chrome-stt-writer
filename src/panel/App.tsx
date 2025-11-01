import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMicrophonePermission } from '@shared/hooks/useMicrophonePermission';
import { useSpeechRecorder } from '@shared/hooks/useSpeechRecorder';
import type { EchoMessage, EchoResponse } from '@shared/messages';
import { readOnboardingState, updateOnboardingState } from '@shared/storage/onboarding';
import {
  getRewriterAvailability,
  rewriteText,
  type RewriterAvailabilityStatus
} from '@shared/ai/rewriter';
import {
  composeFromAudio,
  composeFromText,
  createPromptSession,
  getPromptAvailability,
  TRANSCRIBE_STRUCTURED_SYSTEM_PROMPT,
  type PromptAvailabilityStatus
} from '@shared/ai/prompt';
import {
  ComposeDraftResult,
  coerceComposeDraft,
  composeDraftToClipboardText,
  createFallbackDraft,
  deriveParagraphs,
  joinParagraphs,
  normalizeComposeDraftResult
} from '@shared/compose';
import {
  DEFAULT_SETTINGS,
  getEchoSettings,
  observeEchoSettings,
  setEchoSettings,
  type EchoMode,
  type EchoSettings
} from '@shared/settings';
import { MdKeyboardVoice } from 'react-icons/md';
import { LuAudioLines } from 'react-icons/lu';
import { IoMicOffSharp } from 'react-icons/io5';
import { FiRotateCcw, FiPenTool } from 'react-icons/fi';
import { HiSparkles } from 'react-icons/hi';
import { FaWandMagicSparkles } from 'react-icons/fa6';

type Mode = 'transcribe' | 'compose';

const TEMP_DIRECT_INSERT_DELAY_MS = 150;

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

type RewritePreset =
  | 'concise-formal'
  | 'expand'
  | 'casual'
  | 'bullet'
  | 'action-items'
  | 'shorten';

type MicVisualState = 'idle' | 'recording' | 'off';

function MicIcon({ state }: { state: MicVisualState }) {
  const Icon =
    state === 'recording' ? LuAudioLines : state === 'off' ? IoMicOffSharp : MdKeyboardVoice;
  return <Icon size={20} aria-hidden="true" focusable="false" />;
}

type ComposePresetId =
  | 'freeform'
  | 'email-formal'
  | 'summary'
  | 'action-plan'
  | 'concise-formal'
  | 'expand'
  | 'casual'
  | 'bullet'
  | 'action-items'
  | 'shorten';

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

const BASE_SHARED_CONTEXT =
  'You are an AI assistant who is an expert writer. Rewrite the user\'s speech-to-text transcript from the user\'s perspective, improving clarity, grammar, and tone while preserving their intent.';
const COMPOSE_MAX_DURATION_MS = 90_000;

const rewritePresets: Array<{ id: RewritePreset; label: string }> = [
  { id: 'concise-formal', label: 'Concise • Formal' },
  { id: 'expand', label: 'Expand' },
  { id: 'casual', label: 'Casual' },
  { id: 'bullet', label: 'Bullet list' },
  { id: 'action-items', label: 'Action items' },
  { id: 'shorten', label: 'Shorten' }
];

const composePresets: Array<{ id: ComposePresetId; label: string; systemPrompt: string }> = [
  {
    id: 'freeform',
    label: 'Freeform',
    systemPrompt:
      'You are Echo, an on-device writing assistant. The user will dictate instructions about the message they need. Transform those instructions into the finished text, written from the user’s perspective. If the user mentions a recipient, address that person directly. Include any requested structure (such as lists or bullet points) inside the message. Never mention the instructions, never explain what you are doing, and do not add guidance or meta commentary—return only the final deliverable the user can send immediately.'
  },
  {
    id: 'email-formal',
    label: 'Formal email',
    systemPrompt:
      'You help users draft formal, polite emails. Produce the finished email text (include a subject line and sign-off when appropriate). Provide only the email—do not add guidance or commentary.'
  },
  {
    id: 'summary',
    label: 'Summary',
    systemPrompt:
      'You summarize the user’s spoken input into a concise digest. Present only the distilled summary in clear prose or bullet points, without extra advice or explanation.'
  },
  {
    id: 'action-plan',
    label: 'Action plan',
    systemPrompt:
      'You produce a clear action plan based on the user’s spoken intent. Return only the actionable steps (numbered or bullet list), keeping each step direct and free of meta commentary.'
  },
  {
    id: 'concise-formal',
    label: 'Concise • Formal',
    systemPrompt:
      'You craft concise, professional messages suitable for business communication. Transform the user’s instructions into a polished response addressed to the intended recipient. Use a clear subject when appropriate, stay courteous, and omit any meta commentary or explanations.'
  },
  {
    id: 'expand',
    label: 'Expand',
    systemPrompt:
      'You elaborate on the user’s instructions to produce a fuller, more detailed response. Provide helpful context and supporting details while staying faithful to the user’s intent. Respond directly to the recipient without adding guidance about how to use the message.'
  },
  {
    id: 'casual',
    label: 'Casual',
    systemPrompt:
      'You write in a relaxed, friendly tone. Turn the user’s instructions into an approachable message that sounds natural in everyday conversation, addressed directly to the recipient. Avoid meta commentary or explanations.'
  },
  {
    id: 'bullet',
    label: 'Bullet list',
    systemPrompt:
      'You return the final message as a concise bullet list that highlights the key points from the user’s instructions. Each bullet should be a complete, recipient-ready statement. Do not add prose outside the bullet list.'
  },
  {
    id: 'action-items',
    label: 'Action items',
    systemPrompt:
      'You provide a list of clear action items based on the user’s instructions. Use imperative language, include owners or deadlines when they are implied, and present the response as numbered steps or bullet items only.'
  },
  {
    id: 'shorten',
    label: 'Shorten',
    systemPrompt:
      'You create a significantly shorter message that still communicates the critical information from the user’s instructions. Respond from the user’s perspective, address the recipient directly, and avoid any meta commentary.'
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
  shorten: {
    sharedContext: BASE_SHARED_CONTEXT,
    context: 'Rewrite the text so it is significantly shorter while preserving key information and readability.',
    length: 'shorter',
    format: 'plain-text'
  }
};

const REFINE_CONTEXT =
  'Refine the user\'s transcript by fixing grammar, removing redundant or filler language, and preserving intent.';

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
  const [settings, setSettings] = useState<EchoSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);

  const [transcript, setTranscript] = useState('');
  const [rewritePreset, setRewritePreset] = useState<RewritePreset>('concise-formal');
  const [directInsertEnabledState, setDirectInsertEnabledState] = useState(true);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [previewContent, setPreviewContent] = useState<{ kind: "summary" | "rewrite"; text: string; label?: string } | null>(null);
  const [language, setLanguage] = useState<string>(() => navigator.language ?? 'en-US');
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

const [summarizerState, setSummarizerState] = useState<'idle' | 'checking' | RewriterAvailabilityStatus | 'summarizing'>('idle');
  const [summarizerError, setSummarizerError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [summarizerMessage, setSummarizerMessage] = useState<string | null>(null);

  const [rewriterState, setRewriterState] = useState<'idle' | 'checking' | RewriterAvailabilityStatus | 'rewriting'>('idle');
  const [rewriterError, setRewriterError] = useState<string | null>(null);
  const [rewriterMessage, setRewriterMessage] = useState<string | null>(null);
  const [insertBusy, setInsertBusy] = useState(false);

  const [promptAvailabilityState, setPromptAvailabilityState] = useState<'idle' | 'checking' | PromptAvailabilityStatus>('idle');
  const [promptAvailabilityMessage, setPromptAvailabilityMessage] = useState<string | null>(null);
  const [composePreset, setComposePreset] = useState<ComposePresetId>('freeform');
const [composeState, setComposeState] = useState<'idle' | 'recording' | 'processing' | 'streaming'>('idle');
const [composeError, setComposeError] = useState<string | null>(null);
const [composeDraft, setComposeDraft] = useState<ComposeDraftResult | null>(null);
const [composeRawPreview, setComposeRawPreview] = useState('');
const [composeElapsedMs, setComposeElapsedMs] = useState(0);
const [composeReplayReady, setComposeReplayReady] = useState(false);
const [composeTranscript, setComposeTranscript] = useState('');
const [composeTranscriptInterim, setComposeTranscriptInterim] = useState('');
  const activeSessionIdRef = useRef<string | null>(null);
  const lastDirectInsertValueRef = useRef<string>('');
  const lastStructuredTranscriptRef = useRef<string>('');
  const structuredInsertAbortRef = useRef<AbortController | null>(null);
  const directInsertEnabledRef = useRef(directInsertEnabledState);
  const composeRecorderRef = useRef<MediaRecorder | null>(null);
  const composeChunksRef = useRef<Blob[]>([]);
  const composeTimerRef = useRef<number | null>(null);
  const composeStartTimeRef = useRef<number | null>(null);
  const composeAbortRef = useRef<AbortController | null>(null);
  const composeStreamRef = useRef<MediaStream | null>(null);
const composeSpeechRecognitionRef = useRef<SpeechRecognition | null>(null);
const composeTranscriptFinalRef = useRef('');
const composeTranscriptInterimRef = useRef('');
const composeCleanupPendingRef = useRef(false);
const composeEntryIdRef = useRef<string | null>(null);
const lastComposeAudioRef = useRef<ArrayBuffer | null>(null);
const composeStateRef = useRef(composeState);
  const composeAbortNextRef = useRef(false);
  const composeRestartPendingRef = useRef(false);
  const restartTranscribePendingRef = useRef(false);
const composeSessionRef = useRef<LanguageModelSession | null>(null);
const composeSessionPromiseRef = useRef<Promise<LanguageModelSession> | null>(null);
const promptAvailabilityStateRef = useRef<'idle' | 'checking' | PromptAvailabilityStatus>(promptAvailabilityState);
const promptAvailabilityMessageRef = useRef<string | null>(promptAvailabilityMessage);

  const directInsertEnabled = directInsertEnabledState;

  useEffect(() => {
    composeStateRef.current = composeState;
  }, [composeState]);

  useEffect(() => {
    promptAvailabilityStateRef.current = promptAvailabilityState;
  }, [promptAvailabilityState]);

  useEffect(() => {
    promptAvailabilityMessageRef.current = promptAvailabilityMessage;
  }, [promptAvailabilityMessage]);

  const restorePromptAvailability = useCallback(
    (state: 'idle' | 'checking' | PromptAvailabilityStatus, message: string | null) => {
      setPromptAvailabilityState(state);
      setPromptAvailabilityMessage(message);
    },
    []
  );

  const setDirectInsertEnabled = useCallback((enabled: boolean) => {
    setDirectInsertEnabledState(enabled);
    directInsertEnabledRef.current = enabled;
  }, []);

  const refreshDirectInsertState = useCallback(async () => {
    if (!chrome.runtime?.sendMessage) {
      return;
    }
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'ekko/direct-insert/query'
      } satisfies EchoMessage)) as EchoResponse | undefined;
      if (response && response.ok && response.data && typeof response.data === 'object') {
        const enabled = !!(response.data as { enabled?: boolean }).enabled;
        setDirectInsertEnabled(enabled);
      }
    } catch (error) {
      console.warn('Unable to refresh direct insert state', error);
    }
  }, [setDirectInsertEnabled]);

  useEffect(() => {
    const sendState = (open: boolean, tabId?: number, windowId?: number) => {
      chrome.runtime
        ?.sendMessage({
          type: 'ekko/sidepanel/state',
          payload: { open, tabId, windowId }
        } satisfies EchoMessage)
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

    getEchoSettings()
      .then((value) => {
        if (!active) return;
        setSettings(value);
        setSettingsReady(true);
      })
      .catch((error) => {
        console.warn('Unable to load Echo settings', error);
      });

    const dispose = observeEchoSettings((value, changed) => {
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

  const applySettings = useCallback((partial: Partial<EchoSettings>) => {
    setSettings((prev) => {
      const optimistic = { ...prev, ...partial };
      setEchoSettings(partial).catch((error) => {
        console.warn('Unable to update Echo settings', error);
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
    if (restartTranscribePendingRef.current) {
      return;
    }
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

  const handleRestartTranscribe = useCallback(async () => {
    if (!isMicGranted) {
      const granted = await requestPermission();
      if (!granted) {
        return;
      }
    }

    if (!sttSupported && !isRecording) {
      return;
    }

    structuredInsertAbortRef.current?.abort();
    structuredInsertAbortRef.current = null;
    setInsertBusy(false);
    setPreviewContent(null);
    setSummarizerState('idle');
    setSummarizerError(null);
    setSummarizerMessage(null);
    setDownloadProgress(null);
    setRewriterState('idle');
    setRewriterError(null);
    setRewriterMessage(null);
    lastStructuredTranscriptRef.current = '';
    setTranscript('');
    clearInterim();
    resetSttError();

    if (isRecording) {
      restartTranscribePendingRef.current = true;
      stopRecording();
      return;
    }

    if (!sttSupported) {
      return;
    }

    const started = startRecording();
    if (!started) {
      console.warn('Speech recognition failed to start.');
    }
  }, [
    clearInterim,
    isMicGranted,
    isRecording,
    requestPermission,
    resetSttError,
    setDownloadProgress,
    setInsertBusy,
    setRewriterError,
    setRewriterMessage,
    setRewriterState,
    setSummarizerError,
    setSummarizerMessage,
    setSummarizerState,
    setTranscript,
    startRecording,
    stopRecording,
    sttSupported
  ]);

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
  const composeTranscriptDisplay = useMemo(() => {
    const finalText = composeTranscript;
    const interimText = composeTranscriptInterim.trim();
    if (interimText) {
      const needsSpace = finalText && !/[\s\n]$/.test(finalText) ? ' ' : '';
      return `${finalText}${needsSpace}${interimText}`;
    }
    return finalText;
  }, [composeTranscript, composeTranscriptInterim]);
  const transcribeRecordDisabled = micStatus === 'pending' || (!sttSupported && !isRecording);
  const transcribeRecordTitle = transcribeRecordDisabled
    ? micStatus === 'pending'
      ? 'Microphone permission pending…'
      : 'Speech recognition unavailable'
    : isRecording
    ? 'Stop recording'
    : 'Start recording';
  const transcribeRestartDisabled = transcribeRecordDisabled;
  const transcribeRestartTitle = transcribeRestartDisabled
    ? transcribeRecordTitle
    : isRecording
    ? 'Restart recording'
    : 'Start new recording';
  const promptBlocksRecording =
    promptAvailabilityState === 'checking' ||
    promptAvailabilityState === 'unsupported' ||
    promptAvailabilityState === 'unavailable' ||
    promptAvailabilityState === 'error';
  const composeRecordDisabled = isComposeBusy || promptBlocksRecording;
  const composeRecordTitle = composeRecordDisabled
    ? promptAvailabilityState === 'checking'
      ? 'Checking on-device model availability…'
      : promptAvailabilityState === 'unsupported'
      ? 'Compose is unsupported on this device'
      : promptAvailabilityState === 'unavailable'
      ? 'On-device model not ready'
      : promptAvailabilityState === 'error'
      ? 'Compose unavailable right now'
      : 'Compose busy'
    : isComposeRecording
    ? 'Stop capture'
    : 'Start capture';
  const composeRestartDisabled = composeRecordDisabled;
  const composeRestartTitle = composeRestartDisabled
    ? composeRecordTitle
    : isComposeRecording
    ? 'Restart capture'
    : 'Start new capture';
  const composeTranscriptHasText = composeTranscript.trim().length > 0;
  const composeReplayDisabled =
    composeState !== 'idle' || (!composeReplayReady && !composeTranscriptHasText);
  const composeReplayTitle = composeReplayDisabled
    ? !composeReplayReady && !composeTranscriptHasText
      ? 'Record or type instructions first'
      : composeState === 'recording'
      ? 'Stop recording to compose'
      : composeState === 'processing'
      ? 'Processing audio…'
      : composeState === 'streaming'
      ? 'Compose in progress…'
      : composeRecordTitle
    : composeTranscriptHasText && !composeReplayReady
    ? 'Generate from typed instructions'
    : 'Generate draft from the last recording';
  const previewTextDisplay = previewContent?.text?.trim() ?? '';
  const previewCardClassName =
    previewContent?.kind === 'rewrite'
      ? 'summary-preview rewrite-preview'
      : 'summary-preview';
  const showPreviewCard = previewTextDisplay.length > 0;

  const micMessages = useMemo(() => {
    const messages: ReactNode[] = [];
    if (micError) {
      messages.push(
        <p key="mic-error" className="helper-text danger">
          {micError}
        </p>
  );
}
    if (!micError && micStatus === 'denied') {
      messages.push(
        <p key="mic-denied" className="helper-text danger">
          Microphone access is blocked. Click the lock icon next to the address bar, set Microphone to "Allow", then try
          again.
        </p>
      );
    }
    if (!micError && micStatus === 'prompt') {
      messages.push(
        <p key="mic-prompt" className="helper-text">
          When Chrome prompts for access, choose Allow to start recording.
        </p>
      );
    }
    if (sttError) {
      messages.push(
        <p key="stt-error" className="helper-text danger">
          {sttError}
        </p>
      );
    }
    if (!sttSupported) {
      messages.push(
        <p key="stt-unsupported" className="helper-text danger">
          Live speech-to-text is not available in this browser. Try Chrome on desktop (138+) for Gemini Nano.
        </p>
      );
    }
    return messages;
  }, [micError, micStatus, sttError, sttSupported]);

  useEffect(() => {
    if (!restartTranscribePendingRef.current || isRecording) {
      return;
    }
    if (!isMicGranted) {
      restartTranscribePendingRef.current = false;
      return;
    }
    restartTranscribePendingRef.current = false;
    if (!sttSupported) {
      return;
    }
    resetSttError();
    const started = startRecording();
    if (!started) {
      console.warn('Speech recognition failed to restart.');
    }
  }, [isMicGranted, isRecording, resetSttError, startRecording, sttSupported]);


  const showMicSettingsButton = micStatus === 'denied';
  const hasMicMessages = micMessages.length > 0;
  const shouldRenderMicMessages = hasMicMessages || showMicSettingsButton;

  const handleSummarize = useCallback(async () => {
    if (!activeTranscript) {
      return;
    }

    if (!isRecording || !interimTranscript.trim()) {
      setTranscript(activeTranscript);
    }
    setSummarizerError(null);
    setSummarizerState('summarizing');
    setSummarizerMessage('Refining text…');
    setDownloadProgress(null);
    setPreviewContent(null);

    try {
      const result = await rewriteText({
        text: activeTranscript,
        sharedContext: BASE_SHARED_CONTEXT,
        context: REFINE_CONTEXT,
        format: 'plain-text',
        outputLanguage,
        onStatusChange: (status) => {
          if (status === 'downloadable') {
            setSummarizerError(null);
            setSummarizerMessage('Downloading on-device model…');
          }
          if (status === 'ready') {
            setSummarizerState('summarizing');
            setSummarizerError(null);
            setSummarizerMessage('Model ready. Refining…');
          }
        },
        onDownloadProgress: (progress) => {
          setSummarizerError(null);
          setSummarizerMessage(`Downloading on-device model… ${Math.round(progress * 100)}%`);
          setDownloadProgress(progress);
        },
        onChunk: (chunk) => {
          const next = chunk.trim();
          if (next) {
            setPreviewContent({ kind: 'summary', text: next });
          }
        }
      });

      setSummarizerState('ready');
      setSummarizerMessage(null);
      setSummarizerError(null);
      setDownloadProgress(null);
      const finalSummary = (result.content ?? activeTranscript).trim();
      setPreviewContent(
        finalSummary.length > 0 ? { kind: 'summary', text: finalSummary } : null
      );

      const entryId = activeSessionIdRef.current ?? crypto.randomUUID();
      activeSessionIdRef.current = entryId;
      setHistory((entries) => {
        const existing = entries.find((entry) => entry.id === entryId);
        const actions = Array.from(new Set(['Refined', ...(existing?.actions ?? [])]));
        const updatedEntry: HistoryEntry = {
          id: entryId,
          title: activeTranscript.slice(0, 60) || 'Untitled transcript',
          createdAt: existing?.createdAt ?? new Date().toLocaleTimeString(),
          actions,
          summary: result.content,
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
            summary: result.content
          }
        } satisfies EchoMessage)
        .then((response: EchoResponse | undefined) => {
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
      const rawMessage = error instanceof Error ? error.message : 'Refine request failed.';
      let message = rawMessage;
      if (/enough space/i.test(rawMessage)) {
        message = 'Chrome needs about 22 GB of free space on the profile drive to download the Gemini Nano model. Clear space and try again.';
      }
      setSummarizerState('error');
      setSummarizerError(message);
      setSummarizerMessage(null);
      setDownloadProgress(null);
      setPreviewContent(null);
    }
  }, [activeTranscript, outputLanguage, isRecording, interimTranscript]);

  const handleRewrite = useCallback(async () => {
    if (!activeTranscript) {
      return;
    }

    const presetConfig = rewritePresetConfig[rewritePreset] ?? rewritePresetConfig['concise-formal'];
    if (!isRecording || !interimTranscript.trim()) {
      setTranscript(activeTranscript);
    }
    setRewriterError(null);
    setRewriterMessage('Generating rewrite…');
    setPreviewContent(null);
    setRewriterState('rewriting');

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
          const next = chunk.trim();
          if (next) {
            setPreviewContent({ kind: 'rewrite', text: next, label: rewritePresetLabel });
          }
        }
      });

      setRewriterState('ready');
      setRewriterMessage(null);
      setRewriterError(null);
      const finalRewrite = (result.content ?? '').trim();
      setPreviewContent(
        finalRewrite.length > 0
          ? { kind: 'rewrite', text: finalRewrite, label: rewritePresetLabel }
          : null
      );

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
        } satisfies EchoMessage)
        .then((response: EchoResponse | undefined) => {
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
      setPreviewContent(null);
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

  const deliverDirectInsertDraft = useCallback(async (draft: ComposeDraftResult) => {
    const normalized = normalizeComposeDraftResult(draft);
    const runtime = chrome.runtime;
    if (!runtime?.sendMessage) {
      throw new Error('Chrome runtime unavailable for direct insert.');
    }
    await runtime.sendMessage({
      type: 'ekko/direct-insert/apply',
      payload: {
        draft: {
          content: normalized.content,
          subject: normalized.subject,
          paragraphs: normalized.paragraphs
        }
      }
    } satisfies EchoMessage);
    return true;
  }, []);

  const insertTranscriptIntoPage = useCallback(
    async (
      text: string,
      options: { skipStructuring?: boolean; signal?: AbortSignal } = {}
    ): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed) {
        return false;
      }

      const runtime = chrome.runtime;
      if (!runtime?.sendMessage) {
        throw new Error('Chrome runtime unavailable for direct insert.');
      }

      if (options.skipStructuring) {
        await runtime.sendMessage({
          type: 'ekko/direct-insert/apply',
          payload: { text: trimmed }
        } satisfies EchoMessage);
        return true;
      }

      try {
        const draft = await composeFromText({
          text: trimmed,
          systemPrompt: TRANSCRIBE_STRUCTURED_SYSTEM_PROMPT,
          outputLanguage,
          signal: options.signal
        });
        await deliverDirectInsertDraft(draft);
        return true;
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }
        console.warn('Unable to generate structured transcript draft', error);
        const fallback = normalizeComposeDraftResult(createFallbackDraft(trimmed));
        await deliverDirectInsertDraft(fallback);
        return true;
      }
    },
    [deliverDirectInsertDraft, outputLanguage]
  );

  const toggleDirectInsertBridge = useCallback(
    async (
      enabled: boolean,
      {
        preserveHistory = false,
        updateUiState = true
      }: { preserveHistory?: boolean; updateUiState?: boolean } = {}
    ) => {
      const runtime = chrome.runtime;
      if (!runtime?.sendMessage) {
        throw new Error('Chrome runtime unavailable for direct insert toggle.');
      }
      const response = await runtime
        .sendMessage({
          type: 'ekko/direct-insert/toggle',
          payload: { enabled }
        } satisfies EchoMessage)
        .catch((error) => {
          console.warn('Unable to toggle direct insert bridge', error);
          throw error;
        });
      if (response && typeof response === 'object' && 'ok' in response && !(response as { ok?: boolean }).ok) {
        const message = (response as { error?: string }).error ?? 'Unable to toggle Direct Insert Mode.';
        throw new Error(message);
      }
      if (updateUiState) {
        setDirectInsertEnabled(enabled);
        if (!enabled && !preserveHistory) {
          lastDirectInsertValueRef.current = '';
        }
      }
      if (enabled) {
        await sleep(TEMP_DIRECT_INSERT_DELAY_MS);
      }
    },
    []
  );

  const runWithDirectInsertBridge = useCallback(
    async <T,>(task: () => Promise<T>): Promise<T> => {
      if (directInsertEnabledRef.current) {
        return task();
      }
      let autoEnabled = false;
      await toggleDirectInsertBridge(true, { preserveHistory: true, updateUiState: false });
      autoEnabled = true;
      try {
        return await task();
      } finally {
        if (autoEnabled && !directInsertEnabledRef.current) {
          try {
            await toggleDirectInsertBridge(false, { preserveHistory: true, updateUiState: false });
          } catch (error) {
            console.warn('Unable to disable direct insert bridge after temporary use', error);
            void refreshDirectInsertState();
          }
        }
      }
    },
    [refreshDirectInsertState, toggleDirectInsertBridge]
  );

  const handleInsertTranscript = useCallback(async () => {
    const previewText = previewContent?.text?.trim();
    const text = previewText && previewText.length > 0 ? previewText : activeTranscript.trim();
    if (!text) {
      setSummarizerMessage('Nothing to insert yet.');
      return;
    }

    if (insertBusy || isSummarizerBusy || isRewriterBusy) {
      return;
    }

    setInsertBusy(true);
    setSummarizerError(null);
    setSummarizerMessage(
      directInsertEnabled ? 'Inserting into page…' : 'Temporarily enabling Direct Insert Mode…'
    );

    try {
      await runWithDirectInsertBridge(() => insertTranscriptIntoPage(text));
      lastDirectInsertValueRef.current = text;
      const trimmedTranscript = activeTranscript.trim();
      lastStructuredTranscriptRef.current =
        previewText && previewText.length > 0 ? trimmedTranscript : text;
      setSummarizerMessage('Draft inserted into page.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to insert transcript.';
      console.warn('Unable to insert transcript into page', error);
      try {
        await navigator.clipboard.writeText(text);
        setSummarizerMessage('Copied to clipboard instead.');
      } catch (copyError) {
        console.warn('Unable to copy transcript after insert failure', copyError);
        setSummarizerError(message);
        setSummarizerMessage(null);
      }
    } finally {
      setInsertBusy(false);
    }
  }, [
    activeTranscript,
    directInsertEnabled,
    insertBusy,
    insertTranscriptIntoPage,
    isRewriterBusy,
    isSummarizerBusy,
    previewContent,
    runWithDirectInsertBridge
  ]);

  const handleDirectInsertToggle = useCallback(
    (enabled: boolean) => {
      const previous = directInsertEnabledRef.current;
      setDirectInsertEnabled(enabled);
      if (!enabled) {
        lastDirectInsertValueRef.current = '';
      }
      void toggleDirectInsertBridge(enabled, { updateUiState: false })
        .then(() => {
          void refreshDirectInsertState();
        })
        .catch((error) => {
          console.warn('Unable to toggle direct insert bridge from UI', error);
          setDirectInsertEnabled(previous);
        });
    },
    [refreshDirectInsertState, setDirectInsertEnabled, toggleDirectInsertBridge]
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

const runComposeFromText = useCallback(
  async (textInput: string) => {
    const trimmedInput = textInput.trim();
    if (!trimmedInput) {
      setComposeError('Provide instructions before composing.');
      return;
    }

    const preset = activeComposePreset;
    const instructions = composePrompt.trim();
    const systemPrompt = instructions
      ? `${preset.systemPrompt}\n\nFollow these additional instructions exactly:\n${instructions}`
      : preset.systemPrompt;

    setComposeError(null);
    setComposeState('streaming');
    setComposeDraft(null);
    setComposeRawPreview('');
    composeAbortRef.current = null;

    const previousPromptState = promptAvailabilityStateRef.current;
    const previousPromptMessage = promptAvailabilityMessageRef.current;

    try {
      let session: LanguageModelSession | null = composeSessionRef.current;
      if (!session) {
        const availability = await getPromptAvailability({
          expectedInputs: [{ type: 'audio', languages: [outputLanguage] }],
          expectedOutputs: [{ type: 'text', languages: [outputLanguage] }]
        });

        setPromptAvailabilityState(availability.status);
        setPromptAvailabilityMessage(availability.message ?? null);

        if (
          availability.status === 'unsupported' ||
          availability.status === 'unavailable' ||
          availability.status === 'error'
        ) {
          const message = availability.message ?? 'Prompt API is not ready yet on this device.';
          setComposeError(message);
          setComposeState('idle');
          return;
        }

        session = await ensurePromptSession();
      }

      const textDraft = await composeFromText({
        text: trimmedInput,
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
        session
      });

      const normalizedParagraphs =
        textDraft.paragraphs && textDraft.paragraphs.length > 0
          ? textDraft.paragraphs
          : deriveParagraphs(textDraft.content);
      const normalizedDraft: ComposeDraftResult = {
        raw: textDraft.raw,
        content: joinParagraphs(normalizedParagraphs).trim(),
        subject:
          textDraft.subject && textDraft.subject.trim().length > 0
            ? textDraft.subject.trim()
            : undefined,
        paragraphs: normalizedParagraphs
      };

      setComposeDraft(normalizedDraft);
      setComposeRawPreview(normalizedDraft.raw ?? normalizedDraft.content);
      setComposeState('idle');
      setComposeElapsedMs(0);
      composeAbortRef.current = null;
      setComposeReplayReady(true);
      lastComposeAudioRef.current = null;

      const entryId = crypto.randomUUID();
      composeEntryIdRef.current = entryId;
      const createdAt = new Date().toLocaleTimeString();
      const historyTitle =
        normalizedDraft.subject ?? (normalizedDraft.content.slice(0, 60) || `${preset.label} draft`);

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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Compose failed.';
      setComposeError(message);
      setComposeState('idle');
      restorePromptAvailability(previousPromptState, previousPromptMessage);
    }
  }, [
    activeComposePreset,
    composePrompt,
    ensurePromptSession,
    outputLanguage,
    restorePromptAvailability,
    setHistory
  ]);

const runCompose = useCallback(
    async (audioBuffer: ArrayBuffer) => {
      const preset = activeComposePreset;
      const instructions = composePrompt.trim();
      console.info('[Echo] side panel instruction:', instructions);
      const systemPrompt = instructions
        ? `${preset.systemPrompt}\n\nFollow these additional instructions exactly:\n${instructions}`
        : preset.systemPrompt;

      setComposeError(null);
      setComposeState('streaming');
      setComposeDraft(null);
      setComposeRawPreview('');

      const abortController = new AbortController();
      composeAbortRef.current = abortController;

      const previousPromptState = promptAvailabilityStateRef.current;
      const previousPromptMessage = promptAvailabilityMessageRef.current;

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

        const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
        const spokenInstructions = composeTranscriptFinalRef.current.trim();
        const resultLooksLikeInstructions = () => {
          if (!spokenInstructions) return false;
          const normalizedResult = normalize(normalizedDraft.content);
          const normalizedInstructions = normalize(spokenInstructions);
          if (!normalizedResult || !normalizedInstructions) return false;
          if (normalizedResult === normalizedInstructions) return true;
          if (
            normalizedResult.length <= normalizedInstructions.length + 20 &&
            normalizedResult.includes(normalizedInstructions)
          ) {
            return true;
          }
          const instructionPhrases = ['i want you', 'can you', 'please', 'i need you'];
          if (
            instructionPhrases.some((phrase) =>
              normalizedResult.startsWith(phrase)
            ) &&
            normalizedInstructions.length >= normalizedResult.length - 15
          ) {
            return true;
          }
          return false;
        };

        let finalDraft = normalizedDraft;

        if (resultLooksLikeInstructions()) {
          try {
            const textCompose = await composeFromText({
              text: spokenInstructions,
              systemPrompt,
              instruction: instructions || undefined,
              outputLanguage
            });
            const textParagraphs =
              textCompose.paragraphs && textCompose.paragraphs.length > 0
                ? textCompose.paragraphs
                : deriveParagraphs(textCompose.content);
            finalDraft = {
              raw: textCompose.raw,
              content: joinParagraphs(textParagraphs).trim(),
              subject:
                textCompose.subject && textCompose.subject.trim().length > 0
                  ? textCompose.subject.trim()
                  : undefined,
              paragraphs: textParagraphs
            };
          } catch (fallbackError) {
            console.warn('Compose text fallback failed', fallbackError);
          }
        }

        setComposeDraft(finalDraft);
        setComposeRawPreview(finalDraft.raw ?? finalDraft.content);
        setComposeState('idle');
        setComposeElapsedMs(0);
        composeAbortRef.current = null;
        setComposeReplayReady(true);

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
          } satisfies EchoMessage)
          .then((response: EchoResponse | undefined) => {
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
          restorePromptAvailability(previousPromptState, previousPromptMessage);
        }
        setComposeDraft(null);
        setComposeRawPreview('');
        setComposeState('idle');
      } finally {
        composeAbortRef.current = null;
      }
    },
    [
      activeComposePreset,
      composePrompt,
      ensurePromptSession,
      outputLanguage,
      restorePromptAvailability,
      runComposeFromText
    ]
  );


  const stopComposeSpeechRecognition = useCallback(() => {
    const recognition = composeSpeechRecognitionRef.current;
    if (!recognition) {
      return;
    }
    composeSpeechRecognitionRef.current = null;
    const interim = composeTranscriptInterimRef.current.trim();
    if (interim) {
      composeTranscriptFinalRef.current = composeTranscriptFinalRef.current
        ? `${composeTranscriptFinalRef.current} ${interim}`
        : interim;
    }
    composeTranscriptFinalRef.current = composeTranscriptFinalRef.current.trim();
    composeTranscriptInterimRef.current = '';
    setComposeTranscript(composeTranscriptFinalRef.current);
    setComposeTranscriptInterim('');
    try {
      recognition.stop();
    } catch (error) {
      console.warn('Unable to stop compose speech recognition', error);
    }
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
  }, []);

  const startComposeSpeechRecognition = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const SpeechRecognitionCtor =
      (window as typeof window & { webkitSpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition ||
      (window as typeof window & { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      composeTranscriptFinalRef.current = '';
      setComposeTranscript('');
      setComposeTranscriptInterim('');
      composeSpeechRecognitionRef.current = null;
      return;
    }

    stopComposeSpeechRecognition();
    composeTranscriptFinalRef.current = '';
    composeTranscriptInterimRef.current = '';
    setComposeTranscript('');
    setComposeTranscriptInterim('');

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = normalizedLanguage;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      composeTranscriptInterimRef.current = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (!transcript) continue;
        if (result.isFinal) {
          const normalized = transcript.trim();
          composeTranscriptFinalRef.current = composeTranscriptFinalRef.current
            ? `${composeTranscriptFinalRef.current} ${normalized}`
            : normalized;
        } else {
          composeTranscriptInterimRef.current += transcript;
        }
      }
      setComposeTranscript(composeTranscriptFinalRef.current.trim());
      setComposeTranscriptInterim(composeTranscriptInterimRef.current.trim());
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error !== 'aborted') {
        console.warn('Compose speech recognition error', event);
      }
    };

    recognition.onend = () => {
      if (composeSpeechRecognitionRef.current === recognition) {
        composeSpeechRecognitionRef.current = null;
      }
      const interim = composeTranscriptInterimRef.current.trim();
      if (interim) {
        composeTranscriptFinalRef.current = composeTranscriptFinalRef.current
          ? `${composeTranscriptFinalRef.current} ${interim}`
          : interim;
        composeTranscriptInterimRef.current = '';
        setComposeTranscriptInterim('');
      }
      composeTranscriptFinalRef.current = composeTranscriptFinalRef.current.trim();
      setComposeTranscript(composeTranscriptFinalRef.current);
    };

    try {
      recognition.start();
      composeSpeechRecognitionRef.current = recognition;
    } catch (error) {
      console.warn('Unable to start compose speech recognition', error);
      composeSpeechRecognitionRef.current = null;
    }
  }, [normalizedLanguage, stopComposeSpeechRecognition]);

  const handleStopComposeRecording = useCallback(
    (auto = false, { abort = false }: { abort?: boolean } = {}) => {
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
      if (abort) {
        composeAbortNextRef.current = true;
        setComposeState('idle');
        setComposeError(null);
      } else {
        setComposeState('processing');
      }
      if (auto && !abort) {
        setComposeError('Recording paused after 90 seconds to keep sessions responsive.');
      }
      try {
        recorder.stop();
      } catch (error) {
        console.warn('Unable to stop compose recorder', error);
        setComposeState('idle');
        if (abort) {
          composeAbortNextRef.current = false;
          composeRestartPendingRef.current = false;
        }
      }
      stopComposeSpeechRecognition();
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

    if (composeStateRef.current === 'recording') {
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
      lastComposeAudioRef.current = null;
      setComposeReplayReady(false);

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
      const previousPromptState = promptAvailabilityStateRef.current;
      const previousPromptMessage = promptAvailabilityMessageRef.current;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          composeChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const stoppedStream = stream;
        const stoppedRecorder = recorder;
        if (composeTimerRef.current) {
          window.clearInterval(composeTimerRef.current);
          composeTimerRef.current = null;
        }
        composeStartTimeRef.current = null;
        setComposeElapsedMs(0);
        stopComposeSpeechRecognition();
        if (composeRecorderRef.current === stoppedRecorder) {
          composeRecorderRef.current = null;
        }
        stoppedStream.getTracks().forEach((track) => track.stop());
        if (composeStreamRef.current === stoppedStream) {
          composeStreamRef.current = null;
        }

        const aborted = composeAbortNextRef.current;
        const restartPending = composeRestartPendingRef.current;
        composeAbortNextRef.current = false;
        composeCleanupPendingRef.current = false;

        const chunks = composeChunksRef.current;
        composeChunksRef.current = [];

        if (aborted) {
          setComposeDraft(null);
          setComposeRawPreview('');
          setComposeState('idle');
          setComposeError(null);
          composeEntryIdRef.current = null;
          if (!restartPending) {
            composeRestartPendingRef.current = false;
          }
          restorePromptAvailability(previousPromptState, previousPromptMessage);
          return;
        }

        if (!chunks.length) {
          setComposeError('No audio captured. Try recording again.');
          setComposeState('idle');
          restorePromptAvailability(previousPromptState, previousPromptMessage);
          return;
        }

        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          const buffer = await blob.arrayBuffer();
          lastComposeAudioRef.current = buffer.slice(0);
          setComposeReplayReady(true);
          await runCompose(buffer);
        } catch (processingError) {
          const message =
            processingError instanceof Error
              ? processingError.message
              : 'Unable to process recorded audio.';
          setComposeError(message);
          setComposeState('idle');
          restorePromptAvailability(previousPromptState, previousPromptMessage);
        }

        composeRestartPendingRef.current = false;
      };

      recorder.onerror = (event) => {
        console.warn('MediaRecorder error', event);
        setComposeError('Chrome could not capture audio. Try again.');
        setComposeState('idle');
        stopComposeSpeechRecognition();
      };

      recorder.start();
      composeStartTimeRef.current = Date.now();
      setComposeState('recording');
      startComposeSpeechRecognition();

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
  }, [
    composeStateRef,
    ensurePromptSession,
    handleStopComposeRecording,
    isMicGranted,
    isPromptUnavailable,
    requestPermission,
    restorePromptAvailability,
    runCompose,
    startComposeSpeechRecognition,
    stopComposeSpeechRecognition
  ]);

  const handleRestartComposeRecording = useCallback(async () => {
    if (!isMicGranted) {
      const granted = await requestPermission();
      if (!granted) {
        return;
      }
    }

    composeAbortRef.current?.abort();
    composeAbortRef.current = null;
    setComposeDraft(null);
    setComposeRawPreview('');
    setComposeError(null);
    setComposeElapsedMs(0);
    composeChunksRef.current = [];
    composeEntryIdRef.current = null;
    composeStartTimeRef.current = null;
    if (composeTimerRef.current) {
      window.clearInterval(composeTimerRef.current);
      composeTimerRef.current = null;
    }
    stopComposeSpeechRecognition();
    composeTranscriptFinalRef.current = '';
    composeTranscriptInterimRef.current = '';
    setComposeTranscript('');
    setComposeTranscriptInterim('');
    lastComposeAudioRef.current = null;
    setComposeReplayReady(false);

    if (composeStateRef.current === 'recording') {
      composeRestartPendingRef.current = true;
      composeCleanupPendingRef.current = true;
      handleStopComposeRecording(false, { abort: true });
      return;
    }

    if (composeStateRef.current === 'processing' || composeStateRef.current === 'streaming') {
      composeRestartPendingRef.current = true;
      composeCleanupPendingRef.current = true;
      return;
    }

    composeRestartPendingRef.current = false;
    composeAbortNextRef.current = false;
    composeCleanupPendingRef.current = false;

    if (composeRecorderRef.current) {
      try {
        if (composeRecorderRef.current.state === 'recording') {
          composeRecorderRef.current.stop();
        }
      } catch {
        /* ignore */
      }
      composeRecorderRef.current = null;
    }
    composeStreamRef.current?.getTracks().forEach((track) => track.stop());
    composeStreamRef.current = null;

    if (composeStateRef.current === 'idle') {
      void handleStartComposeRecording();
    } else {
      setComposeState('idle');
      composeRestartPendingRef.current = true;
      composeCleanupPendingRef.current = true;
    }
  }, [
    handleStartComposeRecording,
    handleStopComposeRecording,
    isMicGranted,
    requestPermission,
    setComposeDraft,
    setComposeElapsedMs,
    setComposeError,
    setComposeRawPreview,
    setComposeState,
    composeStateRef,
    stopComposeSpeechRecognition,
    setComposeTranscript,
    setComposeTranscriptInterim
  ]);

  useEffect(() => {
    if (!composeRestartPendingRef.current) {
      return;
    }
    if (composeState !== 'idle' || composeCleanupPendingRef.current) {
      return;
    }
    composeRestartPendingRef.current = false;
    composeAbortNextRef.current = false;
    void handleStartComposeRecording();
  }, [composeState, handleStartComposeRecording]);

  const handleCancelCompose = useCallback(() => {
    composeAbortRef.current?.abort();
    composeAbortRef.current = null;
    setComposeDraft(null);
    setComposeRawPreview('');
    setComposeState('idle');
    setComposeError('Compose request cancelled.');
    stopComposeSpeechRecognition();
    lastComposeAudioRef.current = null;
    setComposeReplayReady(false);
    composeTranscriptFinalRef.current = '';
    composeTranscriptInterimRef.current = '';
    setComposeTranscript('');
    setComposeTranscriptInterim('');
  }, [stopComposeSpeechRecognition]);

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

  const handleComposeReplay = useCallback(async () => {
    if (composeState !== 'idle') {
      setComposeError('Wait for the current compose to finish.');
      return;
    }
    setComposeError(null);
    try {
      const transcript = composeTranscript.trim();
      const lastAudio = lastComposeAudioRef.current;
      if (transcript && !lastAudio) {
        await runComposeFromText(transcript);
        return;
      }

      if (!lastAudio) {
        setComposeError('Record audio first or type instructions above.');
        return;
      }

      await runCompose(lastAudio.slice(0));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Compose failed.';
      setComposeError(message);
      setComposeState('idle');
    }
  }, [composeState, composeTranscript, runCompose, runComposeFromText]);

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
      } satisfies EchoMessage)
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
      ?.sendMessage({ type: 'ekko/direct-insert/query' } satisfies EchoMessage)
      .then((response: EchoResponse | undefined) => {
        if (cancelled || !response || !response.ok || !response.data) {
          return;
        }
        const enabled = !!(response.data as { enabled?: boolean }).enabled;
        setDirectInsertEnabled(enabled);
      })
      .catch(() => {
        /* ignore: we will rely on initialized event */
      });

    const handleInitMessage = (message: EchoMessage) => {
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
      const availability = await getRewriterAvailability(outputLanguage);
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
    if (mode !== 'compose') {
      stopComposeSpeechRecognition();
      composeTranscriptFinalRef.current = '';
      composeTranscriptInterimRef.current = '';
      setComposeTranscript('');
      setComposeTranscriptInterim('');
    }
  }, [mode, stopComposeSpeechRecognition]);

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
        } satisfies EchoMessage)
        .then((response: EchoResponse | undefined) => {
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
    if (!directInsertEnabled) {
      structuredInsertAbortRef.current?.abort();
      structuredInsertAbortRef.current = null;
      lastStructuredTranscriptRef.current = '';
      return;
    }

    const trimmed = activeTranscript.trim();
    if (!trimmed) {
      structuredInsertAbortRef.current?.abort();
      structuredInsertAbortRef.current = null;
      lastStructuredTranscriptRef.current = '';
      return;
    }

    if (isRecording) {
      return;
    }

    if (trimmed === lastStructuredTranscriptRef.current) {
      return;
    }

    const controller = new AbortController();
    structuredInsertAbortRef.current?.abort();
    structuredInsertAbortRef.current = controller;
    let cancelled = false;

    (async () => {
      try {
        await insertTranscriptIntoPage(trimmed, { signal: controller.signal });
        if (cancelled) {
          return;
        }
        lastStructuredTranscriptRef.current = trimmed;
        lastDirectInsertValueRef.current = trimmed;
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.warn('Unable to insert structured transcript draft', error);
      } finally {
        if (structuredInsertAbortRef.current === controller) {
          structuredInsertAbortRef.current = null;
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTranscript, directInsertEnabled, insertTranscriptIntoPage, isRecording]);

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
      stopComposeSpeechRecognition();
    };
  }, [stopComposeSpeechRecognition]);

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
            <span className="brand__title">Echo: Write with Voice</span>
            <span className="brand__subtitle">Capture or compose with on-device AI.</span>
          </div>
          <span className="pill pill--muted">Chrome {chromeVersion}</span>
        </div>
        <div className="mode-switch" role="tablist" aria-label="Echo modes">
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
          <section className="panel-section panel-section--capture" aria-labelledby="capture-section-title">
            <div className="record-controls">
              <div className="record-controls__main">
                <button
                  type="button"
                  className={`record-button ${isRecording ? 'record-button--active' : ''}`}
                  onClick={handleToggleRecording}
                  disabled={transcribeRecordDisabled}
                  aria-label={isRecording ? 'Stop recording' : 'Start recording'}
                  title={transcribeRecordTitle}
                >
                  <span className={`record-button__icon record-button__icon--${transcribeMicState}`}>
                    <MicIcon state={transcribeMicState} />
                  </span>
                  <span className="sr-only" aria-live="polite">
                    {transcribeStatusText}
                  </span>
                </button>
                <button
                  type="button"
                  className="record-restart-button"
                  onClick={handleRestartTranscribe}
                  disabled={transcribeRestartDisabled}
                  aria-label={isRecording ? 'Restart recording' : 'Start new recording'}
                  title={transcribeRestartTitle}
                >
                  <FiRotateCcw size={18} aria-hidden="true" focusable="false" />
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
            {shouldRenderMicMessages && (
              <div className="record-controls__messages" aria-live="polite">
                {micMessages}
                {showMicSettingsButton && (
                  <button type="button" className="text-button" onClick={openMicrophoneSettings}>
                    Open Chrome microphone settings
                  </button>
                )}
              </div>
            )}
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

          <section className="panel-section panel-section--transcript" aria-labelledby="transcript-title">
            <h2 id="transcript-title" className="section-title">
              Live Transcript
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
                {isSummarizerBusy ? (
                  'Refining…'
                ) : (
                  <>
                    <HiSparkles size={16} aria-hidden="true" focusable="false" />
                    Refine
                  </>
                )}
              </button>
              <div className="actions-toolbar__group">
                <select
                  className="select select--compact"
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
                  {isRewriterBusy ? (
                    'Polishing…'
                  ) : (
                    <>
                      <FaWandMagicSparkles size={16} aria-hidden="true" focusable="false" />
                      Polish
                    </>
                  )}
                </button>
              </div>
              <button type="button" className="button" disabled={!activeTranscript} onClick={handleCopy}>
                Copy
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={
                  !activeTranscript ||
                  isRecording ||
                  insertBusy ||
                  isSummarizerBusy ||
                  isRewriterBusy
                }
                onClick={handleInsertTranscript}
                title={
                  !activeTranscript
                    ? 'Speak or type a transcript first'
                    : isRecording
                    ? 'Stop recording to insert'
                    : insertBusy
                    ? 'Insert in progress…'
                    : isSummarizerBusy || isRewriterBusy
                    ? 'Wait for the current action to finish'
                    : !directInsertEnabled
                    ? 'Insert will temporarily enable Direct Insert Mode'
                    : 'Insert transcript into page'
                }
              >
                {insertBusy ? 'Inserting…' : 'Insert'}
              </button>
            </div>
            <div className="summary-status" aria-live="polite">
              {summarizerMessage && <p className="helper-text">{summarizerMessage}</p>}
              {summarizerError && <p className="helper-text danger">{summarizerError}</p>}
            </div>
            <div className="rewrite-status" aria-live="polite">
              {rewriterMessage && <p className="helper-text">{rewriterMessage}</p>}
              {rewriterError && <p className="helper-text danger">{rewriterError}</p>}
            </div>
            {showPreviewCard && (
              <div className={previewCardClassName}>
                <strong className="summary-preview__title">Preview</strong>
                <p className="summary-preview__body">{previewTextDisplay}</p>
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
              Speak naturally and instruct what you want to write. Gemini Nano will listen and draft the content for you.
            </p>
            <div className="compose-controls">
              <button
                type="button"
                className={`record-button ${isComposeRecording ? 'record-button--active' : ''}`}
                onClick={isComposeRecording ? () => handleStopComposeRecording(false) : handleStartComposeRecording}
                disabled={composeRecordDisabled}
                aria-label={isComposeRecording ? 'Stop capture' : 'Start capture'}
                title={composeRecordTitle}
              >
                <span className={`record-button__icon record-button__icon--${composeMicState}`}>
                  <MicIcon state={composeMicState} />
                </span>
                <span className="sr-only" aria-live="polite">
                  {composeStatusText}
                </span>
              </button>
              <button
                type="button"
                className="record-restart-button"
                onClick={handleRestartComposeRecording}
                disabled={composeRestartDisabled}
                aria-label={isComposeRecording ? 'Restart capture' : 'Start new capture'}
                title={composeRestartTitle}
              >
                <FiRotateCcw size={18} aria-hidden="true" focusable="false" />
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
            <div className="compose-transcript-preview">
              <label htmlFor="compose-live-transcript" className="helper-text compose-transcript-preview__label">
                Live transcript
              </label>
              <textarea
                id="compose-live-transcript"
                className="transcript-area transcript-area--readonly"
                onChange={(event) => {
                  setComposeTranscript(event.target.value);
                  composeTranscriptFinalRef.current = event.target.value;
                }}
                placeholder="Your transcript will appear here."
                value={composeTranscriptDisplay}
              />
            </div>
            <div className="compose-style">
              <label htmlFor="compose-style-select" className="helper-text compose-style__label">
                Style
              </label>
              <select
                id="compose-style-select"
                className="select compose-style__select"
                value={composePreset}
                onChange={(event) => setComposePreset(event.target.value as ComposePresetId)}
              >
                {composePresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
            <label htmlFor="compose-instruction" className="helper-text" style={{ fontWeight: 600 }}>
              Optional typed context
            </label>
            <textarea
              id="compose-instruction"
              className="transcript-area transcript-area--hint-small"
              style={{ minHeight: '80px' }}
              placeholder="Add details Gemini should know (recipient, tone, bullet points)…"
              value={composePrompt}
              onChange={(event) => {
                const value = event.target.value;
                setSettings((prev) => ({ ...prev, composePrompt: value }));
                if (composePromptDebounceRef.current) {
                  window.clearTimeout(composePromptDebounceRef.current);
                }
                const trimmed = value.trim();
                if (trimmed.length === 0) {
                  composePromptDebounceRef.current = null;
                  applySettings({ composePrompt: '' });
                } else {
                  composePromptDebounceRef.current = window.setTimeout(() => {
                    applySettings({ composePrompt: value });
                  }, 400);
                }
              }}
              onBlur={() => {
                if (composePromptDebounceRef.current) {
                  window.clearTimeout(composePromptDebounceRef.current);
                  composePromptDebounceRef.current = null;
                }
                applySettings({ composePrompt: composePrompt.trim() });
              }}
            />
            <div className="compose-replay">
              <button
                type="button"
                className="button compose-replay__button"
                onClick={handleComposeReplay}
                disabled={composeReplayDisabled}
                title={composeReplayTitle}
                aria-label="Compose from last recording"
              >
                <FiPenTool size={16} aria-hidden="true" focusable="false" />
                Compose
              </button>
            </div>
            <div className="compose-status" aria-live="polite">
              {promptAvailabilityState === 'downloadable' && (
                <p className="helper-text">Chrome is downloading the on-device model. Keep this tab open.</p>
              )}
              {promptAvailabilityMessage && <p className="helper-text">{promptAvailabilityMessage}</p>}
              {composeError && <p className="helper-text danger compose-status__error">{composeError}</p>}
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
                </div>
                {entry.summary && (
                  <div className="history-item__section">
                    <span className="history-item__section-label">Summary</span>
                    <div className="history-item__section-content">{entry.summary}</div>
                  </div>
                )}
                {entry.rewrite && (
                  <div className="history-item__section">
                    <span className="history-item__section-label">Rewrite</span>
                    <div className="history-item__section-content">{entry.rewrite}</div>
                  </div>
                )}
                {entry.compose && (
                  <div className="history-item__section">
                    <span className="history-item__section-label">
                      Compose • {entry.compose.presetLabel}
                    </span>
                    <div className="history-item__section-content">
                      {entry.compose.paragraphs && entry.compose.paragraphs.length > 0
                        ? joinParagraphs(entry.compose.paragraphs)
                        : entry.compose.output}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
