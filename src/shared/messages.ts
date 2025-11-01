import type { ComposeDraftFields } from '@shared/compose';

export type DirectInsertPayload = {
  text?: string;
  draft?: ComposeDraftFields;
};

export type ComposeOutputPayload = ComposeDraftFields & { raw?: string };

export type EchoMessage =
  | {
      type: 'ekko/direct-insert/toggle';
      payload: {
        enabled: boolean;
      };
    }
  | {
      type: 'ekko/transcript/update';
      payload: {
        transcript: string;
        origin: 'panel' | 'content';
      };
    }
  | {
      type: 'ekko/ai/summarize';
      payload: {
        sessionId?: string;
        transcript: string;
        summary: string;
      };
    }
  | {
      type: 'ekko/ai/rewrite';
      payload: {
        sessionId?: string;
        preset: string;
        transcript: string;
        rewrite: string;
      };
    }
  | {
      type: 'ekko/ai/compose';
      payload: {
        sessionId?: string;
        preset: string;
        instructions?: string;
        output: ComposeOutputPayload;
      };
    }
  | {
      type: 'ekko/direct-insert/apply';
      payload: DirectInsertPayload;
    }
  | {
      type: 'ekko/direct-insert/focus';
      payload?: Record<string, never>;
    }
  | {
      type: 'ekko/direct-insert/restore';
      payload?: Record<string, never>;
    }
  | {
      type: 'ekko/direct-insert/query';
      payload?: Record<string, never>;
    }
  | {
      type: 'ekko/direct-insert/initialized';
      payload?: {
        enabled: boolean;
      };
    }
  | {
      type: 'ekko/sidepanel/open';
      payload?: {
        action?: 'toggle' | 'open' | 'close';
        windowId?: number;
      };
    }
  | {
      type: 'ekko/sidepanel/state';
      payload: {
        open: boolean;
        tabId?: number;
        windowId?: number;
      };
    }
  | {
      type: 'ekko/widget/insert';
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
