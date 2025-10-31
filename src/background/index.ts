import { DirectInsertPayload, EchoMessage, EchoResponse } from '@shared/messages';
import { ComposeDraftFields, deriveParagraphs, joinParagraphs } from '@shared/compose';
import { listSessions, upsertTranscript } from '@shared/storage';
const DIRECT_INSERT_SCRIPT_ID = 'ekko-direct-insert-script';
const DIRECT_INSERT_STORAGE_KEY = 'ekko:directInsertEnabled';
let directInsertEnabled = true;
const directInsertFrameMap = new Map<number, number>();
const sidePanelState = new Map<string, boolean>();
const SIDE_PANEL_STATE_KEY = 'ekko:sidepanel:state';

type SidePanelTarget = { tabId?: number; windowId?: number };

function resolveSidePanelTargetFromSender(sender: chrome.runtime.MessageSender): SidePanelTarget | null {
  if (sender.tab?.windowId !== undefined) {
    return { windowId: sender.tab.windowId };
  }
  if (sender.tab?.id !== undefined) {
    return { tabId: sender.tab.id };
  }
  return null;
}

function getWindowStateKey(windowId: number): string {
  return `window:${windowId}`;
}

async function resolveWindowId(target: SidePanelTarget): Promise<number | null> {
  if (target.windowId !== undefined) {
    return target.windowId;
  }
  if (target.tabId !== undefined && chrome.tabs?.get) {
    try {
      const tab = await chrome.tabs.get(target.tabId);
      if (tab?.windowId !== undefined) {
        return tab.windowId;
      }
    } catch (error) {
      console.warn('Unable to resolve window for tab', target.tabId, error);
    }
  }
  return null;
}

function snapshotSidePanelState(): Record<string, boolean> {
  const snapshot: Record<string, boolean> = {};
  for (const [key, value] of sidePanelState.entries()) {
    if (value) {
      snapshot[key] = true;
    }
  }
  return snapshot;
}

function persistSidePanelState(): void {
  if (!chrome.storage?.session) {
    return;
  }
  const snapshot = snapshotSidePanelState();
  void chrome.storage.session.set({ [SIDE_PANEL_STATE_KEY]: snapshot }).catch((error) => {
    console.warn('Unable to persist side panel state', error);
  });
}

async function loadSidePanelState(): Promise<void> {
  if (!chrome.storage?.session) {
    return;
  }
  try {
    const result = await chrome.storage.session.get(SIDE_PANEL_STATE_KEY);
    const stored = result?.[SIDE_PANEL_STATE_KEY];
    sidePanelState.clear();
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [key, value] of Object.entries(stored)) {
        if (typeof value === 'boolean' && value) {
          sidePanelState.set(key, true);
        }
      }
    }
  } catch (error) {
    console.warn('Unable to restore side panel state', error);
  }
}

void loadSidePanelState();

function getWindowState(windowId: number): boolean {
  return sidePanelState.get(getWindowStateKey(windowId)) ?? false;
}

function setWindowState(windowId: number, isOpen: boolean): void {
  const key = getWindowStateKey(windowId);
  if (isOpen) {
    sidePanelState.set(key, true);
  } else {
    sidePanelState.delete(key);
  }
  persistSidePanelState();
}

function clearSidePanelStateByWindow(windowId: number): void {
  sidePanelState.delete(getWindowStateKey(windowId));
  persistSidePanelState();
}

async function getSidePanelState(target: SidePanelTarget): Promise<boolean> {
  const windowId = await resolveWindowId(target);
  if (windowId === null) {
    return false;
  }
  return getWindowState(windowId);
}

async function setSidePanelState(target: SidePanelTarget, isOpen: boolean): Promise<void> {
  const windowId = await resolveWindowId(target);
  if (windowId === null) {
    return;
  }
  setWindowState(windowId, isOpen);
}

async function openSidePanel(target: SidePanelTarget): Promise<void> {
  if (!chrome.sidePanel?.open) {
    throw new Error('Side panel API is not available.');
  }

  if (target.tabId !== undefined) {
    await chrome.sidePanel.open({ tabId: target.tabId });
    return;
  }

  if (target.windowId !== undefined) {
    await chrome.sidePanel.open({ windowId: target.windowId });
    return;
  }

  throw new Error('No side panel target specified.');
}

