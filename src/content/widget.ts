import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IconType } from 'react-icons';
import { MdKeyboardVoice } from 'react-icons/md';
import { RiVoiceprintFill } from 'react-icons/ri';
import { IoSettingsSharp } from 'react-icons/io5';
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
import { composeFromAudio } from '@shared/ai/prompt';

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
const ICON_MIC_PROCESSING = '<span aria-hidden="true">⏳</span>';
const WIDGET_COMPOSE_MAX_DURATION_MS = 90_000;

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
  let popupOpen = false;
  let lastComposeAudio: ArrayBuffer | null = null;
  let hasComposeRecording = false;

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
  let directInsertEnabled = true;

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
      }
      .ekko-popup__footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
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
  }

  function handleDirectInsertToggleMessage(message: EkkoMessage) {
    if (message.type === 'ekko/direct-insert/toggle') {
      const enabled = !!(message.payload as { enabled?: boolean }).enabled;
      setDirectInsertState(enabled);
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

  async function composeWidgetAudio(audioBuffer: ArrayBuffer): Promise<string> {
    const instruction = settings.composePrompt.trim();
    console.info('[Ekko] widget instruction:', instruction);
    const browserLang = typeof navigator !== 'undefined' ? navigator.language : 'en';
    const baseLang = browserLang?.split('-')[0]?.toLowerCase() ?? 'en';
    const supportedLanguages = ['en', 'es', 'ja'];
    const outputLanguage = supportedLanguages.includes(baseLang) ? baseLang : 'en';
    let lastChunk = '';
    const systemPrompt = instruction
      ? `${WIDGET_DEFAULT_COMPOSE_PROMPT}\n\nFollow these additional instructions exactly:\n${instruction}`
      : WIDGET_DEFAULT_COMPOSE_PROMPT;

    const text = await composeFromAudio({
      audio: audioBuffer,
      systemPrompt,
      instruction: instruction ? instruction : undefined,
      outputLanguage,
      onChunk: (chunk) => {
        lastChunk = chunk.trim();
        if (lastChunk) {
          setStatus(lastChunk);
        }
      }
    });
    return text.trim();
  }

  async function insertComposeText(text: string) {
    const response = await chrome.runtime
      .sendMessage({
        type: 'ekko/widget/insert',
        payload: { text }
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

  async function deliverComposeOutput(text: string): Promise<boolean> {
    if (!text) {
      setStatus('Compose returned no response.');
      return false;
    }

    const body = `${text}`;

    if (!directInsertEnabled) {
      setStatus(body);
      return true;
    }

    try {
      await insertComposeText(text);
      setStatus(body);
      return true;
    } catch (error) {
      const copied = await copyToClipboard(text);
      if (copied) {
        setStatus(body);
        return true;
      }
      const message = error instanceof Error ? error.message : 'Compose failed.';
      setStatus(`${message}\n${body}`.trim());
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

    const footer = document.createElement('div');
    footer.className = 'ekko-popup__footer';

    statusLabel = document.createElement('span');
    statusLabel.className = 'ekko-popup__status';

    timerLabel = document.createElement('span');
    timerLabel.className = 'ekko-popup__timer';

    const buttonGroup = document.createElement('div');

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

    buttonGroup.appendChild(micButton);
    buttonGroup.appendChild(settingsButton);

    regenerateButton = document.createElement('button');
    regenerateButton.type = 'button';
    regenerateButton.className = 'ekko-popup__regen';
    regenerateButton.textContent = 'Re-generate';
    regenerateButton.addEventListener('click', handleRegenerate);

    footer.appendChild(statusLabel);
    footer.appendChild(buttonGroup);
    footer.appendChild(regenerateButton);

    body.appendChild(modeWrapper);
    body.appendChild(promptTextarea);
    body.appendChild(footer);

    popup.appendChild(header);
    popup.appendChild(body);
    root?.appendChild(popup);
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
  }

  function setStatus(text: string) {
    if (statusLabel) {
      statusLabel.textContent = text;
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
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (!transcript) continue;
        if (result.isFinal) {
          transcribeFinal += `${transcribeFinal ? ' ' : ''}${transcript.trim()}`;
        } else {
          transcribeInterim += transcript;
        }
      }
      if (transcribeInterim) {
        setStatus(transcribeInterim.trim());
      } else if (transcribeFinal) {
        setStatus(transcribeFinal);
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

    if (text) {
      recorderState = 'processing';
      updateMicUi();
      setStatus('Injecting…');
      chrome.runtime
        .sendMessage({
          type: 'ekko/transcript/update',
          payload: { transcript: text, origin: 'panel' }
        } satisfies EkkoMessage)
        .finally(() => {
          recorderState = 'idle';
          updateMicUi();
          setStatus('');
        });
    } else {
      recorderState = 'idle';
      updateMicUi();
      setStatus('');
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
      setStatus('Generating…');

      try {
        const blobMime = mediaRecorder?.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(mediaChunks, { type: blobMime });
        const buffer = await blob.arrayBuffer();
        lastComposeAudio = buffer.slice(0);
        setStatus('Generating…');
        const text = await composeWidgetAudio(buffer);
        const delivered = await deliverComposeOutput(text);
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
    setStatus('Recording…');
    setTimer(0);

    composeTimer = window.setInterval(() => {
      if (!composeStart) return;
      const elapsed = Date.now() - composeStart;
      setTimer(elapsed);
      if (elapsed >= WIDGET_COMPOSE_MAX_DURATION_MS) {
        composeStart = null;
        setStatus('Time limit reached. Processing…');
        stopCompose();
      }
    }, 200);
  }

  function stopCompose() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
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
    recorderState = 'processing';
    updateMicUi();
    setStatus('Generating…');

    try {
      await queryDirectInsertState();
      const text = await composeWidgetAudio(audioBuffer);
      const delivered = await deliverComposeOutput(text);
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
