export type EkkoMessage =
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
        output: string;
      };
    }
  | {
      type: 'ekko/direct-insert/apply';
      payload: {
        text: string;
      };
    }
  | {
      type: 'ekko/direct-insert/focus';
      payload?: Record<string, never>;
    }
  | {
      type: 'ekko/direct-insert/query';
      payload?: Record<string, never>;
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
      payload: {
        text: string;
      };
    };

export type EkkoResponse =
  | {
      ok: true;
      data?: unknown;
    }
  | {
      ok: false;
      error: string;
    };