async function openSidePanelForActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) {
    throw new Error('No active tab found.');
  }
  const target: SidePanelTarget =
    tab.id !== undefined
      ? { tabId: tab.id }
      : tab.windowId !== undefined
      ? { windowId: tab.windowId }
      : {};
  if (!target.tabId && !target.windowId) {
    throw new Error('Unable to determine side panel target.');
  }
  await openSidePanel(target);
}

async function closeSidePanel(target: SidePanelTarget, hint?: { tabId?: number }): Promise<void> {
  if (!chrome.sidePanel?.setOptions) {
    throw new Error('Side panel API is not available.');
  }

  if (target.tabId !== undefined) {
    await disableSidePanelForTab(target.tabId);
    return;
  }

  if (target.windowId !== undefined) {
    const tabId =
      hint?.tabId ??
      (await getActiveTabIdInWindow(target.windowId));

    if (tabId === undefined) {
      throw new Error('Unable to determine tab for side panel close.');
    }
    await disableSidePanelForTab(tabId);
    return;
  }

  throw new Error('No side panel target specified.');
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

async function getActiveTabIdInWindow(windowId: number): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab?.id;
}

async function disableSidePanelForTab(tabId: number): Promise<void> {
  if (!chrome.sidePanel?.setOptions) {
    throw new Error('Side panel API is not available.');
  }
  await chrome.sidePanel.setOptions({
    tabId,
    enabled: false
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel.html',
      enabled: true
    });
  } catch (error) {
    console.warn('Unable to re-enable side panel for tab', error);
  }
}

async function toggleDirectInsert(enabled: boolean) {
  const tabId = await getActiveTabId();
  if (enabled) {
    await chrome.scripting.unregisterContentScripts({ ids: [DIRECT_INSERT_SCRIPT_ID] }).catch(() => {
      /* noop: script not yet registered */
    });

    await chrome.scripting.registerContentScripts([
      {
        id: DIRECT_INSERT_SCRIPT_ID,
        matches: ['<all_urls>'],
        js: ['content/directInsert.js'],
        runAt: 'document_idle',
        allFrames: true,
        persistAcrossSessions: false
      }
    ]);

    if (tabId !== undefined) {
      await chrome.scripting
        .executeScript({
          target: { tabId, allFrames: true },
          files: ['content/directInsert.js']
        })
        .catch(() => {
          /* Script may already be injected */
        });
    }
  } else {
    await chrome.scripting.unregisterContentScripts({ ids: [DIRECT_INSERT_SCRIPT_ID] }).catch(() => {
      /* noop */
    });
    if (tabId !== undefined) {
      directInsertFrameMap.delete(tabId);
    }
  }

  directInsertEnabled = enabled;

  if (chrome.storage?.local) {
    chrome.storage.local.set({ [DIRECT_INSERT_STORAGE_KEY]: enabled }).catch(() => {
      /* ignore persistence errors */
    });
  }

  await broadcastDirectInsertState(enabled).catch(() => {
    /* ignore */
  });

  if (tabId === undefined) {
    return;
  }

  const broadcastToggle = async (frameId?: number) => {
    const options = typeof frameId === 'number' ? { frameId } : undefined;
    await chrome.tabs
      .sendMessage(tabId, {
        type: 'ekko/direct-insert/toggle',
        payload: { enabled }
      } satisfies EchoMessage, options)
      .catch(() => {
        /* Frame may not have injected script yet; ignore */
      });
  };

  await broadcastToggle();

  if (chrome.webNavigation?.getAllFrames) {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      await Promise.all(
        frames.map((frame) => broadcastToggle(frame.frameId))
      );
    } catch (error) {
      console.warn('Unable to broadcast direct insert toggle to all frames', error);
    }
  }
}

async function handleTranscriptUpdate(
  message: Extract<EchoMessage, { type: 'ekko/transcript/update' }>
) {
  if (message.type !== 'ekko/transcript/update') {
    return { session: null, delivered: false };
  }

  const session = await upsertTranscript(message.payload.transcript, {
    actions: [message.payload.origin === 'panel' ? 'Captured' : 'Captured'],
    sourceUrl: undefined
  });

  if (!directInsertEnabled) {
    return { session, delivered: false };
  }

  const tabId = await getActiveTabId();
  if (tabId === undefined) {
    return { session, delivered: false };
  }

  const frameId = directInsertFrameMap.get(tabId);
  const messageToSend = {
    type: 'ekko/transcript/update',
    payload: {
      transcript: session.transcript,
      origin: 'panel'
    }
  } satisfies EchoMessage;

  const options = typeof frameId === 'number' ? { frameId } : undefined;

  const send = async () => {
    try {
      const response = await chrome.tabs.sendMessage(tabId, messageToSend, options);
      if (response && typeof response === 'object' && (response as { success?: boolean }).success) {
        return true;
      }
    } catch {
      /* Frame may not have the script yet */
    }
    return false;
  };

  const delivered = await send();

  return { session, delivered };
}

