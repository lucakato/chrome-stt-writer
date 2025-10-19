import { EkkoMessage, EkkoResponse } from '@shared/messages';
import { listSessions, upsertTranscript } from '@shared/storage';
const DIRECT_INSERT_SCRIPT_ID = 'ekko-direct-insert-script';
let directInsertEnabled = false;
const directInsertFrameMap = new Map<number, number>();
const sidePanelState = new Map<string, boolean>();
const SIDE_PANEL_STATE_KEY = 'ekko:sidepanel:state';

type SidePanelTarget = { tabId?: number; windowId?: number };

function resolveSidePanelTargetFromSender(sender: chrome.runtime.MessageSender): SidePanelTarget | null {
  if (sender.tab?.id !== undefined) {
    return { tabId: sender.tab.id };
  }
  if (sender.tab?.windowId !== undefined) {
    return { windowId: sender.tab.windowId };
  }
  return null;
}

function normalizeTarget(target: SidePanelTarget): SidePanelTarget | null {
  if (target.windowId !== undefined) {
    return { windowId: target.windowId };
  }
  if (target.tabId !== undefined) {
    return { windowId: undefined, tabId: target.tabId };
  }
  return null;
}

function getSidePanelStateKey(target: SidePanelTarget): string | null {
  if (target.windowId !== undefined) {
    return `window:${target.windowId}`;
  }
  if (target.tabId !== undefined) {
    return `tab:${target.tabId}`;
  }
  return null;
}

