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
        transcriptId: string;
      };
    }
  | {
      type: 'ekko/ai/rewrite';
      payload: {
        transcriptId: string;
        preset: string;
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
