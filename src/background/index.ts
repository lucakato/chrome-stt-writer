import { EkkoMessage, EkkoResponse } from '@shared/messages';
import { upsertTranscript } from '@shared/storage';

const DIRECT_INSERT_SCRIPT_ID = 'ekko-direct-insert-script';
let directInsertEnabled = false;

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
        allFrames: false,
        persistAcrossSessions: false
      }
    ]);
  } else {
    await chrome.scripting.unregisterContentScripts({ ids: [DIRECT_INSERT_SCRIPT_ID] }).catch(() => {
      /* noop */
    });
  }

  directInsertEnabled = enabled;

  await chrome.tabs.sendMessage(tabId, {
    type: 'ekko/direct-insert/toggle',
    payload: { enabled }
  } satisfies EkkoMessage).catch(() => {
    /* No listener yet; content script will pick up toggle on first transcript update. */
  });
}

async function handleTranscriptUpdate(message: EkkoMessage) {
  if (message.type !== 'ekko/transcript/update') {
    return;
  }

  const session = await upsertTranscript(message.payload.transcript, {
    actions: [message.payload.origin === 'panel' ? 'Captured' : 'Captured'],
    sourceUrl: undefined
  });

  if (!directInsertEnabled) {
    return;
  }

  const tabId = await getActiveTabId();
  if (tabId === undefined) {
    return;
  }

  await chrome.tabs.sendMessage(tabId, {
    type: 'ekko/transcript/update',
    payload: {
      transcript: session.transcript,
      origin: 'panel'
    }
  } satisfies EkkoMessage);
}

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setOptions) {
    chrome.sidePanel.setOptions({
      path: 'dist/sidepanel.html',
      enabled: true
    });
  }
});

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

chrome.runtime.onMessage.addListener((message: EkkoMessage, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'ekko/direct-insert/toggle':
          await toggleDirectInsert(message.payload.enabled);
          sendResponse({ ok: true } satisfies EkkoResponse);
          break;
        case 'ekko/transcript/update':
          await handleTranscriptUpdate(message);
          sendResponse({ ok: true } satisfies EkkoResponse);
          break;
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
