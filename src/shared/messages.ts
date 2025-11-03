import type { ComposeDraftFields } from '@shared/compose';

export type DirectInsertPayload = {
  text?: string;
  draft?: ComposeDraftFields;
};

export type ComposeOutputPayload = ComposeDraftFields & { raw?: string };

export type EchoMessage =
  | {
      type: 'echo/direct-insert/toggle';
      payload: {
        enabled: boolean;
      };
    }
  | {
      type: 'echo/transcript/update';
      payload: {
        transcript: string;
        origin: 'panel' | 'content';
      };
    }
  | {
      type: 'echo/ai/summarize';
      payload: {
        sessionId?: string;
        transcript: string;
        summary: string;
      };
    }
  | {
      type: 'echo/ai/rewrite';
      payload: {
        sessionId?: string;
        preset: string;
        transcript: string;
        rewrite: string;
      };
    }
  | {
      type: 'echo/ai/compose';
      payload: {
        sessionId?: string;
        preset: string;
        instructions?: string;
        output: ComposeOutputPayload;
      };
    }
  | {
      type: 'echo/direct-insert/apply';
      payload: DirectInsertPayload;
    }
  | {
      type: 'echo/direct-insert/focus';
      payload?: Record<string, never>;
    }
  | {
      type: 'echo/direct-insert/query';
      payload?: Record<string, never>;
    }
  | {
      type: 'echo/direct-insert/initialized';
      payload?: {
        enabled: boolean;
      };
    }
  | {
      type: 'echo/sidepanel/open';
      payload?: {
        action?: 'toggle' | 'open' | 'close';
        windowId?: number;
      };
    }
  | {
      type: 'echo/sidepanel/state';
      payload: {
        open: boolean;
        tabId?: number;
        windowId?: number;
      };
    }
  | {
      type: 'echo/widget/insert';
      payload: DirectInsertPayload;
    };

export type EchoResponse =
  | {
      ok: true;
      data?: unknown;
    }
  | {
      ok: false;
      error: string;
    };
