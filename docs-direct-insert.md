### 1. Side panel: user-facing controller

When you toggle “Direct Insert Mode” in the panel, we send a message to the background
service worker:

chrome.runtime.sendMessage({
type: 'ekko/direct-insert/toggle',
payload: { enabled }
});

While this mode is on we mirror every transcript update. The panel effect watches the live
transcript and sends it to the background anytime it changes:

chrome.runtime.sendMessage({
type: 'ekko/transcript/update',
payload: { transcript, origin: 'panel' }
});

Because the transcript might be sent before an editable field exists, we don’t mark it
“delivered” until we hear back that the content script actually inserted it; we keep retrying
until the field is ready.

———

### 2. Background service worker: router + state keeper

The service worker coordinates everything.

1. Injection and bookkeeping

    When the user enables Direct Insert:
    - We register content/directInsert.js as a content script with allFrames: true; that
    guarantees the script is injected into every frame (top-level page and iframes).
    - We immediately call chrome.scripting.executeScript({ tabId, allFrames: true, files:
    [...] }) so existing frames get it right away—no need to reload the page.
    - We broadcast the toggle message to every frame so each script knows whether to install
    its focus listener.
2. Tracking focus

    Every frame that has an editable element in focus sends an ekko/direct-insert/focus
    message; the service worker records that frame ID in a directInsertFrameMap. That way,
    when new transcript text arrives we know exactly which frame currently owns the caret.
3. Mirroring text

    When the panel sends ekko/transcript/update, the worker routes it to the most recently
    focused frame:

    chrome.tabs.sendMessage(tabId, message, { frameId });

    The content script replies with { success: boolean }. We relay that back to the panel so
    it can either cache the text (success) or retry (not yet focused/ready).
4. Ad-hoc insert

    The Compose “Insert into page” button uses a separate ekko/direct-insert/apply message
    with the text payload; we send that down the same frame-aware path.
5. Query endpoint

    Newly injected frames ask the background “is the bridge currently enabled?” via ekko/
    direct-insert/query. The worker responds with { enabled: true/false } so the script can
    immediately hook up its listeners if the mode is on.

———

### 3. Content script: text insertion engine

content/directInsert.js is what actually touches the page’s DOM.

- One-time initialization

Each frame checks window.__ekkoDirectInsertInjected__ to avoid duplicate loads. On load it:
    1. Asks the background for the current toggle state (ekko/direct-insert/query).
    2. If the response says “enabled”, it installs a focusin listener.
- Focus tracking

Whenever an editable element gains focus, the script remembers that element and informs the
background with ekko/direct-insert/focus.
- Applying text

It listens for two message types:
    - ekko/transcript/update → replace the entire value (used for live dictation).
    - ekko/direct-insert/apply → insert at the current caret position (used for Compose →
    “Insert into page”).

The helper functions handle both <input>/<textarea> and contentEditable elements:

function applyTranscript(text, mode) {
    const target = currentEditable();
    if (!target) return false;

    if (mode === 'insert') return insertAtCaret(target, text);
    return replaceEntireValue(target, text);
}

Each operation returns true only if the DOM was actually updated; that boolean travels all
the way back to the panel, giving us precise acknowledgment.

———

### 4. Why it works everywhere (except browser chrome)

Putting it together:

- We always have a content script in the right frame thanks to injecting into allFrames: true
both via the manifest registration and the immediate executeScript.
- Every frame knows the current toggle state because it queries the background when the
script loads; if Direct Insert is already on, it starts listening immediately.
- Every focus change is reported so the background can route updates to the correct frame ID.
- We only cache the transcript after a successful insert, so if the user toggles the feature
before focusing a field, we keep retrying until the field appears.

The only places it doesn’t work are where Chrome forbids content scripts entirely: the
browser’s omnibox (URL bar) and privileged chrome:// pages like the built-in new tab search
box.

———

### Mental model

Think of Direct Insert Mode as a small client-server loop:

1. Panel (client): “Here’s the latest text. Did it land? Let me know.”
2. Service worker (server): “Got it, sending to frame X.”
3. Content script (another client): tries to insert, reports success/failure.

By tracking frame focus and acknowledging deliveries, we made it robust even when iframes
appear mid-session. That’s how Direct Insert Mode now mirrors live dictation into web editors
—no matter which frame the editor lives in.