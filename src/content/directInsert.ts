import { EkkoMessage, EkkoResponse } from '@shared/messages';

declare global {
  interface Window {
    __ekkoDirectInsertInjected__?: boolean;
  }
}

if (window.__ekkoDirectInsertInjected__) {
  // Already injected in this document.
} else {
  window.__ekkoDirectInsertInjected__ = true;

  let directInsertEnabled = false;
  let lastEditable: HTMLElement | null = null;

  let runtimeHealthy = true;

  function isRuntimeAvailable(): boolean {
    return runtimeHealthy && typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  }

  function safeSendMessage(message: EkkoMessage) {
    if (!isRuntimeAvailable()) {
      return undefined;
    }
    try {
      return chrome.runtime.sendMessage(message);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Extension context invalidated')) {
        runtimeHealthy = false;
        disableListeners();
        window.__ekkoDirectInsertInjected__ = false;
      }
      console.warn('[Ekko] Unable to send runtime message after reload', error);
      return undefined;
    }
  }

  function isEditableElement(element: EventTarget | null): element is HTMLElement {
    if (!element || !(element instanceof HTMLElement)) {
      return false;
    }

    if (element instanceof HTMLTextAreaElement) {
      return true;
    }

    if (element instanceof HTMLInputElement) {
      return !['button', 'submit', 'checkbox', 'radio', 'range', 'color'].includes(
        element.type.toLowerCase()
      );
    }

    return element.isContentEditable;
  }

  function handleFocus(event: FocusEvent) {
    const target = event.target;

    if (!isEditableElement(target)) {
      return;
    }

    lastEditable = target;
    const pending = safeSendMessage({ type: 'ekko/direct-insert/focus' } satisfies EkkoMessage);
    if (pending && typeof (pending as Promise<unknown>).catch === 'function') {
      (pending as Promise<unknown>).catch(() => {
        /* ignore */
      });
    }
  }

  function resolveEditableTarget(): HTMLElement | null {
    if (lastEditable && document.contains(lastEditable)) {
      return lastEditable;
    }

    const activeElement = document.activeElement;
    if (isEditableElement(activeElement)) {
      lastEditable = activeElement;
      return activeElement;
    }

    return null;
  }

  function focusTarget(target: HTMLElement) {
    if (typeof target.focus === 'function') {
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
      }
    }
  }

  function setCaretToEnd(target: HTMLElement) {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const length = target.value.length;
      target.setSelectionRange(length, length);
      return;
    }

    if (target.isContentEditable) {
      const selection = target.ownerDocument.getSelection();
      if (!selection) {
        return;
      }
      selection.removeAllRanges();
      const range = target.ownerDocument.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      selection.addRange(range);
    }
  }

  function replaceEntireValue(target: HTMLElement, transcript: string): boolean {
    focusTarget(target);

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.value = transcript;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      setCaretToEnd(target);
      return true;
    }

    if (target.isContentEditable) {
      target.textContent = transcript;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      setCaretToEnd(target);
      return true;
    }

    return false;
  }

  function insertAtCaret(target: HTMLElement, transcript: string): boolean {
    focusTarget(target);

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      const before = target.value.slice(0, start);
      const after = target.value.slice(end);
      const nextValue = `${before}${transcript}${after}`;
      const caretPos = start + transcript.length;
      target.value = nextValue;
      target.setSelectionRange(caretPos, caretPos);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    if (target.isContentEditable) {
      const selection = target.ownerDocument.getSelection();
      if (selection && selection.rangeCount > 0 && target.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const textNode = target.ownerDocument.createTextNode(transcript);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }

      target.append(transcript);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      setCaretToEnd(target);
      return true;
    }

    return false;
  }

  function applyTranscript(transcript: string, mode: 'replace' | 'insert' = 'replace'): boolean {
    const target = resolveEditableTarget();
    if (!target) {
      return false;
    }

    if (mode === 'insert') {
      return insertAtCaret(target, transcript);
    }

    return replaceEntireValue(target, transcript);
  }

  function enableListeners() {
    document.addEventListener('focusin', handleFocus, true);
  }

  function disableListeners() {
    document.removeEventListener('focusin', handleFocus, true);
    lastEditable = null;
  }

  chrome.runtime.onMessage.addListener((message: EkkoMessage, _sender, sendResponse) => {
    let handled = false;
    let success = false;
    switch (message.type) {
      case 'ekko/direct-insert/toggle':
        directInsertEnabled = message.payload.enabled;
        if (directInsertEnabled) {
          enableListeners();
        } else {
          disableListeners();
        }
        handled = true;
        success = true;
        break;
      case 'ekko/direct-insert/apply':
        handled = true;
        success = applyTranscript(message.payload.text, 'insert');
        break;
      case 'ekko/transcript/update':
        if (!directInsertEnabled) {
          handled = true;
          success = false;
          break;
        }
        if (message.payload.origin === 'panel') {
          handled = true;
          success = applyTranscript(message.payload.transcript, 'replace');
        }
        break;
      default:
        break;
    }

    if (handled) {
      sendResponse?.({ success });
      return true;
    }

    return undefined;
  });

  const bootstrap = safeSendMessage({ type: 'ekko/direct-insert/query' } satisfies EkkoMessage);
  if (bootstrap && typeof (bootstrap as Promise<unknown>).then === 'function') {
    (bootstrap as Promise<EkkoResponse | undefined>)
      .then((response) => {
        if (!response || !response.ok || !response.data || typeof response.data !== 'object') {
          return;
        }
        const enabled = !!(response.data as { enabled?: boolean }).enabled;
        directInsertEnabled = enabled;
        if (directInsertEnabled) {
          enableListeners();
        }
      })
      .catch(() => {
        /* ignore */
      });
  }
}