async function handleSummarizeUpdate(message: Extract<EchoMessage, { type: 'ekko/ai/summarize' }>) {
  const session = await upsertTranscript(message.payload.transcript, {
    id: message.payload.sessionId,
    summary: message.payload.summary,
    actions: ['Summarized']
  });

  return session;
}

async function handleRewriteUpdate(message: Extract<EchoMessage, { type: 'ekko/ai/rewrite' }>) {
  const sessions = await listSessions();
  const existing = message.payload.sessionId
    ? sessions.find((entry) => entry.id === message.payload.sessionId)
    : undefined;

  const rewriteEntry = {
    id: crypto.randomUUID(),
    preset: message.payload.preset,
    content: message.payload.rewrite,
    createdAt: Date.now()
  } as const;

  const rewrites = existing?.rewrites ? [rewriteEntry, ...existing.rewrites] : [rewriteEntry];

  const session = await upsertTranscript(message.payload.transcript, {
    id: message.payload.sessionId,
    rewrites,
    summary: existing?.summary,
    actions: ['Rewritten']
  });

  return session;
}

function sanitizeParagraphArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) =>
      typeof entry === 'string'
        ? entry
            .replace(/\r\n?/g, '\n')
            .replace(/[ \t]+$/gm, '')
            .replace(/^\n+|\n+$/g, '')
        : ''
    )
    .filter((entry) => entry.length > 0);
}

async function handleComposeUpdate(message: Extract<EchoMessage, { type: 'ekko/ai/compose' }>) {
  const sessions = await listSessions();
  const target = message.payload.sessionId
    ? sessions.find((entry) => entry.id === message.payload.sessionId)
    : undefined;

  const output = message.payload.output;
  let content: string;
  let subject: string | undefined;
  let raw: string | undefined;
  let paragraphs: string[] | undefined;

  if (typeof output === 'string') {
    content = output.trim();
    subject = undefined;
    raw = output;
    paragraphs = deriveParagraphs(content);
  } else {
    content = typeof output.content === 'string' ? output.content.trim() : '';
    subject =
      typeof output.subject === 'string' && output.subject.trim().length > 0
        ? output.subject.trim()
        : undefined;
    raw = typeof output.raw === 'string' ? output.raw : undefined;
    const providedParagraphs = sanitizeParagraphArray(output.paragraphs);
    if (providedParagraphs.length > 0 && content) {
      const joined = joinParagraphs(providedParagraphs);
      paragraphs = joined.trim() === content.trim() ? providedParagraphs : deriveParagraphs(content);
    } else if (providedParagraphs.length > 0) {
      paragraphs = providedParagraphs;
    } else {
      paragraphs = deriveParagraphs(content);
    }
  }

  const formattedParagraphs = paragraphs ?? deriveParagraphs(content);
  const formattedContent = joinParagraphs(formattedParagraphs);
  if (!formattedContent.trim()) {
    throw new Error('Compose output is empty.');
  }
  content = formattedContent;

  const compositionEntry = {
    id: crypto.randomUUID(),
    preset: message.payload.preset,
    instructions: message.payload.instructions,
    content: formattedContent,
    subject,
    raw,
    paragraphs: formattedParagraphs,
    createdAt: Date.now()
  } as const;

  const sessionId = message.payload.sessionId ?? crypto.randomUUID();
  const compositions = target?.compositions
    ? [compositionEntry, ...target.compositions]
    : [compositionEntry];

  const session = await upsertTranscript(formattedContent, {
    id: sessionId,
    compositions,
    summary: target?.summary,
    rewrites: target?.rewrites,
    actions: ['Composed'],
    tag: message.payload.instructions ?? target?.tag
  });

  return session;
}

