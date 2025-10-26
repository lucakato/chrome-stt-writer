import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IconType } from 'react-icons';
import { MdKeyboardVoice } from 'react-icons/md';
import { RiVoiceprintFill } from 'react-icons/ri';
import { IoSettingsSharp } from 'react-icons/io5';
import { FiCopy, FiCornerDownRight } from 'react-icons/fi';
import type { EkkoMessage, EkkoResponse } from '@shared/messages';
import {
  getEkkoSettings,
  observeEkkoSettings,
  setEkkoSettings,
  DEFAULT_SETTINGS,
  type EkkoSettings,
  type EkkoMode,
  type EkkoSettingsChange
} from '@shared/settings';
import { composeFromAudio, composeFromText, TRANSCRIBE_STRUCTURED_SYSTEM_PROMPT } from '@shared/ai/prompt';
import { rewriteText } from '@shared/ai/rewriter';
import {
  ComposeDraftResult,
  coerceComposeDraft,
  composeDraftToClipboardText,
  createFallbackDraft,
  deriveParagraphs,
  joinParagraphs,
  normalizeComposeDraftResult
} from '@shared/compose';

const WIDGET_DEFAULT_COMPOSE_PROMPT =
  'You are Ekko, an on-device assistant. Listen carefully and give a direct, helpful answer that the user can use immediately. Reply in the user’s language, stay concise, and do not add meta commentary or extra instructions.';

function iconMarkup(icon: IconType): string {
  return renderToStaticMarkup(
    createElement(icon, {
      'aria-hidden': true,
      focusable: 'false',
      size: 18
    })
  );
}

const ICON_MIC_IDLE = iconMarkup(MdKeyboardVoice);
const ICON_MIC_RECORDING = iconMarkup(RiVoiceprintFill);
const ICON_SETTINGS = iconMarkup(IoSettingsSharp);
const ICON_COPY = iconMarkup(FiCopy);
const ICON_INSERT = iconMarkup(FiCornerDownRight);
const ICON_MIC_PROCESSING = '<span aria-hidden="true">⏳</span>';
const WIDGET_COMPOSE_MAX_DURATION_MS = 90_000;
const TEMP_DIRECT_INSERT_DELAY_MS = 150;

type WidgetRewritePreset =
  | 'concise-formal'
  | 'expand'
  | 'casual'
  | 'bullet'
  | 'action-items'
  | 'custom';

type WidgetRewriteConfig = {
  sharedContext?: string;
  context?: string;
  tone?: string;
  format?: string;
  length?: string;
};

const WIDGET_BASE_SHARED_CONTEXT =
  'You are an AI assistant who is an expert writer. Rewrite the user\'s speech-to-text transcript from the user\'s perspective, improving clarity, grammar, and tone while preserving their intent.';

const WIDGET_REWRITE_OPTIONS: Array<{
  id: WidgetRewritePreset;
  label: string;
  config: WidgetRewriteConfig;
}> = [
  {
    id: 'concise-formal',
    label: 'Concise • Formal',
    config: {
      sharedContext: WIDGET_BASE_SHARED_CONTEXT,
      context: 'Rewrite the text to be concise, professional, and suitable for business communication.',
      tone: 'more-formal',
      length: 'shorter',
      format: 'plain-text'
    }
  },
  {
    id: 'expand',
    label: 'Expand',
    config: {
      sharedContext: WIDGET_BASE_SHARED_CONTEXT,
      context: 'Expand the text with helpful details while keeping the original intent clear.',
      length: 'longer',
      format: 'plain-text'
    }
  },
  {
    id: 'casual',
    label: 'Casual',
    config: {
      sharedContext: WIDGET_BASE_SHARED_CONTEXT,
      context: 'Rewrite the text with a relaxed, friendly tone while keeping all key information.',
      tone: 'more-casual',
      format: 'plain-text'
    }
  },
  {
    id: 'bullet',
    label: 'Bullet list',
    config: {
      sharedContext: WIDGET_BASE_SHARED_CONTEXT,
      context: 'Rewrite the text as a concise bullet list highlighting the key points.',
      format: 'bullet'
    }
  },
  {
    id: 'action-items',
    label: 'Action items',
    config: {
      sharedContext: WIDGET_BASE_SHARED_CONTEXT,
      context: 'Rewrite the text as a list of clear action items with imperative verbs and owners where possible.',
      format: 'plain-text',
      tone: 'more-direct'
    }
  },
  {
    id: 'custom',
    label: 'Custom instructions',
    config: {
      sharedContext: WIDGET_BASE_SHARED_CONTEXT,
      context: 'Rewrite the text to improve clarity, flow, and readability while preserving the author’s intent.',
      format: 'plain-text'
    }
  }
];

function resolveOutputLanguage(): string {
  const browserLang = typeof navigator !== 'undefined' ? navigator.language : 'en';
  const baseLang = browserLang?.split('-')[0]?.toLowerCase() ?? 'en';
  const supportedLanguages = ['en', 'es', 'ja'];
  return supportedLanguages.includes(baseLang) ? baseLang : 'en';
}

const WIDGET_REFINE_SHARED_CONTEXT =
  'Refine the user’s dictated message for clarity while preserving intent.';
const WIDGET_REFINE_CONTEXT =
  'Polish the text by fixing grammar mistakes, removing redundant or filler wording, and keeping the tone natural.';

type RecordingState = 'idle' | 'recording' | 'processing';

declare global {
  interface Window {
    __ekkoWidgetInjected__?: boolean;
  }
}

