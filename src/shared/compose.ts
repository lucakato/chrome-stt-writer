export type ComposeDraftFields = {
  subject?: string;
  content: string;
  paragraphs?: string[];
};

export type ComposeDraftResult = ComposeDraftFields & {
  raw: string;
};

export const COMPOSE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    subject: {
      type: 'string',
      description:
        'Subject line or title summarizing the draft. Use an empty string when no subject is needed.'
    },
    content: {
      type: 'string',
      description:
        'Full body text to insert into the page. Separate logical paragraphs with double newline characters.'
    },
    paragraphs: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'string',
        description: 'One paragraph, greeting, or sign-off. Do not include leading or trailing whitespace.'
      },
      description:
        'Ordered list of paragraphs for the draft. Include greetings, body text, sign-off, and signature as separate entries.'
    }
  },
  required: ['subject', 'content', 'paragraphs'],
  additionalProperties: false
};

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) {
    return raw;
  }

  const withoutFence = trimmed.replace(/^```[a-z]*\s*/i, '');
  const fenceIndex = withoutFence.lastIndexOf('```');
  if (fenceIndex >= 0) {
    return withoutFence.slice(0, fenceIndex).trim();
  }

  return withoutFence.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeContent(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function sanitizeSubject(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function sanitizeParagraphs(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? normalizeParagraph(entry) : ''))
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : null;
}

function normalizeParagraph(paragraph: string): string {
  const normalized = paragraph.replace(/\r\n?/g, '\n');
  const withoutTrailingSpaces = normalized.replace(/[ \t]+$/gm, '');
  return withoutTrailingSpaces.replace(/^\n+|\n+$/g, '');
}

export function joinParagraphs(paragraphs: string[]): string {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
    return '';
  }
  return paragraphs.join('\n\n');
}

const GREETING_PATTERN = /^(hi|hello|dear|greetings|hey)\b/i;
const SIGN_OFF_PATTERN =
  /(thanks|thank you|best|regards|cheers|sincerely|kind regards|warm regards|appreciate it)[,!.\s]*$/i;

function deriveParagraphs(text: string): string[] {
  const lines = text.replace(/\r/g, '').split('\n');

  const paragraphs: string[] = [];
  let current: string[] = [];

  const flushCurrent = () => {
    const joined = current.join('\n').replace(/^\n+|\n+$/g, '');
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
    const line = rawLine.trim();

    if (!line) {
      flushCurrent();
      continue;
    }

    const isGreeting = paragraphs.length === 0 && current.length === 0 && GREETING_PATTERN.test(line);
    const isSignOff = SIGN_OFF_PATTERN.test(line);
    const looksLikeName = !line.includes(' ') || line.split(/\s+/).length <= 3;
    const prevWasSignOff = paragraphs.length > 0 && SIGN_OFF_PATTERN.test(paragraphs[paragraphs.length - 1]);

    const trimmedLineForStorage = rawLine.replace(/[ \t]+$/g, '');

    if (isGreeting) {
      flushCurrent();
      pushParagraph(trimmedLineForStorage.trimStart());
      continue;
    }

    if (isSignOff) {
      flushCurrent();
      pushParagraph(trimmedLineForStorage.trimStart());
      continue;
    }

    if (prevWasSignOff && looksLikeName) {
      flushCurrent();
      pushParagraph(trimmedLineForStorage.trimStart());
      continue;
    }

    current.push(trimmedLineForStorage);
  }

  flushCurrent();

  if (paragraphs.length === 0 && text.trim().length > 0) {
    return [normalizeParagraph(text)];
  }

  return paragraphs;
}

export function deriveParagraphsFromContent(text: string): string[] {
  return deriveParagraphs(text);
}

function deriveFallbackSubject(paragraphs: string[] | undefined, content: string): string {
  const source = (paragraphs && paragraphs.length > 0 ? paragraphs[0] : content) ?? '';
  const cleaned = source.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return '';
  }
  if (cleaned.length <= 80) {
    return cleaned;
  }
  return `${cleaned.slice(0, 77).trimEnd()}…`;
}

export function createFallbackDraft(text: string): ComposeDraftResult {
  const normalized = text.trim();
  const paragraphs = deriveParagraphsFromContent(normalized);
  return {
    subject: deriveFallbackSubject(paragraphs, normalized),
    content: joinParagraphs(paragraphs),
    paragraphs,
    raw: text
  };
}

