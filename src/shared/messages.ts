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
