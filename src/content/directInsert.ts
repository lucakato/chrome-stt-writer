import { EkkoMessage, EkkoResponse } from '@shared/messages';
import type { ComposeDraftFields } from '@shared/compose';

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

  function isSubjectField(element: HTMLElement): boolean {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const label = `${element.getAttribute('aria-label') ?? ''} ${element.placeholder ?? ''} ${element.name ?? ''}`.toLowerCase();
      return label.includes('subject');
    }

    if (element.isContentEditable) {
      const aria = (element.getAttribute('aria-label') ?? '').toLowerCase();
      if (aria.includes('subject')) {
        return true;
      }
    }

    return false;
  }

  function findSubjectField(reference?: HTMLElement | null): HTMLElement | null {
    if (reference && isSubjectField(reference)) {
      return reference;
    }

    const selectors = [
      'input[aria-label*="subject" i]',
      'input[name*="subject" i]',
      'textarea[aria-label*="subject" i]',
      'textarea[name*="subject" i]',
      '[contenteditable="true"][aria-label*="subject" i]'
    ];

    const roots: Array<HTMLElement | Document> = [];

    const scopedRoot = reference?.closest<HTMLElement>('form, [role="dialog"], [role="region"], [data-message-id]');
    if (scopedRoot) {
      roots.push(scopedRoot);
    }
    if (document.body) {
      roots.push(document.body);
    }

    for (const root of roots) {
      for (const selector of selectors) {
        const scope = root instanceof HTMLElement ? root : document;
        const candidate = scope.querySelector(selector);
        if (candidate instanceof HTMLElement && isEditableElement(candidate)) {
          return candidate;
        }
      }
    }

    return null;
  }

  function findBodyField(reference?: HTMLElement | null): HTMLElement | null {
    const selectors = [
      '[aria-label*="message body" i]',
      '[aria-label*="compose" i]',
      '[aria-label*="email body" i]',
      '[aria-label*="write your message" i]',
      '[role="textbox"][aria-label*="message" i]'
    ];

    const roots: Array<HTMLElement | Document> = [];
    const scopedRoot = reference?.closest<HTMLElement>('form, [role="dialog"], [role="region"], [data-message-id]');
    if (scopedRoot) {
      roots.push(scopedRoot);
    }
    if (document.body) {
      roots.push(document.body);
    }

    for (const root of roots) {
      for (const selector of selectors) {
        const scope = root instanceof HTMLElement ? root : document;
        const candidate = scope.querySelector(selector);
        if (candidate instanceof HTMLElement && isEditableElement(candidate) && !isSubjectField(candidate)) {
          return candidate;
        }
      }

      const fallback = (root instanceof HTMLElement ? root : document).querySelector(
        'div[contenteditable="true"], textarea, input[type="text"]'
      );
      if (fallback instanceof HTMLElement && isEditableElement(fallback) && !isSubjectField(fallback)) {
        return fallback;
      }
    }

    return null;
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

  function normalizeParagraph(paragraph: string): string {
    const normalized = paragraph.replace(/\r\n?/g, '\n');
    const withoutTrailingSpaces = normalized.replace(/[ \t]+$/gm, '');
    return withoutTrailingSpaces.replace(/^\n+|\n+$/g, '');
  }

  function normalizeParagraphs(paragraphs: string[]): string[] {
    return paragraphs
      .map((paragraph) => (typeof paragraph === 'string' ? normalizeParagraph(paragraph) : ''))
      .filter((paragraph) => paragraph.length > 0);
  }

  function joinParagraphs(paragraphs: string[]): string {
    return normalizeParagraphs(paragraphs).join('\n\n');
  }

  const GREETING_PATTERN = /^(hi|hello|dear|greetings|hey)\b/i;
  const SIGN_OFF_PATTERN =
    /(thanks|thank you|best|regards|cheers|sincerely|kind regards|warm regards|appreciate it)[,!.\s]*$/i;

  function deriveParagraphsFromContent(text: string): string[] {
    const lines = text.replace(/\r/g, '').split('\n');

    const paragraphs: string[] = [];
    let current: string[] = [];

    const flushCurrent = () => {
      const joined = current.join('\n').replace(/^[\n]+|[\n]+$/g, '');
      const normalized = normalizeParagraph(joined);
      if (normalized.length > 0) {
        paragraphs.push(normalized);
      }
      current = [];
    };

    const pushParagraph = (value: string) => {
      const normalized = normalizeParagraph(value);
      if (normalized.length > 0) {
        paragraphs.push(normalized);
      }
    };

    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index];
      const trimmedLine = rawLine.trim();

      if (!trimmedLine) {
        flushCurrent();
        continue;
      }

      const isGreeting =
        paragraphs.length === 0 && current.length === 0 && GREETING_PATTERN.test(trimmedLine);
      const isSignOff = SIGN_OFF_PATTERN.test(trimmedLine);
      const looksLikeName = !trimmedLine.includes(' ') || trimmedLine.split(/\s+/).length <= 3;
      const prevWasSignOff =
        paragraphs.length > 0 && SIGN_OFF_PATTERN.test(paragraphs[paragraphs.length - 1]);

      const lineForStorage = rawLine.replace(/[ \t]+$/g, '');

      if (isGreeting) {
        flushCurrent();
        pushParagraph(lineForStorage.trimStart());
        continue;
      }

      if (isSignOff) {
        flushCurrent();
        pushParagraph(lineForStorage.trimStart());
        continue;
      }

      if (prevWasSignOff && looksLikeName) {
        flushCurrent();
        pushParagraph(lineForStorage.trimStart());
        continue;
      }

      current.push(lineForStorage);
    }

    flushCurrent();

    if (paragraphs.length === 0 && text.trim().length > 0) {
      return [normalizeParagraph(text)];
    }

    return paragraphs;
  }

  function setContentEditableParagraphs(target: HTMLElement, paragraphs: string[]) {
    const doc = target.ownerDocument;
    target.innerHTML = '';
    const normalized = normalizeParagraphs(paragraphs);
    const blocks = normalized.length > 0 ? normalized : [''];

    blocks.forEach((paragraph, index) => {
      const block = doc.createElement('div');
      const trimmed = paragraph;
      if (!trimmed) {
        block.appendChild(doc.createElement('br'));
      } else {
        const lines = trimmed.split(/\r?\n/);
        lines.forEach((line, lineIndex) => {
          if (lineIndex > 0) {
           block.appendChild(doc.createElement('br'));
         }
         block.appendChild(doc.createTextNode(line));
       });
      }
      target.appendChild(block);

      if (index < blocks.length - 1) {
        target.appendChild(doc.createElement('br'));
      }
    });

    if (blocks.length === 0) {
      const block = doc.createElement('div');
      block.appendChild(doc.createElement('br'));
      target.appendChild(block);
    }
  }

  function replaceEntireValue(target: HTMLElement, transcript: string, paragraphs?: string[]): boolean {
    focusTarget(target);

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.value = transcript;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      setCaretToEnd(target);
      return true;
    }

    if (target.isContentEditable) {
      const blocks =
        paragraphs && paragraphs.length > 0
          ? normalizeParagraphs(paragraphs)
          : deriveParagraphsFromContent(transcript.trim());
      setContentEditableParagraphs(target, blocks);
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

        if (transcript.includes('\n')) {
          const pieces = transcript.replace(/\r/g, '').split('\n');
          const fragment = target.ownerDocument.createDocumentFragment();
          pieces.forEach((line, index) => {
            if (index > 0) {
              fragment.appendChild(target.ownerDocument.createElement('br'));
            }
            fragment.appendChild(target.ownerDocument.createTextNode(line));
          });
          range.insertNode(fragment);
        } else {
          const textNode = target.ownerDocument.createTextNode(transcript);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.setEndAfter(textNode);
        }

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

  function applyDraft(draft: ComposeDraftFields): boolean {
    const content = typeof draft.content === 'string' ? draft.content.trim() : '';
    const subjectText = typeof draft.subject === 'string' ? draft.subject.trim() : '';
    const providedParagraphs = Array.isArray(draft.paragraphs)
      ? draft.paragraphs
          .map((entry) => (typeof entry === 'string' ? normalizeParagraph(entry) : ''))
          .filter((entry) => entry.length > 0)
      : [];

    const normalizedProvided = providedParagraphs.length > 0 ? normalizeParagraphs(providedParagraphs) : [];
    const derivedFromContent = deriveParagraphsFromContent(content);
    const paragraphs =
      normalizedProvided.length > 0 && joinParagraphs(normalizedProvided).trim() === content.trim()
        ? normalizedProvided
        : derivedFromContent;
    const formattedContent = joinParagraphs(paragraphs);

    if (!formattedContent && !subjectText) {
      return false;
    }

    const active = resolveEditableTarget();
    let subjectTarget: HTMLElement | null = subjectText ? findSubjectField(active) : null;

    if (subjectText && active && isSubjectField(active)) {
      subjectTarget = active;
    }

    let bodyTarget: HTMLElement | null = formattedContent ? active ?? null : null;

    if (bodyTarget && subjectTarget && bodyTarget === subjectTarget) {
      const alternate = findBodyField(subjectTarget);
      if (alternate && alternate !== subjectTarget) {
        bodyTarget = alternate;
      }
    }

    if (!bodyTarget && formattedContent) {
      bodyTarget = findBodyField(subjectTarget ?? active ?? null);
    }

    if (!bodyTarget && formattedContent) {
      bodyTarget = active ?? findBodyField(null);
    }

    let applied = false;

    if (subjectTarget && subjectText) {
      applied = replaceEntireValue(subjectTarget, subjectText) || applied;
    }

    if (bodyTarget && formattedContent) {
      applied = replaceEntireValue(bodyTarget, formattedContent, paragraphs) || applied;
    }

    if (!applied && formattedContent) {
      const target = resolveEditableTarget();
      if (target) {
        return replaceEntireValue(target, formattedContent, paragraphs);
      }
    }

    return applied;
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
        if (message.payload && typeof message.payload === 'object' && 'draft' in message.payload && message.payload.draft) {
          const draftPayload = message.payload.draft as ComposeDraftFields;
          success = applyDraft({
            content: typeof draftPayload.content === 'string' ? draftPayload.content : '',
            subject: typeof draftPayload.subject === 'string' ? draftPayload.subject : undefined,
            paragraphs: Array.isArray(draftPayload.paragraphs) ? draftPayload.paragraphs : undefined
          });
        } else if (
          message.payload &&
          typeof message.payload === 'object' &&
          typeof (message.payload as { text?: unknown }).text === 'string'
        ) {
          success = applyTranscript((message.payload as { text: string }).text, 'insert');
        } else {
          success = false;
        }
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