async function resolveWindowTarget(target: SidePanelTarget): Promise<SidePanelTarget | null> {
  if (target.windowId !== undefined) {
    return { windowId: target.windowId };
  }
  if (target.tabId !== undefined && chrome.tabs?.get) {
    try {
      const tab = await chrome.tabs.get(target.tabId);
      if (tab?.windowId !== undefined) {
        return { windowId: tab.windowId };
      }
    } catch {
      return null;
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

function getSidePanelState(target: SidePanelTarget): boolean {
  const key = getSidePanelStateKey(target);
  if (!key) return false;
  return sidePanelState.get(key) ?? false;
}

function setSidePanelState(target: SidePanelTarget, isOpen: boolean): void {
  const key = getSidePanelStateKey(target);
  if (!key) return;
  if (isOpen) {
    sidePanelState.set(key, true);
  } else {
    sidePanelState.delete(key);
  }
  persistSidePanelState();
}

function clearSidePanelStateByKey(key: string): void {
  if (!key) return;
  sidePanelState.delete(key);
  persistSidePanelState();
}

async function openSidePanel(target: SidePanelTarget): Promise<void> {
  if (!chrome.sidePanel?.open) {
    throw new Error('Side panel API is not available.');
  }

  if (target.tabId !== undefined) {
    await chrome.sidePanel.open({ tabId: target.tabId });
    setSidePanelState(target, true);
    return;
  }

  if (target.windowId !== undefined) {
    await chrome.sidePanel.open({ windowId: target.windowId });
    setSidePanelState(target, true);
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

async function closeSidePanel(target: SidePanelTarget): Promise<void> {
  if (!chrome.sidePanel?.setOptions) {
    throw new Error('Side panel API is not available.');
  }

  if (target.tabId !== undefined) {
    await chrome.sidePanel.setOptions({
      tabId: target.tabId,
      enabled: false
    });
    setSidePanelState(target, false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      await chrome.sidePanel.setOptions({
        tabId: target.tabId,
        path: 'sidepanel.html',
        enabled: true
      });
    } catch (error) {
      console.warn('Unable to re-enable side panel for tab', error);
    }
    return;
  }

  if (target.windowId !== undefined) {
    throw new Error('Closing side panel for a window is not supported.');
  }

  throw new Error('No side panel target specified.');
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

async function toggleDirectInsert(enabled: boolean) {
  const tabId = await getActiveTabId();
  if (tabId === undefined) {
    throw new Error('No active tab for direct insert bridge');
  }

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

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/directInsert.js']
    }).catch(() => {
      /* Script may already be injected */
    });
  } else {
    await chrome.scripting.unregisterContentScripts({ ids: [DIRECT_INSERT_SCRIPT_ID] }).catch(() => {
      /* noop */
    });
    directInsertFrameMap.delete(tabId);
  }

  directInsertEnabled = enabled;

  const broadcastToggle = async (frameId?: number) => {
    const options = typeof frameId === 'number' ? { frameId } : undefined;
    await chrome.tabs
      .sendMessage(tabId, {
        type: 'ekko/direct-insert/toggle',
        payload: { enabled }
      } satisfies EkkoMessage, options)
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
  message: Extract<EkkoMessage, { type: 'ekko/transcript/update' }>
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
  } satisfies EkkoMessage;

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

async function handleSummarizeUpdate(message: Extract<EkkoMessage, { type: 'ekko/ai/summarize' }>) {
  const session = await upsertTranscript(message.payload.transcript, {
    id: message.payload.sessionId,
    summary: message.payload.summary,
    actions: ['Summarized']
  });

  return session;
}

async function handleRewriteUpdate(message: Extract<EkkoMessage, { type: 'ekko/ai/rewrite' }>) {
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

async function handleComposeUpdate(message: Extract<EkkoMessage, { type: 'ekko/ai/compose' }>) {
  const sessions = await listSessions();
  const target = message.payload.sessionId
    ? sessions.find((entry) => entry.id === message.payload.sessionId)
    : undefined;

  const compositionEntry = {
    id: crypto.randomUUID(),
    preset: message.payload.preset,
    instructions: message.payload.instructions,
    content: message.payload.output,
    createdAt: Date.now()
  } as const;

  const sessionId = message.payload.sessionId ?? crypto.randomUUID();
  const compositions = target?.compositions
    ? [compositionEntry, ...target.compositions]
    : [compositionEntry];

  const session = await upsertTranscript(message.payload.output, {
    id: sessionId,
    compositions,
    summary: target?.summary,
    rewrites: target?.rewrites,
    actions: ['Composed'],
    tag: message.payload.instructions ?? target?.tag
  });

  return session;
}

async function applyDirectInsertText(text: string, tabIdOverride?: number) {
  const tabId = tabIdOverride ?? (await getActiveTabId());
  if (tabId === undefined) {
    throw new Error('No active tab for direct insert.');
  }

  const sendApplyMessage = () => {
    const message = {
      type: 'ekko/direct-insert/apply',
      payload: { text }
    } satisfies EkkoMessage;

    const frameId = directInsertFrameMap.get(tabId);
    const options = typeof frameId === 'number' ? { frameId } : undefined;
    return options
      ? chrome.tabs.sendMessage(tabId, message, options)
      : chrome.tabs.sendMessage(tabId, message);
  };

  try {
    await sendApplyMessage();
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content/directInsert.js']
      });
      await sendApplyMessage();
    } catch (secondaryError) {
      console.warn('Unable to apply direct insert text', secondaryError);
    }
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
      console.warn('Unable to open Ekko side panel from action click', error);
    });
  });
}

if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    clearSidePanelStateByKey(`tab:${tabId}`);
  });
}

if (chrome.windows?.onRemoved) {
  chrome.windows.onRemoved.addListener((windowId) => {
    clearSidePanelStateByKey(`window:${windowId}`);
  });
}