export function normalizeComposeDraftResult(draft: ComposeDraftResult): ComposeDraftResult {
  const rawContent = sanitizeContent(draft.content) ?? '';
  const providedParagraphs = sanitizeParagraphs(draft.paragraphs) ?? [];

  let normalizedParagraphs: string[];

  if (providedParagraphs.length > 0) {
    if (rawContent && joinParagraphs(providedParagraphs).trim() !== rawContent.trim()) {
      normalizedParagraphs = deriveParagraphsFromContent(rawContent);
    } else {
      normalizedParagraphs = providedParagraphs;
    }
  } else if (rawContent) {
    normalizedParagraphs = deriveParagraphsFromContent(rawContent);
  } else {
    normalizedParagraphs = [];
  }

  const normalizedContent =
    normalizedParagraphs.length > 0 ? joinParagraphs(normalizedParagraphs).trim() : rawContent.trim();

  const normalizedSubject = sanitizeSubject(draft.subject);

  return {
    raw: draft.raw,
    content: normalizedContent,
    subject: normalizedSubject,
    paragraphs: normalizedParagraphs
  };
}

export function coerceComposeDraft(value: unknown): ComposeDraftResult | null {
  if (typeof value === 'string') {
    return parseComposeDraftFromJson(value);
  }

  if (isPlainObject(value)) {
    const raw = JSON.stringify(value);
    const tentativeSubject =
      sanitizeSubject(value.subject) ??
      sanitizeSubject((value as { title?: unknown }).title) ??
      sanitizeSubject((value as { headline?: unknown }).headline);
    const paragraphs =
      sanitizeParagraphs((value as { paragraphs?: unknown }).paragraphs) ??
      sanitizeParagraphs((value as { bodyParagraphs?: unknown }).bodyParagraphs);
    const contentCandidate =
      sanitizeContent(value.content) ??
      sanitizeContent((value as { body?: unknown }).body) ??
      sanitizeContent((value as { message?: unknown }).message);
    const resolvedParagraphs = resolveParagraphs(paragraphs, contentCandidate);
    const resolvedContent = contentCandidate ?? joinParagraphs(resolvedParagraphs);

    if (!resolvedContent) {
      return null;
    }

    return {
      subject: tentativeSubject || deriveFallbackSubject(resolvedParagraphs, resolvedContent),
      content: resolvedContent,
      paragraphs: resolvedParagraphs,
      raw
    };
  }

  return null;
}

export function parseComposeDraftFromJson(raw: string): ComposeDraftResult | null {
  const cleaned = stripCodeFence(raw);
  if (!cleaned.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!isPlainObject(parsed)) {
      return null;
    }
    const tentativeSubject =
      sanitizeSubject(parsed.subject) ??
      sanitizeSubject((parsed as { title?: unknown }).title) ??
      sanitizeSubject((parsed as { headline?: unknown }).headline);
    const paragraphs =
      sanitizeParagraphs((parsed as { paragraphs?: unknown }).paragraphs) ??
      sanitizeParagraphs((parsed as { bodyParagraphs?: unknown }).bodyParagraphs);
    const contentCandidate =
      sanitizeContent(parsed.content) ??
      sanitizeContent((parsed as { body?: unknown }).body) ??
      sanitizeContent((parsed as { message?: unknown }).message);
    const resolvedParagraphs = resolveParagraphs(paragraphs, contentCandidate);
    const resolvedContent = contentCandidate ?? joinParagraphs(resolvedParagraphs);

    if (!resolvedContent) {
      return null;
    }

    return {
      subject: tentativeSubject || deriveFallbackSubject(resolvedParagraphs, resolvedContent),
      content: resolvedContent,
      paragraphs: resolvedParagraphs,
      raw: cleaned
    };
  } catch {
    return null;
  }
}

function resolveParagraphs(paragraphs: string[] | null, content: string | null): string[] {
  if (content && (!paragraphs || paragraphs.length === 0)) {
    return deriveParagraphsFromContent(content);
  }

  if (paragraphs && paragraphs.length > 0 && content) {
    const joined = joinParagraphs(paragraphs);
    if (joined.trim() === content.trim()) {
      return paragraphs;
    }
    return deriveParagraphsFromContent(content);
  }

  if (paragraphs && paragraphs.length > 0) {
    return paragraphs;
  }

  return [];
}

export function composeDraftToClipboardText(draft: ComposeDraftFields): string {
  const subject = draft.subject?.trim();
  const content = draft.paragraphs && draft.paragraphs.length > 0 ? joinParagraphs(draft.paragraphs) : draft.content;
  return subject ? `${subject}\n\n${content}` : content;
}

export { deriveParagraphsFromContent as deriveParagraphs };
