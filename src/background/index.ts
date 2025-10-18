import { EkkoMessage, EkkoResponse } from '@shared/messages';
import { listSessions, upsertTranscript } from '@shared/storage';
const DIRECT_INSERT_SCRIPT_ID = 'ekko-direct-insert-script';
let directInsertEnabled = false;
const directInsertFrameMap = new Map<number, number>();

async function ensureSidePanelOpened() {
  if (!chrome.sidePanel?.open) {
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id !== undefined) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
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
  chrome.action.onClicked.addListener(async () => {
    try {
      await ensureSidePanelOpened();
    } catch (error) {
      console.warn('Unable to open Ekko side panel from action click', error);
    }
  });
}

chrome.commands.onCommand.addListener(async (command) => {
  switch (command) {
    case '_execute_action':
      await ensureSidePanelOpened();
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
        case 'ekko/sidepanel/open':
          await ensureSidePanelOpened();
          sendResponse({ ok: true } satisfies EkkoResponse);
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