chrome.commands.onCommand.addListener(async (command) => {
  switch (command) {
    case '_execute_action':
      await openSidePanelForActiveTab();
      break;
    case 'toggle-recording':
      chrome.runtime.sendMessage<EkkoMessage>({
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

chrome.runtime.onMessage.addListener((message: EkkoMessage, sender, sendResponse) => {
  if (message.type === 'ekko/sidepanel/state') {
    const open = !!message.payload?.open;
    const tabIdFromPayload =
      message.payload && typeof message.payload === 'object' && 'tabId' in message.payload
        ? (message.payload as { tabId?: number }).tabId
        : undefined;
    const target =
      tabIdFromPayload !== undefined
        ? { tabId: tabIdFromPayload }
        : resolveSidePanelTargetFromSender(sender) ??
          (sender.tab?.windowId !== undefined ? { windowId: sender.tab.windowId } : null);

    if (target) {
      setSidePanelState(target, open);
    }

    sendResponse({ ok: true } satisfies EkkoResponse);
    return true;
  }

  if (message.type === 'ekko/sidepanel/open') {
    const target = resolveSidePanelTargetFromSender(sender);
    if (!target) {
      sendResponse({ ok: false, error: 'Unable to determine tab for side panel.' } satisfies EkkoResponse);
      return true;
    }

    (async () => {
      try {
        const action =
          message.payload && typeof message.payload === 'object' && 'action' in message.payload
            ? (message.payload as { action?: 'toggle' | 'open' | 'close' }).action ?? 'toggle'
            : 'toggle';

        const currentlyOpen = getSidePanelState(target);
        const resolvedAction =
          action === 'toggle' ? (currentlyOpen ? 'close' : 'open') : action;

        if (resolvedAction === 'close') {
          await closeSidePanel(target);
        } else {
          await openSidePanel(target);
        }

        sendResponse({
          ok: true,
          data: { state: resolvedAction === 'close' ? 'closed' : 'opened' }
        } satisfies EkkoResponse);
      } catch (error) {
        const description = error instanceof Error ? error.message : 'Unable to open settings.';
        sendResponse({ ok: false, error: description } satisfies EkkoResponse);
      }
    })();
    return true;
  }

  (async () => {
    try {
      switch (message.type) {
        case 'ekko/direct-insert/toggle':
          await toggleDirectInsert(message.payload.enabled);
          sendResponse({ ok: true } satisfies EkkoResponse);
          break;
        case 'ekko/direct-insert/query':
          sendResponse({
            ok: true,
            data: { enabled: directInsertEnabled }
          } satisfies EkkoResponse);
          break;
        case 'ekko/widget/insert': {
          const tabId = sender.tab?.id;
          if (tabId === undefined) {
            sendResponse({ ok: false, error: 'No active tab found for insert request.' });
            break;
          }
          try {
            if (!message.payload || typeof message.payload !== 'object' || typeof (message.payload as { text?: string }).text !== 'string') {
              throw new Error('Missing text payload.');
            }
            const text = (message.payload as { text: string }).text;
            await applyDirectInsertText(text, tabId);
            sendResponse({ ok: true } satisfies EkkoResponse);
          } catch (error) {
            console.warn('Widget insert failed', error);
            const msg = error instanceof Error ? error.message : 'Compose failed.';
            sendResponse({ ok: false, error: msg } satisfies EkkoResponse);
          }
          break;
        }
        case 'ekko/direct-insert/focus':
          if (sender.tab?.id !== undefined && typeof sender.frameId === 'number') {
            directInsertFrameMap.set(sender.tab.id, sender.frameId);
          }
          sendResponse({ ok: true } satisfies EkkoResponse);
          break;
        case 'ekko/transcript/update': {
          const session = await handleTranscriptUpdate(message);
          sendResponse({ ok: true, data: session } satisfies EkkoResponse);
          break;
        }
        case 'ekko/ai/summarize': {
          const session = await handleSummarizeUpdate(message);
          sendResponse({ ok: true, data: session } satisfies EkkoResponse);
          break;
        }
        case 'ekko/ai/rewrite': {
          const session = await handleRewriteUpdate(message);
          sendResponse({ ok: true, data: session } satisfies EkkoResponse);
          break;
        }
        case 'ekko/ai/compose': {
          const session = await handleComposeUpdate(message);
          sendResponse({ ok: true, data: session } satisfies EkkoResponse);
          break;
        }
        case 'ekko/direct-insert/apply': {
          await applyDirectInsertText(message.payload.text);
          sendResponse({ ok: true } satisfies EkkoResponse);
          break;
        }
        default:
          sendResponse({
            ok: false,
            error: `Unhandled message type: ${(message as EkkoMessage).type}`
          } satisfies EkkoResponse);
      }
    } catch (error) {
      const description = error instanceof Error ? error.message : 'Unknown background error';
      console.error('Ekko background error', error);
      sendResponse({ ok: false, error: description } satisfies EkkoResponse);
    }
  })();
  return true;
});
