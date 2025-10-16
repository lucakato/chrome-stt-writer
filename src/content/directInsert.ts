import { EkkoMessage } from '@shared/messages';

let directInsertEnabled = false;
let lastEditable: HTMLElement | null = null;

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

  if (isEditableElement(target)) {
    lastEditable = target;
  } else {
    lastEditable = null;
  }
}

function applyTranscript(transcript: string) {
  if (!lastEditable) {
    return;
  }

  if (lastEditable instanceof HTMLInputElement || lastEditable instanceof HTMLTextAreaElement) {
    lastEditable.value = transcript;
    lastEditable.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (lastEditable.isContentEditable) {
    lastEditable.innerText = transcript;
    lastEditable.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function enableListeners() {
  document.addEventListener('focusin', handleFocus, true);
}

function disableListeners() {
  document.removeEventListener('focusin', handleFocus, true);
  lastEditable = null;
}

chrome.runtime.onMessage.addListener((message: EkkoMessage) => {
  switch (message.type) {
    case 'ekko/direct-insert/toggle':
      directInsertEnabled = message.payload.enabled;
      if (directInsertEnabled) {
        enableListeners();
      } else {
        disableListeners();
      }
      break;
    case 'ekko/direct-insert/apply':
      applyTranscript(message.payload.text);
      break;
    case 'ekko/transcript/update':
      if (!directInsertEnabled) {
        return;
      }
      if (message.payload.origin === 'panel') {
        applyTranscript(message.payload.transcript);
      }
      break;
    default:
      break;
  }
});