async function applyDirectInsertPayload(payload: DirectInsertPayload, tabIdOverride?: number) {
  let normalizedDraft: ComposeDraftFields;
  let normalizedText: string;

  if (payload.draft) {
    const rawContent = typeof payload.draft.content === 'string' ? payload.draft.content.trim() : '';
    if (!rawContent) {
      throw new Error('Draft content is empty.');
    }
    const subject =
      typeof payload.draft.subject === 'string' && payload.draft.subject.trim().length > 0
        ? payload.draft.subject.trim()
        : undefined;
    const providedParagraphs = sanitizeParagraphArray(payload.draft.paragraphs);
    const resolvedParagraphs =
      providedParagraphs.length > 0 && joinParagraphs(providedParagraphs).trim() === rawContent.trim()
        ? providedParagraphs
        : deriveParagraphs(rawContent);
    const content = joinParagraphs(resolvedParagraphs);

    normalizedDraft = { content, subject, paragraphs: resolvedParagraphs };
    normalizedText = content;
  } else {
    const rawContent = (payload.text ?? '').trim();
    if (!rawContent) {
      throw new Error('Draft content is empty.');
    }
    const paragraphs = deriveParagraphs(rawContent);
    const content = joinParagraphs(paragraphs);

    normalizedDraft = { content, paragraphs };
    normalizedText = content;
  }

  const messagePayload: DirectInsertPayload = {
    draft: normalizedDraft,
    text: normalizedText
  };

  const tabId = tabIdOverride ?? (await getActiveTabId());
  if (tabId === undefined) {
    throw new Error('No active tab for direct insert.');
  }

  const sendApplyMessage = () => {
    const message = {
      type: 'ekko/direct-insert/apply',
      payload: messagePayload
    } satisfies EchoMessage;

    const frameId = directInsertFrameMap.get(tabId);
    const options = typeof frameId === 'number' ? { frameId } : undefined;
    return options
      ? chrome.tabs.sendMessage(tabId, message, options)
      : chrome.tabs.sendMessage(tabId, message);
  };

  try {
    await sendApplyMessage();
    await ensureDomInsertion(tabId, normalizedDraft);
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content/directInsert.js']
      });
      await sendApplyMessage();
      await ensureDomInsertion(tabId, normalizedDraft);
    } catch (secondaryError) {
      console.warn('Unable to apply direct insert text', secondaryError);
    }
  }
}

async function ensureDomInsertion(tabId: number, draft: ComposeDraftFields) {
  if (!draft.subject && !draft.content) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (payload: ComposeDraftFields) => {
        try {
          const applySubject = () => {
            if (!payload.subject) {
              return;
            }
            const subjectSelectors = [
              'input[aria-label*="subject" i]',
              'input[name*="subject" i]',
              'textarea[aria-label*="subject" i]',
              'textarea[name*="subject" i]'
            ];
            for (const selector of subjectSelectors) {
              const element = document.querySelector(selector);
              if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
                const current = element.value.trim();
                if (current === payload.subject.trim()) {
                  return;
                }
                try {
                  element.focus({ preventScroll: true });
                } catch {
                  element.focus();
                }
                element.value = payload.subject;
                element.dispatchEvent(new Event('input', { bubbles: true }));
                return;
              }
            }
          };

          const applyBody = () => {
            if (!payload.content) {
              return;
            }
            const selectors = [
              '[aria-label*="message body" i]',
              '[aria-label*="email body" i]',
              '[aria-label*="compose" i]',
              '[role="textbox"][contenteditable="true"]',
              '[contenteditable="true"]'
            ];
            let body: HTMLElement | null = null;
            for (const selector of selectors) {
              const element = document.querySelector(selector);
              if (element instanceof HTMLElement && element.isContentEditable) {
                body = element;
                break;
              }
            }
            if (!body) {
              return;
            }
            const compare = (value: string) => value.replace(/\s+/g, ' ').trim();
            const current = compare(body.innerText);
            const target = compare(payload.content);
            if (current === target) {
              return;
            }
            try {
              body.focus({ preventScroll: true });
            } catch {
              body.focus();
            }
            body.innerHTML = '';
            const doc = body.ownerDocument;
            const paragraphs = payload.content.replace(/\r/g, '').split(/\n{2,}/);
            paragraphs.forEach((paragraph, index) => {
              const div = doc.createElement('div');
              const lines = paragraph.split('\n');
              lines.forEach((line, lineIndex) => {
                if (lineIndex > 0) {
                  div.appendChild(doc.createElement('br'));
                }
                div.appendChild(doc.createTextNode(line));
              });
              body?.appendChild(div);
              if (index < paragraphs.length - 1) {
                body?.appendChild(doc.createElement('br'));
              }
            });
            body.dispatchEvent(new Event('input', { bubbles: true }));
          };

          applySubject();
          applyBody();
        } catch (injectionError) {
          console.warn('[Echo] Direct insert DOM fallback failed', injectionError);
        }
      },
      args: [draft]
    });
  } catch (error) {
    console.warn('Unable to run direct insert DOM fallback', error);
  }
}