if (window.top !== window.self) {
  // Only render the floating widget in the top-level document.
} else if (!window.__ekkoWidgetInjected__) {
  window.__ekkoWidgetInjected__ = true;

  let settings: EkkoSettings = DEFAULT_SETTINGS;
  let recorderState: RecordingState = 'idle';
  let recognition: SpeechRecognition | null = null;
  let recognitionTimer: number | null = null;
  let transcribeFinal = '';
  let transcribeInterim = '';
  let mediaRecorder: MediaRecorder | null = null;
  let mediaStream: MediaStream | null = null;
  let mediaChunks: Blob[] = [];
  let composeTimer: number | null = null;
  let composeStart: number | null = null;
  let composeLimitTimer: number | null = null;
  let popupOpen = false;
  let lastComposeAudio: ArrayBuffer | null = null;
  let hasComposeRecording = false;
  let transcribeOutputCard: HTMLDivElement | null = null;
  let transcribeOutputScroll: HTMLDivElement | null = null;
  let transcribeOutputPlaceholder: HTMLParagraphElement | null = null;
  let transcribeOutputText: HTMLParagraphElement | null = null;
  let transcribeOutputValue = '';
  let lastLoggedWidgetTranscript = '';
  let composeOutputCard: HTMLDivElement | null = null;
  let composeOutputScroll: HTMLDivElement | null = null;
  let composeOutputPlaceholder: HTMLParagraphElement | null = null;
  let composeOutputSubject: HTMLParagraphElement | null = null;
  let composeOutputText: HTMLParagraphElement | null = null;
  let composeOutputValue: ComposeDraftResult | null = null;
  let composeOutputMessage: string | null = null;
  let transcribeActionsRow: HTMLDivElement | null = null;
  let refineButton: HTMLButtonElement | null = null;
  let polishButton: HTMLButtonElement | null = null;
  let copyButton: HTMLButtonElement | null = null;
  let rewriteSelect: HTMLSelectElement | null = null;
  let insertButton: HTMLButtonElement | null = null;
  let refineBusy = false;
  let rewriterBusy = false;
  let rewritePreset: WidgetRewritePreset = 'concise-formal';
  let transcribeOutputKind: 'raw' | 'refine' | 'polish' | 'other' = 'raw';
  let insertBusy = false;

  let root: HTMLDivElement | null = null;
  let triggerButton: HTMLButtonElement | null = null;
  let popup: HTMLDivElement | null = null;
  let micButton: HTMLButtonElement | null = null;
  let settingsButton: HTMLButtonElement | null = null;
  let regenerateButton: HTMLButtonElement | null = null;
  let promptTextarea: HTMLTextAreaElement | null = null;
  let statusLabel: HTMLSpanElement | null = null;
  let timerLabel: HTMLSpanElement | null = null;
  let modeButtons: { transcribe: HTMLButtonElement; compose: HTMLButtonElement } | null = null;
  let directInsertEnabled = false;
  let tempDirectInsertDepth = 0;

  function ensureStyle() {
    if (document.getElementById('ekko-floating-widget-style')) return;
    const style = document.createElement('style');
    style.id = 'ekko-floating-widget-style';
    style.textContent = `
      #ekko-floating-widget-root {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 2147483647;
        font-family: 'Inter', system-ui, sans-serif;
      }
      #ekko-floating-widget-trigger {
        width: 48px;
        height: 48px;
        border-radius: 24px;
        border: none;
        background: #5968f2;
        color: #ffffff;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: 0 12px 28px rgba(89, 104, 242, 0.35);
      }
      #ekko-floating-widget-trigger:hover {
        transform: translateY(-1px);
      }
      .ekko-popup {
        position: absolute;
        bottom: 60px;
        right: 0;
        width: 260px;
        border-radius: 16px;
        background: #ffffff;
        border: 1px solid rgba(89, 104, 242, 0.2);
        box-shadow: 0 18px 40px rgba(21, 26, 90, 0.25);
        display: none;
        flex-direction: column;
        gap: 12px;
        padding: 16px;
      }
      .ekko-popup--open {
        display: flex;
      }
      .ekko-popup__header {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .ekko-popup__title {
        font-size: 0.95rem;
        font-weight: 600;
        color: #1f1f3d;
      }
      .ekko-popup__close {
        border: none;
        background: transparent;
        font-size: 1rem;
        color: #4c4c70;
        cursor: pointer;
      }
      .ekko-popup__modes {
        display: inline-flex;
        background: rgba(89, 104, 242, 0.1);
        border-radius: 999px;
        padding: 2px;
        gap: 4px;
      }
      .ekko-popup__mode {
        border: none;
        background: transparent;
        color: #4c4c70;
        font-weight: 600;
        border-radius: 999px;
        padding: 6px 14px;
        cursor: pointer;
      }
      .ekko-popup__mode--active {
        background: #5968f2;
        color: #ffffff;
      }
      .ekko-popup__prompt {
        border-radius: 12px;
        border: 1px solid rgba(89, 104, 242, 0.2);
        padding: 8px;
        font-size: 0.85rem;
        resize: vertical;
        min-height: 72px;
        color: #1f1f3d;
        width: 100%;
        box-sizing: border-box;
        margin-top: 10px;
      }
      .ekko-controls {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-top: 10px;
      }
      .ekko-popup__footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
      }
      .ekko-popup__status,
      .ekko-popup__timer {
        font-size: 0.75rem;
        color: #4c4c70;
      }
      .ekko-icon-button {
        width: 36px;
        height: 36px;
        border-radius: 18px;
        border: none;
        background: rgba(89, 104, 242, 0.12);
        color: #5968f2;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: color 0.2s ease, background 0.2s ease;
      }
      .ekko-icon-button--active {
        background: #5968f2;
        color: #ffffff;
      }
      .ekko-output {
        display: none;
        flex-direction: column;
        gap: 6px;
        border-radius: 12px;
        border: 1px solid rgba(89, 104, 242, 0.2);
        background: rgba(89, 104, 242, 0.08);
        padding: 10px;
        max-height: 180px;
        margin-top: 10px;
        overflow: hidden;
        width: 100%;
        box-sizing: border-box;
      }
      .ekko-output__scroll {
        overflow-y: auto;
        max-height: 140px;
        padding-right: 4px;
        width: 100%;
        box-sizing: border-box;
      }
      .ekko-output__subject {
        margin: 0 0 6px;
        font-weight: 600;
        color: #404072;
        font-size: 0.8rem;
      }
      .ekko-output__text {
        margin: 0;
        font-size: 0.82rem;
        line-height: 1.4;
        color: #1f1f3d;
        white-space: pre-wrap;
      }
      .ekko-output__placeholder {
        margin: 0;
        font-size: 0.78rem;
        color: #4c4c70;
        font-style: italic;
      }
      .ekko-icon-button--recording svg {
        animation: ekko-record-blink 1s ease-in-out infinite;
      }
      @keyframes ekko-record-blink {
        0%, 100% {
          opacity: 1;
        }
        50% {
          opacity: 0.4;
        }
      }
      .ekko-popup__regen {
        border: none;
        background: #5968f2;
        color: #ffffff;
        border-radius: 10px;
        padding: 8px 12px;
        font-weight: 600;
        cursor: pointer;
        margin-left: auto;
      }
      .ekko-transcribe-actions {
        display: none;
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
        margin-top: 8px;
      }
      .ekko-transcribe-actions__row {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .ekko-transcribe-actions__button {
        border: none;
        background: #5968f2;
        color: #ffffff;
        border-radius: 10px;
        padding: 6px 12px;
        font-weight: 600;
        cursor: pointer;
        font-size: 0.82rem;
        transition: background 0.2s ease;
      }
      .ekko-transcribe-actions__button:disabled {
        cursor: not-allowed;
        background: rgba(89, 104, 242, 0.4);
      }
      .ekko-transcribe-actions__select {
        border-radius: 8px;
        border: 1px solid rgba(89, 104, 242, 0.3);
        padding: 4px 8px;
        font-size: 0.82rem;
        color: #1f1f3d;
        background: #ffffff;
      }
      .ekko-transcribe-actions__copy {
        width: 32px;
        height: 32px;
        border-radius: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid rgba(89, 104, 242, 0.25);
        background: rgba(89, 104, 242, 0.1);
        color: #5968f2;
        cursor: pointer;
      }
      .ekko-transcribe-actions__copy:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }
      .ekko-transcribe-actions__insert {
        width: 32px;
        height: 32px;
        border-radius: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid rgba(89, 104, 242, 0.4);
        background: #5968f2;
        color: #ffffff;
        cursor: pointer;
      }
      .ekko-transcribe-actions__insert:disabled {
        cursor: not-allowed;
        opacity: 0.5;
        background: rgba(89, 104, 242, 0.5);
      }
    `;
    document.head.appendChild(style);
  }

  function createRoot() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'ekko-floating-widget-root';
    document.body.appendChild(root);
  }

  function setDirectInsertState(enabled: boolean) {
    directInsertEnabled = !!enabled;
    updateActionButtonStates();
  }

  let pendingBridgeMessage: { type: 'toggle' | 'initialized'; enabled: boolean } | null = null;
  let pendingBridgeNeedsRefresh = false;

  function applyPendingBridgeMessage() {
    if (tempDirectInsertDepth === 0) {
      if (pendingBridgeNeedsRefresh) {
        pendingBridgeNeedsRefresh = false;
        queryDirectInsertState();
        pendingBridgeMessage = null;
        return;
      }
      if (pendingBridgeMessage) {
        setDirectInsertState(pendingBridgeMessage.enabled);
        pendingBridgeMessage = null;
      }
    }
  }

  function handleDirectInsertToggleMessage(message: EkkoMessage) {
    if (message.type === 'ekko/direct-insert/toggle') {
      const enabled = !!(message.payload as { enabled?: boolean }).enabled;
      if (tempDirectInsertDepth === 0) {
        setDirectInsertState(enabled);
      } else {
        pendingBridgeMessage = { type: 'toggle', enabled };
      }
    } else if (message.type === 'ekko/direct-insert/initialized') {
      const enabled = !!(message.payload as { enabled?: boolean }).enabled;
      if (tempDirectInsertDepth === 0) {
        setDirectInsertState(enabled);
      } else {
        pendingBridgeMessage = { type: 'initialized', enabled };
      }
    }
  }

  async function queryDirectInsertState() {
    try {
      const response = (await chrome.runtime.sendMessage({ type: 'ekko/direct-insert/query' } satisfies EkkoMessage)) as EkkoResponse | undefined;
      if (response && response.ok && response.data && typeof response.data === 'object') {
        const enabled = !!(response.data as { enabled?: boolean }).enabled;
        setDirectInsertState(enabled);
      }
    } catch {
      /* ignore */
    }
  }

  async function composeWidgetAudio(audioBuffer: ArrayBuffer): Promise<ComposeDraftResult> {
    const instruction = settings.composePrompt.trim();
    console.info('[Ekko] widget instruction:', instruction);
  const outputLanguage = resolveOutputLanguage();
    let lastDraft: ComposeDraftResult | null = null;
    const systemPrompt = instruction
      ? `${WIDGET_DEFAULT_COMPOSE_PROMPT}\n\nFollow these additional instructions exactly:\n${instruction}`
      : WIDGET_DEFAULT_COMPOSE_PROMPT;

    const draft = await composeFromAudio({
      audio: audioBuffer,
      systemPrompt,
      instruction: instruction ? instruction : undefined,
      outputLanguage,
      onChunk: (chunk) => {
        const parsed = coerceComposeDraft(chunk);
        if (parsed) {
          lastDraft = parsed;
          setComposeOutput(parsed);
          if (parsed.content) {
            setStatus(parsed.content);
          }
        }
      }
    });

    const normalized = normalizeComposeDraftResult(draft);

    if (!normalized.content && lastDraft) {
      return normalizeComposeDraftResult(lastDraft);
    }

    return normalized;
  }

  async function insertComposeDraft(draft: ComposeDraftResult) {
    const response = await chrome.runtime
      .sendMessage({
        type: 'ekko/widget/insert',
        payload: {
          draft: {
            content: draft.content,
            subject: draft.subject,
            paragraphs: draft.paragraphs
          }
        }
      } satisfies EkkoMessage)
      .catch((error) => {
        console.warn('Unable to insert compose output', error);
        throw error;
      });

    if (response && typeof response === 'object' && 'ok' in response && !(response as { ok?: boolean }).ok) {
      const message = typeof response === 'object' && response && 'error' in response ? (response as { error?: string }).error : null;
      throw new Error(message || 'Unable to insert compose output.');
    }
  }

  type InsertTranscriptOptions = {
    skipStructuring?: boolean;
    forceStructure?: boolean;
  };

  async function insertTranscriptText(text: string, options: InsertTranscriptOptions = {}) {
    const trimmed = text.trim();
    let payload:
      | {
          draft: {
            content: string;
            subject?: string;
            paragraphs?: string[];
          };
        }
      | { text: string }
      | null = null;

    const shouldStructure =
      trimmed && !options.skipStructuring && (directInsertEnabled || options.forceStructure);

    if (shouldStructure) {
      setStatus('Preparing email draft…');
      const draft = await composeTranscriptDraft(trimmed);
      if (draft) {
        payload = {
          draft: {
            content: draft.content,
            subject: draft.subject,
            paragraphs: draft.paragraphs
          }
        };
      }
    }

    if (!payload) {
      payload = { text };
    }

    const response = await chrome.runtime
      .sendMessage({
        type: 'ekko/direct-insert/apply',
        payload
      } satisfies EkkoMessage)
      .catch((error) => {
        console.warn('Unable to insert transcript output', error);
        throw error;
      });

    if (response && typeof response === 'object' && 'ok' in response && !(response as { ok?: boolean }).ok) {
      const message = typeof response === 'object' && response && 'error' in response ? (response as { error?: string }).error : null;
      throw new Error(message || 'Unable to insert transcript output.');
    }
  }

  async function handleInsertTranscript() {
    const text = transcribeOutputValue.trim();
    if (!text) {
      setStatus('Nothing to insert yet.');
      return;
    }

    const skipStructuring = transcribeOutputKind !== 'raw';

    if (insertBusy) {
      return;
    }

    insertBusy = true;
    updateActionButtonStates();

    try {
      setStatus(
        directInsertEnabled ? 'Inserting into page…' : 'Temporarily enabling Direct Insert Mode…'
      );
      await runWithDirectInsertBridge(() =>
        insertTranscriptText(
          text,
          skipStructuring ? { skipStructuring: true } : { forceStructure: true }
        )
      );
      setStatus('Draft inserted into page.');
    } catch (error) {
      console.warn('Unable to insert transcript output', error);
      const copied = await copyToClipboard(text);
      if (copied) {
        setStatus('Copied to clipboard instead.');
      } else {
        setStatus(error instanceof Error ? error.message : 'Unable to insert transcript.');
      }
    } finally {
      insertBusy = false;
      updateActionButtonStates();
    }
  }

  async function copyToClipboard(text: string): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      console.warn('Unable to copy compose output to clipboard', error);
      return false;
    }
  }

  async function deliverComposeOutput(draft: ComposeDraftResult | null): Promise<boolean> {
    if (!draft || !draft.content.trim()) {
      setComposeOutput(null);
      setComposeOutput('Compose returned no response.');
      setStatus('Compose returned no response.');
      return false;
    }

    setComposeOutput(draft);

    if (!directInsertEnabled) {
      setStatus('');
      return true;
    }

    try {
      await insertComposeDraft(draft);
      setStatus('Draft inserted into page.');
      return true;
    } catch (error) {
      const copied = await copyToClipboard(composeDraftToClipboardText(draft));
      if (copied) {
        setStatus('Output copied to clipboard.');
        return true;
      }
      const message = error instanceof Error ? error.message : 'Compose failed.';
      setComposeOutput(message);
      setStatus(message);
      return false;
    }
  }

  function createTrigger() {
    if (triggerButton) return;
    triggerButton = document.createElement('button');
    triggerButton.id = 'ekko-floating-widget-trigger';
    triggerButton.type = 'button';
    triggerButton.innerHTML = '<span aria-hidden="true">🗨️</span>';
    triggerButton.title = 'Ekko';
    triggerButton.addEventListener('click', () => {
      popupOpen = !popupOpen;
      popup?.classList.toggle('ekko-popup--open', popupOpen);
    });
    root?.appendChild(triggerButton);
  }

  function createPopup() {
    if (popup) return;
    popup = document.createElement('div');
    popup.className = 'ekko-popup';

    const header = document.createElement('div');
    header.className = 'ekko-popup__header';

    const title = document.createElement('span');
    title.className = 'ekko-popup__title';
    title.textContent = 'Ekko';

    const close = document.createElement('button');
    close.className = 'ekko-popup__close';
    close.type = 'button';
    close.textContent = '✕';
    close.addEventListener('click', () => {
      popupOpen = false;
      popup?.classList.remove('ekko-popup--open');
    });

    header.appendChild(title);
    header.appendChild(close);

    const body = document.createElement('div');

    const modeWrapper = document.createElement('div');
    modeWrapper.className = 'ekko-popup__modes';

    const transcribeButton = document.createElement('button');
    transcribeButton.type = 'button';
    transcribeButton.className = 'ekko-popup__mode';
    transcribeButton.textContent = 'Transcribe';
    transcribeButton.addEventListener('click', () => switchMode('transcribe'));

    const composeButton = document.createElement('button');
    composeButton.type = 'button';
    composeButton.className = 'ekko-popup__mode';
    composeButton.textContent = 'Compose';
    composeButton.addEventListener('click', () => switchMode('compose'));

    modeButtons = { transcribe: transcribeButton, compose: composeButton };
    modeWrapper.appendChild(transcribeButton);
    modeWrapper.appendChild(composeButton);

    const controlsRow = document.createElement('div');
    controlsRow.className = 'ekko-controls';

    transcribeOutputCard = document.createElement('div');
    transcribeOutputCard.className = 'ekko-output';
    transcribeOutputScroll = document.createElement('div');
    transcribeOutputScroll.className = 'ekko-output__scroll';
    transcribeOutputScroll.style.display = 'none';
    transcribeOutputText = document.createElement('p');
    transcribeOutputText.className = 'ekko-output__text';
    transcribeOutputScroll.appendChild(transcribeOutputText);
    transcribeOutputPlaceholder = document.createElement('p');
    transcribeOutputPlaceholder.className = 'ekko-output__placeholder';
    transcribeOutputPlaceholder.textContent = 'Your transcript will appear here.';
    transcribeOutputCard.appendChild(transcribeOutputScroll);
    transcribeOutputCard.appendChild(transcribeOutputPlaceholder);

    promptTextarea = document.createElement('textarea');
    promptTextarea.className = 'ekko-popup__prompt';
    promptTextarea.placeholder = 'Not what you want? Assist the AI.';
    promptTextarea.addEventListener('input', (event) => {
      const value = (event.target as HTMLTextAreaElement).value;
      settings = { ...settings, composePrompt: value };
      setEkkoSettings({ composePrompt: value }).catch((error) =>
        console.warn('Unable to update prompt', error)
      );
    });

    composeOutputCard = document.createElement('div');
    composeOutputCard.className = 'ekko-output';

    composeOutputScroll = document.createElement('div');
    composeOutputScroll.className = 'ekko-output__scroll';
    composeOutputScroll.style.display = 'none';

    composeOutputSubject = document.createElement('p');
    composeOutputSubject.className = 'ekko-output__subject';
    composeOutputSubject.style.display = 'none';
    composeOutputScroll.appendChild(composeOutputSubject);

    composeOutputText = document.createElement('p');
    composeOutputText.className = 'ekko-output__text';
    composeOutputScroll.appendChild(composeOutputText);

    composeOutputPlaceholder = document.createElement('p');
    composeOutputPlaceholder.className = 'ekko-output__placeholder';
    composeOutputPlaceholder.textContent = 'After you record, your AI draft will appear here.';

    composeOutputCard.appendChild(composeOutputScroll);
    composeOutputCard.appendChild(composeOutputPlaceholder);

    const footer = document.createElement('div');
    footer.className = 'ekko-popup__footer';

    statusLabel = document.createElement('span');
    statusLabel.className = 'ekko-popup__status';

    timerLabel = document.createElement('span');
    timerLabel.className = 'ekko-popup__timer';

    micButton = document.createElement('button');
    micButton.className = 'ekko-icon-button';
    micButton.type = 'button';
    micButton.title = 'Start recording';
    micButton.innerHTML = ICON_MIC_IDLE;
    micButton.addEventListener('click', handleMicClick);

    settingsButton = document.createElement('button');
    settingsButton.className = 'ekko-icon-button';
    settingsButton.type = 'button';
    settingsButton.title = 'Open settings';
    settingsButton.innerHTML = ICON_SETTINGS;
    settingsButton.addEventListener('click', async () => {
      setStatus('Opening settings…');
      try {
        const payloadWindowId =
          typeof chrome !== 'undefined' && chrome.windows
            ? await chrome.windows
                .getCurrent()
                .then((win) => win?.id)
                .catch(() => undefined)
            : undefined;

        const response = await chrome.runtime.sendMessage<EkkoMessage, EkkoResponse>({
          type: 'ekko/sidepanel/open',
          payload: { action: 'toggle', windowId: payloadWindowId ?? undefined }
        });
        if (!response || typeof response !== 'object' || !('ok' in response) || !response.ok) {
          const message =
            response && typeof response === 'object' && 'error' in response
              ? String(response.error || 'Unable to open settings.')
              : 'Unable to open settings.';
          throw new Error(message);
        }
        const nextState =
          response &&
          typeof response === 'object' &&
          'data' in response &&
          response.data &&
          typeof response.data === 'object' &&
          'state' in response.data
            ? ((response.data as { state?: string }).state ?? 'opened')
            : 'opened';
        if (nextState === 'closed') {
          setStatus('Settings hidden.');
        } else {
          setStatus('Settings opened in side panel.');
        }
      } catch (error) {
        console.warn('Unable to open Ekko side panel from widget', error);
        setStatus('Unable to open settings.');
      }
    });

    controlsRow.appendChild(micButton);
    controlsRow.appendChild(settingsButton);

    transcribeActionsRow = document.createElement('div');
    transcribeActionsRow.className = 'ekko-transcribe-actions';

    refineButton = document.createElement('button');
    refineButton.type = 'button';
    refineButton.className = 'ekko-transcribe-actions__button';
    refineButton.textContent = 'Refine';
    refineButton.addEventListener('click', handleRefineClick);

    rewriteSelect = document.createElement('select');
    rewriteSelect.className = 'ekko-transcribe-actions__select';
    WIDGET_REWRITE_OPTIONS.forEach((option) => {
      const opt = document.createElement('option');
      opt.value = option.id;
      opt.textContent = option.label;
      rewriteSelect?.appendChild(opt);
    });
    rewriteSelect.value = rewritePreset;
    rewriteSelect.addEventListener('change', (event) => {
      rewritePreset = (event.target as HTMLSelectElement).value as WidgetRewritePreset;
      updateActionButtonStates();
    });

    polishButton = document.createElement('button');
    polishButton.type = 'button';
    polishButton.className = 'ekko-transcribe-actions__button';
    polishButton.textContent = 'Polish';
    polishButton.addEventListener('click', handlePolishClick);

    copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'ekko-transcribe-actions__copy';
    copyButton.innerHTML = ICON_COPY;
    copyButton.title = 'Copy transcript';
    copyButton.addEventListener('click', handleCopyTranscript);

    insertButton = document.createElement('button');
    insertButton.type = 'button';
    insertButton.className = 'ekko-transcribe-actions__insert';
    insertButton.innerHTML = ICON_INSERT;
    insertButton.title = 'Insert into page';
    insertButton.addEventListener('click', handleInsertTranscript);

    const polishRow = document.createElement('div');
    polishRow.className = 'ekko-transcribe-actions__row';
    polishRow.appendChild(rewriteSelect);
    polishRow.appendChild(polishButton);
    polishRow.appendChild(copyButton);
    polishRow.appendChild(insertButton);

    transcribeActionsRow.appendChild(refineButton);
    transcribeActionsRow.appendChild(polishRow);

    regenerateButton = document.createElement('button');
    regenerateButton.type = 'button';
    regenerateButton.className = 'ekko-popup__regen';
    regenerateButton.textContent = 'Re-generate';
    regenerateButton.addEventListener('click', handleRegenerate);

    footer.appendChild(statusLabel);
    footer.appendChild(regenerateButton);

    body.appendChild(modeWrapper);
    body.appendChild(controlsRow);
    body.appendChild(transcribeOutputCard);
    body.appendChild(transcribeActionsRow);
    body.appendChild(promptTextarea);
    body.appendChild(composeOutputCard);
    body.appendChild(footer);

    popup.appendChild(header);
    popup.appendChild(body);
    root?.appendChild(popup);
    updateTranscribeOutputVisibility();
    updateComposeOutputVisibility();
    updateTranscribeActionsVisibility();
    updateActionButtonStates();
  }

  function updateModeUi() {
    if (!modeButtons) return;
    if (settings.mode === 'transcribe') {
      modeButtons.transcribe.classList.add('ekko-popup__mode--active');
      modeButtons.compose.classList.remove('ekko-popup__mode--active');
    } else {
      modeButtons.compose.classList.add('ekko-popup__mode--active');
      modeButtons.transcribe.classList.remove('ekko-popup__mode--active');
    }
    if (promptTextarea) {
      const visible = settings.mode === 'compose';
      promptTextarea.style.display = visible ? 'block' : 'none';
      if (regenerateButton) {
        regenerateButton.style.display = visible ? 'inline-flex' : 'none';
      }
      if (!document.activeElement || document.activeElement !== promptTextarea) {
        promptTextarea.value = settings.composePrompt;
      }
    }
    updateTranscribeOutputVisibility();
    updateComposeOutputVisibility();
  }

  function updateMicUi() {
    if (!micButton) return;
    if (recorderState === 'recording') {
      micButton.classList.add('ekko-icon-button--active');
      micButton.classList.add('ekko-icon-button--recording');
      micButton.innerHTML = ICON_MIC_RECORDING;
      micButton.title = 'Stop recording';
    } else if (recorderState === 'processing') {
      micButton.classList.add('ekko-icon-button--active');
      micButton.classList.remove('ekko-icon-button--recording');
      micButton.innerHTML = ICON_MIC_PROCESSING;
      micButton.title = 'Processing…';
    } else {
      micButton.classList.remove('ekko-icon-button--active');
      micButton.classList.remove('ekko-icon-button--recording');
      micButton.innerHTML = ICON_MIC_IDLE;
      micButton.title = 'Start recording';
    }
    updateActionButtonStates();
  }

  function setStatus(text: string) {
    if (statusLabel) {
      if (settings.mode === 'compose' || settings.mode === 'transcribe') {
        statusLabel.textContent = '';
      } else {
        statusLabel.textContent = text;
      }
    }
  }

  function delay(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function toggleDirectInsertBridge(
    enabled: boolean,
    { updateUiState = true }: { updateUiState?: boolean } = {}
  ) {
    const runtime = chrome.runtime;
    if (!runtime?.sendMessage) {
      throw new Error('Chrome runtime unavailable for direct insert toggle.');
    }
    const adjustDepth = () => {
      if (!updateUiState) {
        if (enabled) {
          tempDirectInsertDepth += 1;
        } else if (tempDirectInsertDepth > 0) {
          tempDirectInsertDepth -= 1;
        }
      }
    };

    const rollbackDepth = () => {
      if (!updateUiState) {
        if (enabled && tempDirectInsertDepth > 0) {
          tempDirectInsertDepth -= 1;
        } else if (!enabled) {
          tempDirectInsertDepth += 1;
        }
      }
    };

    adjustDepth();
    const response = await runtime
      .sendMessage({
        type: 'ekko/direct-insert/toggle',
        payload: { enabled }
      } satisfies EkkoMessage)
      .catch((error) => {
        console.warn('Unable to toggle direct insert bridge', error);
        rollbackDepth();
        throw error;
      });
    if (
      response &&
      typeof response === 'object' &&
      'ok' in response &&
      !(response as { ok?: boolean }).ok
    ) {
      const message = (response as { error?: string }).error ?? 'Unable to toggle Direct Insert Mode.';
      rollbackDepth();
      throw new Error(message);
    }
    if (updateUiState) {
      setDirectInsertState(enabled);
    }
    if (enabled) {
      await delay(TEMP_DIRECT_INSERT_DELAY_MS);
    }
    if (!enabled) {
      applyPendingBridgeMessage();
    }
  }

  async function runWithDirectInsertBridge<T>(task: () => Promise<T>): Promise<T> {
    if (directInsertEnabled) {
      return task();
    }
    let autoEnabled = false;
    await toggleDirectInsertBridge(true, { updateUiState: false });
    autoEnabled = true;
    try {
      return await task();
    } finally {
      if (autoEnabled) {
        try {
          await toggleDirectInsertBridge(false, { updateUiState: false });
        } catch (error) {
          console.warn('Unable to disable direct insert bridge after temporary use', error);
          pendingBridgeNeedsRefresh = true;
        }
      }
      applyPendingBridgeMessage();
    }
  }

  async function composeTranscriptDraft(text: string): Promise<ComposeDraftResult | null> {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const draft = await composeFromText({
        text: trimmed,
        systemPrompt: TRANSCRIBE_STRUCTURED_SYSTEM_PROMPT,
        outputLanguage: resolveOutputLanguage(),
        onStatusChange: (status) => {
          if (status === 'downloadable') {
            setStatus('Downloading on-device model…');
          } else if (status === 'ready') {
            setStatus('Preparing email draft…');
          }
        }
      });
      return normalizeComposeDraftResult(draft);
    } catch (error) {
      console.warn('Unable to generate structured transcript draft', error);
      return normalizeComposeDraftResult(createFallbackDraft(trimmed));
    }
  }

  function setTimer(elapsedMs: number) {
    if (!timerLabel) return;
    if (!composeStart) {
      timerLabel.textContent = '';
      return;
    }
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    timerLabel.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function updateComposeOutputVisibility() {
    if (!composeOutputCard) return;
    const visible = settings.mode === 'compose';
    composeOutputCard.style.display = visible ? 'flex' : 'none';
    if (!visible) return;
    const draft = composeOutputValue;
    const message = composeOutputMessage?.trim() ?? '';
    const hasDraft = !!draft && draft.content.trim().length > 0;
    const hasMessage = !hasDraft && message.length > 0;
    if (composeOutputScroll) {
      composeOutputScroll.style.display = hasDraft || hasMessage ? 'block' : 'none';
    }
    if (composeOutputPlaceholder) {
      composeOutputPlaceholder.style.display = hasDraft || hasMessage ? 'none' : 'block';
    }
    if (composeOutputSubject) {
      const subject = hasDraft && draft.subject ? draft.subject : '';
      composeOutputSubject.textContent = subject;
      composeOutputSubject.style.display = subject ? 'block' : 'none';
    }
    if (composeOutputText) {
      composeOutputText.textContent = hasDraft ? draft.content : hasMessage ? message : '';
    }
  }

  function setComposeOutput(value: ComposeDraftResult | string | null) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      composeOutputValue = null;
      composeOutputMessage = trimmed || null;
    } else if (value) {
      const normalizedParagraphs =
        value.paragraphs && value.paragraphs.length > 0
          ? value.paragraphs
          : deriveParagraphs(value.content);
      composeOutputValue = {
        raw: value.raw,
        content: joinParagraphs(normalizedParagraphs).trim(),
        subject: value.subject && value.subject.trim().length > 0 ? value.subject.trim() : undefined,
        paragraphs: normalizedParagraphs
      };
      composeOutputMessage = null;
    } else {
      composeOutputValue = null;
      composeOutputMessage = null;
    }
    updateComposeOutputVisibility();
  }

  function updateTranscribeOutputVisibility() {
    if (!transcribeOutputCard) return;
    const visible = settings.mode === 'transcribe';
    transcribeOutputCard.style.display = visible ? 'flex' : 'none';
    if (!visible) return;
    const hasText = transcribeOutputValue.length > 0;
    if (transcribeOutputScroll) {
      transcribeOutputScroll.style.display = hasText ? 'block' : 'none';
    }
    if (transcribeOutputPlaceholder) {
      transcribeOutputPlaceholder.style.display = hasText ? 'none' : 'block';
    }
    if (transcribeOutputText) {
      transcribeOutputText.textContent = transcribeOutputValue;
    }
    updateTranscribeActionsVisibility();
  }

  function setTranscribeOutput(
    text: string | null,
    kind: 'raw' | 'refine' | 'polish' | 'other' = 'other'
  ) {
    transcribeOutputKind = kind;
    transcribeOutputValue = text && text.trim() ? text.trim() : '';
    if (transcribeOutputText) {
      transcribeOutputText.textContent = transcribeOutputValue;
    }
    if (transcribeOutputScroll) {
      transcribeOutputScroll.style.display = transcribeOutputValue ? 'block' : 'none';
    }
    if (transcribeOutputPlaceholder) {
      transcribeOutputPlaceholder.style.display = transcribeOutputValue ? 'none' : 'block';
    }
    updateTranscribeOutputVisibility();
    updateActionButtonStates();
  }

  function updateTranscribeActionsVisibility() {
    if (!transcribeActionsRow) return;
    const visible = settings.mode === 'transcribe';
    transcribeActionsRow.style.display = visible ? 'flex' : 'none';
    if (visible) {
      updateActionButtonStates();
    }
  }

  function updateActionButtonStates() {
    const hasTranscript = !!transcribeOutputValue && recorderState === 'idle';

    if (refineButton) {
      refineButton.disabled = !hasTranscript || refineBusy;
      refineButton.textContent = refineBusy ? 'Refining…' : 'Refine';
    }

    if (polishButton) {
      polishButton.disabled = !hasTranscript || rewriterBusy;
      polishButton.textContent = rewriterBusy ? 'Polishing…' : 'Polish';
    }

    if (rewriteSelect) {
      rewriteSelect.disabled = rewriterBusy;
      rewriteSelect.value = rewritePreset;
    }

    if (copyButton) {
      const canCopy = !!transcribeOutputValue && !refineBusy && !rewriterBusy && recorderState === 'idle';
      copyButton.disabled = !canCopy;
      copyButton.innerHTML = ICON_COPY;
      copyButton.title = copyButton.disabled ? 'Copy transcript (disabled)' : 'Copy transcript';
    }

    if (insertButton) {
      const canInsert =
        !!transcribeOutputValue &&
        recorderState === 'idle' &&
        !refineBusy &&
        !rewriterBusy &&
        !insertBusy;
      insertButton.disabled = !canInsert;
      insertButton.innerHTML = insertBusy ? ICON_MIC_PROCESSING : ICON_INSERT;
      let insertTooltip = 'Insert into page';
      if (!transcribeOutputValue) {
        insertTooltip = 'Speak or type a transcript first';
      } else if (recorderState !== 'idle') {
        insertTooltip = 'Stop recording to insert';
      } else if (refineBusy || rewriterBusy) {
        insertTooltip = 'Wait for the current action to finish';
      } else if (insertBusy) {
        insertTooltip = 'Insert in progress…';
      } else if (!directInsertEnabled) {
        insertTooltip = 'Insert will temporarily enable Direct Insert Mode';
      }
      insertButton.title = insertTooltip;
    }
  }

  function ensureWidget() {
    ensureStyle();
    createRoot();
    createTrigger();
    createPopup();
    if (settings.floatingWidgetEnabled) {
      if (root) root.style.display = '';
    } else if (root) {
      root.style.display = 'none';
      popupOpen = false;
      popup?.classList.remove('ekko-popup--open');
    }
    updateModeUi();
    updateMicUi();
    updateTranscribeOutputVisibility();
    updateTranscribeActionsVisibility();
    updateComposeOutputVisibility();
    setStatus('');
    if (promptTextarea && (!document.activeElement || document.activeElement !== promptTextarea)) {
      promptTextarea.value = settings.composePrompt;
    }
  }

  function switchMode(mode: EkkoMode) {
    if (settings.mode === mode) return;
    settings = { ...settings, mode };
    updateModeUi();
    setEkkoSettings({ mode }).catch((error) => console.warn('Unable to switch mode', error));
    if (recorderState === 'recording') {
      stopRecording();
    }
  }

  async function startTranscribe() {
    setTranscribeOutput('Listening…', 'other');
    const SpeechRecognitionCtor =
      (window as typeof window & { webkitSpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition ||
      (window as typeof window & { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      throw new Error('Web Speech API is not available in this browser.');
    }

    recognition?.stop();
    recognition = new SpeechRecognitionCtor();
    recognition.lang = navigator.language ?? 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    transcribeFinal = '';
    transcribeInterim = '';

    recognition.onresult = (event) => {
      transcribeInterim = '';
      let lastConfidence: number | null = null;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (!transcript) continue;
        if (result.isFinal) {
          transcribeFinal += `${transcribeFinal ? ' ' : ''}${transcript.trim()}`;
          const confidence = result[0]?.confidence;
          if (typeof confidence === 'number') {
            lastConfidence = confidence;
          }
        } else {
          transcribeInterim += transcript;
        }
      }
      if (transcribeInterim) {
        setStatus(transcribeInterim.trim());
      } else if (transcribeFinal) {
        setStatus(transcribeFinal);
      }
      const interim = transcribeInterim.trim();
      const finalText = transcribeFinal.trim();
      const combined = interim ? `${finalText}${finalText ? ' ' : ''}${interim}`.trim() : finalText;
      setTranscribeOutput(combined || null, 'raw');
      if (finalText && finalText !== lastLoggedWidgetTranscript) {
        const confidenceOutput =
          typeof lastConfidence === 'number' ? Number(lastConfidence.toFixed(3)) : undefined;
        console.info('[Ekko] Widget speech recognition final result', {
          transcript: finalText,
          confidence: confidenceOutput
        });
        lastLoggedWidgetTranscript = finalText;
      }
    };

    recognition.onerror = (event) => {
      if (event.error !== 'aborted') {
        setStatus(event.message || `Speech recognition error: ${event.error}`);
      }
      stopTranscribe();
    };

    recognition.onend = () => {
      if (recorderState === 'recording') {
        stopTranscribe();
      }
    };

    recognition.start();
    recorderState = 'recording';
    updateMicUi();
    setStatus('Listening…');

    recognitionTimer = window.setTimeout(() => {
      setStatus('Stopped after 3 minutes to stay responsive.');
    setTranscribeOutput('Stopped after 3 minutes to stay responsive.', 'other');
      stopTranscribe();
    }, 3 * 60 * 1000);
  }

  function stopTranscribe() {
    if (recognitionTimer) {
      window.clearTimeout(recognitionTimer);
      recognitionTimer = null;
    }
    if (recognition) {
      recognition.stop();
      recognition = null;
    }

    const text = (transcribeFinal || transcribeInterim).trim();
    transcribeFinal = '';
   transcribeInterim = '';
    setTranscribeOutput(text || null, 'raw');

    if (text) {
      if (directInsertEnabled) {
        recorderState = 'processing';
        updateMicUi();
        setStatus('Preparing email draft…');
        runWithDirectInsertBridge(() => insertTranscriptText(text, { forceStructure: true }))
          .then(() => {
            setStatus('Draft inserted into page.');
          })
          .catch(async (error) => {
            console.warn('Transcript insert failed', error);
            const copied = await copyToClipboard(text);
            if (copied) {
              setStatus('Copied to clipboard.');
            } else {
              setStatus(error instanceof Error ? error.message : 'Unable to insert transcript.');
            }
          })
          .finally(() => {
            recorderState = 'idle';
            updateMicUi();
            updateActionButtonStates();
          });
      } else {
        setStatus('Transcription ready. Use Refine or Copy as needed.');
        recorderState = 'idle';
        updateMicUi();
        updateActionButtonStates();
      }
    } else {
      recorderState = 'idle';
      updateMicUi();
      setStatus('');
      updateActionButtonStates();
    }
  }

  async function startCompose() {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaChunks = [];
    let mimeType: string | undefined;
    if (typeof MediaRecorder !== 'undefined') {
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg',
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4',
        'audio/wav'
      ];
      mimeType = candidates.find((candidate) => {
        try {
          return MediaRecorder.isTypeSupported(candidate);
        } catch {
          return false;
        }
      });
    }

    mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
    mimeType = mediaRecorder.mimeType || mimeType;
    try {
      console.info('[Ekko] Widget compose recorder MIME', mimeType);
    } catch {
      /* ignore */
    }
    hasComposeRecording = false;
    setComposeOutput(null);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        mediaChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      if (composeTimer) {
        window.clearInterval(composeTimer);
        composeTimer = null;
      }
    composeStart = null;
    setTimer(0);
    recorderState = 'processing';
    updateMicUi();
    setComposeOutput('Generating…');
    setStatus('Generating…');

      try {
        const blobMime = mediaRecorder?.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(mediaChunks, { type: blobMime });
        const buffer = await blob.arrayBuffer();
        lastComposeAudio = buffer.slice(0);
        setStatus('Generating…');
        const draft = await composeWidgetAudio(buffer);
        const delivered = await deliverComposeOutput(draft);
        if (delivered) {
          hasComposeRecording = true;
        }
      } catch (error) {
        console.warn('Compose failed', error);
        setStatus(error instanceof Error ? error.message : 'Compose failed.');
      } finally {
        mediaStream?.getTracks().forEach((track) => track.stop());
        mediaStream = null;
        mediaRecorder = null;
        recorderState = 'idle';
        updateMicUi();
      }
    };

    mediaRecorder.start();
    recorderState = 'recording';
    composeStart = Date.now();
    updateMicUi();
    setComposeOutput('Recording… 0:00');
    setStatus('');
    setTimer(0);

    if (composeLimitTimer) {
      window.clearTimeout(composeLimitTimer);
    }
    composeLimitTimer = window.setTimeout(() => {
      composeStart = null;
      setStatus('Time limit reached. Processing…');
      stopCompose();
    }, WIDGET_COMPOSE_MAX_DURATION_MS);

    composeTimer = window.setInterval(() => {
      if (!composeStart) return;
      const elapsed = Date.now() - composeStart;
      setTimer(elapsed);
      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      setComposeOutput(`Recording… ${minutes}:${String(seconds).padStart(2, '0')}`);
      if (elapsed >= WIDGET_COMPOSE_MAX_DURATION_MS) {
        composeStart = null;
        setStatus('');
        setComposeOutput('Time limit reached. Processing…');
        stopCompose();
      }
    }, 200);
  }

  function stopCompose() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
    if (composeLimitTimer) {
      window.clearTimeout(composeLimitTimer);
      composeLimitTimer = null;
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopCompose();
    }
    if (recognition) {
      stopTranscribe();
    }
  }

  function handleMicClick() {
    if (recorderState === 'processing') {
      return;
    }

    if (recorderState === 'recording') {
      stopRecording();
      recorderState = 'idle';
      updateMicUi();
      setStatus('');
      return;
    }

    if (settings.mode === 'compose') {
      startCompose().catch((error) => {
        console.warn('Unable to start compose recording', error);
        recorderState = 'idle';
        updateMicUi();
        setStatus(error instanceof Error ? error.message : 'Unable to start recording.');
      });
    } else {
      startTranscribe()
        .then(() => {
          recorderState = 'recording';
          updateMicUi();
        })
        .catch((error) => {
          console.warn('Unable to start transcription', error);
          recorderState = 'idle';
          updateMicUi();
          setStatus(error instanceof Error ? error.message : 'Unable to start recording.');
        });
    }
  }

  async function handleRegenerate() {
    if (settings.mode !== 'compose') {
      return;
    }
    if (!hasComposeRecording) {
      setStatus('Record first, then try re-generate.');
      return;
    }

    if (!lastComposeAudio) {
      setStatus('Record again before regenerating.');
      return;
    }
    const audioBuffer = lastComposeAudio.slice(0);
    if (recorderState === 'processing') {
      return;
    }
    setComposeOutput(null);
    recorderState = 'processing';
    updateMicUi();
    setStatus('Generating…');

    try {
      await queryDirectInsertState();
      const draft = await composeWidgetAudio(audioBuffer);
      const delivered = await deliverComposeOutput(draft);
      if (delivered) {
        hasComposeRecording = true;
      }
    } catch (error) {
      console.warn('Compose regenerate failed', error);
      setStatus(error instanceof Error ? error.message : 'Compose failed.');
    } finally {
      recorderState = 'idle';
      updateMicUi();
    }
  }

  async function handleRefineClick() {
    if (refineBusy) return;
    const text = transcribeOutputValue.trim();
    if (!text || recorderState !== 'idle') {
      setStatus('Record or paste text before refining.');
      return;
    }

    refineBusy = true;
    updateActionButtonStates();
    setStatus('Refining text…');
    setTranscribeOutput('Refining…', 'other');

    try {
      const result = await rewriteText({
        text,
        sharedContext: WIDGET_REFINE_SHARED_CONTEXT,
        context: WIDGET_REFINE_CONTEXT,
        format: 'plain-text',
        outputLanguage: resolveOutputLanguage(),
        onStatusChange: (status) => {
          if (status === 'downloadable') {
            setTranscribeOutput('Downloading on-device model…', 'other');
          } else if (status === 'ready') {
            setTranscribeOutput('Refining…', 'other');
          }
        },
        onChunk: (chunk) => {
          if (chunk.trim()) {
            setTranscribeOutput(chunk, 'refine');
          }
        }
      });

      const refined = result.content.trim();
      setTranscribeOutput(refined, 'refine');

      if (directInsertEnabled) {
        try {
          await insertTranscriptText(refined, { skipStructuring: true });
          setStatus('Refined text inserted into page.');
        } catch (insertError) {
          console.warn('Unable to insert refined text', insertError);
          const copied = await copyToClipboard(refined);
          setStatus(copied ? 'Refined text copied to clipboard.' : 'Unable to insert refined text.');
        }
      } else {
        setStatus('Refined text ready.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Refine request failed.';
      setStatus(message);
      setTranscribeOutput(text, 'raw');
    } finally {
      refineBusy = false;
      updateActionButtonStates();
    }
  }

  async function handlePolishClick() {
    if (rewriterBusy) return;
    const text = transcribeOutputValue.trim();
    if (!text || recorderState !== 'idle') {
      setStatus('Record or paste text before polishing.');
      return;
    }

    const preset = WIDGET_REWRITE_OPTIONS.find((option) => option.id === rewritePreset) ?? WIDGET_REWRITE_OPTIONS[0];
    rewriterBusy = true;
    updateActionButtonStates();
    setTranscribeOutput('Polishing…', 'other');

    try {
      const result = await rewriteText({
        text,
        sharedContext: preset.config.sharedContext,
        context: preset.config.context,
        tone: preset.config.tone,
        format: preset.config.format,
        length: preset.config.length,
        outputLanguage: resolveOutputLanguage(),
        onStatusChange: (status) => {
          if (status === 'downloadable') {
            setTranscribeOutput('Downloading on-device model…', 'other');
          } else if (status === 'ready') {
            setTranscribeOutput('Polishing…', 'other');
          }
        },
        onChunk: (chunk) => {
          if (chunk.trim()) {
            setTranscribeOutput(chunk, 'polish');
          }
        }
      });

      const polished = result.content.trim();
      setTranscribeOutput(polished, 'polish');

      if (directInsertEnabled) {
        try {
          await insertTranscriptText(polished, { skipStructuring: true });
          setStatus(`Polished text inserted using ${preset.label}.`);
        } catch (insertError) {
          console.warn('Unable to insert polished text', insertError);
          const copied = await copyToClipboard(polished);
          setStatus(copied ? 'Polished text copied to clipboard.' : 'Unable to insert polished text.');
        }
      } else {
        setStatus(`Polished using ${preset.label}.`);
      }
    } catch (error) {
      let message = error instanceof Error ? error.message : 'Rewrite failed.';
      if (/enough space/i.test(message)) {
        message = 'Chrome needs about 22 GB of free space to download the Gemini Nano model.';
      }
      setStatus(message);
      setTranscribeOutput(text, 'raw');
    } finally {
      rewriterBusy = false;
      updateActionButtonStates();
    }
  }

  async function handleCopyTranscript() {
    const text = transcribeOutputValue.trim();
    if (!text) {
      setStatus('Nothing to copy yet.');
      return;
    }
    const copied = await copyToClipboard(text);
    if (copied) {
      setStatus('Copied to clipboard.');
    } else {
      setStatus('Unable to copy text.');
    }
  }

  function applySettingsChange(value: EkkoSettings, changed?: EkkoSettingsChange) {
    if (changed) {
      settings = {
        floatingWidgetEnabled: changed.floatingWidgetEnabled ? value.floatingWidgetEnabled : settings.floatingWidgetEnabled,
        mode: changed.mode ? value.mode : settings.mode,
        composePrompt: changed.composePrompt ? value.composePrompt : settings.composePrompt
      };
    } else {
      settings = value;
    }
    ensureWidget();
  }

  function bootstrap() {
    console.info('[Ekko] Floating widget bootstrap');
    ensureWidget();
    void queryDirectInsertState();
    chrome.runtime.onMessage.addListener((message: EkkoMessage) => {
      handleDirectInsertToggleMessage(message);
      return false;
    });
    getEkkoSettings()
      .then((value) => {
        applySettingsChange(value);
        if (promptTextarea && (!document.activeElement || document.activeElement !== promptTextarea)) {
          promptTextarea.value = value.composePrompt;
        }
      })
      .catch((error) => {
        console.warn('Unable to load Ekko settings', error);
      });

    observeEkkoSettings((value, changed) => {
      applySettingsChange(value, changed);
    });
  }

  bootstrap();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && recorderState === 'recording') {
      stopRecording();
      recorderState = 'idle';
      updateMicUi();
    }
  });
}