void initializeDirectInsertState();

async function initializeDirectInsertState() {
  if (!chrome.storage?.local) {
    if (directInsertEnabled) {
      await toggleDirectInsert(true).catch((error) => {
        console.warn('Unable to enable direct insert on init', error);
      });
    }
    return;
  }

  try {
    const record = await chrome.storage.local.get(DIRECT_INSERT_STORAGE_KEY);
    const stored = record[DIRECT_INSERT_STORAGE_KEY];
    if (typeof stored === 'boolean') {
      directInsertEnabled = stored;
    } else {
      directInsertEnabled = true;
      await chrome.storage.local.set({ [DIRECT_INSERT_STORAGE_KEY]: true });
    }

    await toggleDirectInsert(directInsertEnabled).catch((error) => {
      console.warn('Unable to apply stored direct insert state', error);
    });
  } catch (error) {
    console.warn('Unable to read direct insert state', error);
  }
}

async function broadcastDirectInsertState(enabled: boolean) {
  try {
    await chrome.runtime.sendMessage({
      type: 'ekko/direct-insert/initialized',
      payload: { enabled }
    } satisfies EchoMessage);
  } catch {
    /* ignore */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setOptions) {
    chrome.sidePanel.setOptions({
      path: 'sidepanel.html',
      enabled: true
    });
  }

  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

if (chrome.action?.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    const target: SidePanelTarget | null =
      tab.id !== undefined
        ? { tabId: tab.id }
        : tab.windowId !== undefined
        ? { windowId: tab.windowId }
        : null;
    if (!target) {
      console.warn('Unable to determine tab for action click side panel open');
      return;
    }
    openSidePanel(target).catch((error) => {
      console.warn('Unable to open Echo side panel from action click', error);
    });
  });
}

if (chrome.windows?.onRemoved) {
  chrome.windows.onRemoved.addListener((windowId) => {
    clearSidePanelStateByWindow(windowId);
  });
}

chrome.commands.onCommand.addListener(async (command) => {
  switch (command) {
    case '_execute_action':
      await openSidePanelForActiveTab();
      break;
    case 'toggle-recording':
      chrome.runtime.sendMessage<EchoMessage>({
        type: 'ekko/transcript/update',
        payload: {
          transcript: '',
          origin: 'panel'
        }
      });
      break;
    default:
      console.debug('Unhandled command', command);
  }
});

chrome.runtime.onMessage.addListener((message: EchoMessage, sender, sendResponse) => {
  if (message.type === 'ekko/sidepanel/state') {
    const open = !!message.payload?.open;
    const tabIdFromPayload =
      message.payload && typeof message.payload === 'object' && 'tabId' in message.payload
        ? (message.payload as { tabId?: number }).tabId
        : undefined;
    const windowIdFromPayload =
      message.payload && typeof message.payload === 'object' && 'windowId' in message.payload
        ? (message.payload as { windowId?: number }).windowId
        : undefined;
    const target =
      windowIdFromPayload !== undefined
        ? { windowId: windowIdFromPayload }
        : tabIdFromPayload !== undefined
        ? { tabId: tabIdFromPayload }
        : resolveSidePanelTargetFromSender(sender) ??
          (sender.tab?.windowId !== undefined ? { windowId: sender.tab.windowId } : null);

    if (!target) {
      sendResponse({ ok: false, error: 'Unable to determine side panel window.' } satisfies EchoResponse);
      return true;
    }

    setSidePanelState(target, open)
      .then(() => {
        sendResponse({ ok: true } satisfies EchoResponse);
      })
      .catch((error) => {
        const description = error instanceof Error ? error.message : 'Unable to update side panel state.';
        sendResponse({ ok: false, error: description } satisfies EchoResponse);
      });
    return true;
  }

  if (message.type === 'ekko/sidepanel/open') {
    const target = resolveSidePanelTargetFromSender(sender);
    if (!target) {
      sendResponse({ ok: false, error: 'Unable to determine tab for side panel.' } satisfies EchoResponse);
      return true;
    }

    const payloadWindowId =
      message.payload && typeof message.payload === 'object' && 'windowId' in message.payload
        ? (message.payload as { windowId?: number }).windowId
        : undefined;
    const senderWindowId = sender.tab?.windowId;

    (async () => {
      try {
        const action =
          message.payload && typeof message.payload === 'object' && 'action' in message.payload
            ? (message.payload as { action?: 'toggle' | 'open' | 'close' }).action ?? 'toggle'
            : 'toggle';

        const windowHint = senderWindowId ?? payloadWindowId;
        const currentlyOpen =
          typeof windowHint === 'number'
            ? getWindowState(windowHint)
            : await getSidePanelState(target);
        const resolvedAction =
          action === 'toggle' ? (currentlyOpen ? 'close' : 'open') : action;

        const knownWindow =
          senderWindowId ??
          payloadWindowId ??
          (await resolveWindowId(target)) ??
          undefined;

        if (resolvedAction === 'close') {
          const hintTabId =
            sender.tab?.id ?? (typeof knownWindow === 'number' ? await getActiveTabIdInWindow(knownWindow) : undefined);
          await closeSidePanel(target, { tabId: hintTabId });
          if (typeof knownWindow === 'number') {
            setWindowState(knownWindow, false);
          } else {
            await setSidePanelState(target, false);
          }
        } else {
          await openSidePanel(target);
          const windowForState =
            knownWindow ??
            (await resolveWindowId(target)) ??
            undefined;
          if (typeof windowForState === 'number') {
            setWindowState(windowForState, true);
          } else {
            await setSidePanelState(target, true);
          }
        }

        sendResponse({
          ok: true,
          data: { state: resolvedAction === 'close' ? 'closed' : 'opened' }
        } satisfies EchoResponse);
      } catch (error) {
        const description = error instanceof Error ? error.message : 'Unable to open settings.';
        sendResponse({ ok: false, error: description } satisfies EchoResponse);
      }
    })();
    return true;
  }

  (async () => {
    try {
      switch (message.type) {
        case 'ekko/direct-insert/toggle':
          await toggleDirectInsert(message.payload.enabled);
          sendResponse({ ok: true } satisfies EchoResponse);
          break;
        case 'ekko/direct-insert/query':
          sendResponse({
            ok: true,
            data: { enabled: directInsertEnabled }
          } satisfies EchoResponse);
          break;
        case 'ekko/widget/insert': {
          const tabId = sender.tab?.id;
          if (tabId === undefined) {
            sendResponse({ ok: false, error: 'No active tab found for insert request.' });
            break;
          }
          try {
            if (!message.payload) {
              throw new Error('Missing draft payload.');
            }
            await applyDirectInsertPayload(message.payload, tabId);
            sendResponse({ ok: true } satisfies EchoResponse);
          } catch (error) {
            console.warn('Widget insert failed', error);
            const msg = error instanceof Error ? error.message : 'Compose failed.';
            sendResponse({ ok: false, error: msg } satisfies EchoResponse);
          }
          break;
        }
        case 'ekko/direct-insert/focus':
          if (sender.tab?.id !== undefined && typeof sender.frameId === 'number') {
            directInsertFrameMap.set(sender.tab.id, sender.frameId);
          }
          sendResponse({ ok: true } satisfies EchoResponse);
          break;
        case 'ekko/transcript/update': {
          const session = await handleTranscriptUpdate(message);
          sendResponse({ ok: true, data: session } satisfies EchoResponse);
          break;
        }
        case 'ekko/ai/summarize': {
          const session = await handleSummarizeUpdate(message);
          sendResponse({ ok: true, data: session } satisfies EchoResponse);
          break;
        }
        case 'ekko/ai/rewrite': {
          const session = await handleRewriteUpdate(message);
          sendResponse({ ok: true, data: session } satisfies EchoResponse);
          break;
        }
        case 'ekko/ai/compose': {
          const session = await handleComposeUpdate(message);
          sendResponse({ ok: true, data: session } satisfies EchoResponse);
          break;
        }
        case 'ekko/direct-insert/apply': {
          await applyDirectInsertPayload(message.payload);
          sendResponse({ ok: true } satisfies EchoResponse);
          break;
        }
        default:
          sendResponse({
            ok: false,
            error: `Unhandled message type: ${(message as EchoMessage).type}`
          } satisfies EchoResponse);
      }
    } catch (error) {
      const description = error instanceof Error ? error.message : 'Unknown background error';
      console.error('Echo background error', error);
      sendResponse({ ok: false, error: description } satisfies EchoResponse);
    }
  })();
  return true;
});
