# Ekko: Write with Voice

## Problem & Vision
- Knowledge workers and students often jot down voice notes during research or meetings but rarely convert them into actionable, polished text.
- Vision: Ekko: Write with Voice provides a Chrome side panel that captures voice input in real time, and lets users either transcribe speech literally (Web Speech API) or route captured audio into the Prompt API so Gemini Nano can answer or draft content on their behalf before handing off to summarizer/rewriter flows.
- Success metrics: time-to-first-draft reduction, % of notes summarized or polished, user satisfaction with rewrite presets, and daily active sessions across both Transcribe and Compose (Prompt) modes.

## Target Personas
- **Meeting multitasker** needing quick voice capture while browsing shared docs or project dashboards.
- **Research-heavy student** narrating thoughts while reading articles in Chrome.
- Both want low-friction capture, privacy-first processing, and quick ways to turn rough speech into clean text.

## Core User Journeys
- **Capture & Transcribe**: User opens side panel → presses “Record” → Web Speech API transcribes locally → live text appears in editor with confidence indicators.
- **Voice Compose (Prompt API)**: User switches to “Compose with AI” mode → hits “Ask” → app records a short utterance (MediaRecorder) → Prompt API session receives `{text + audio}` input instructing Gemini Nano what to produce → streamed response populates a new draft panel (email, summary, next steps, etc.) with options to copy, insert, or retry.
- **Summarize**: User taps “Summarize” once transcription is complete → built-in Summarizer API condenses the note, outputs inline summary block beneath original text.
- **Polish**: User selects rewrite tone (Shorter, Longer, Formal, Casual, Bullet list, Action items) → clicks “Polish” → built-in Rewriter API rewrites the transcribed text; user can accept, copy, or revert.
- **Direct Insert Mode**: User focuses any editable field (URL bar, Gmail composer, doc comment) → activates Ekko mic → live transcription streams into side-panel editor and, with user consent, mirrors into the active DOM element so text appears where they are typing; summarize/rewriter actions can then replace or append within that field.
- **Session Management**: Users can save transcripts, summaries, and rewrites as entries in a local history list, tag them, or export to clipboard/Downloads.
- **Mode Onboarding**: First-run dialog explains Transcribe vs Compose, lists typical use cases (verbatim notes vs let Gemini draft for you), and remembers the last-used mode per domain/session.

## Feature Set
- Mode switcher that distinguishes **Transcribe (Web Speech API)** from **Compose (Prompt API)**, with persistent choice and contextual tooltips.
- Live transcription using Web Speech API (with start/stop hotkeys, microphone permissions guidance, language selection).
- Summaries via `chrome.ai.summarizer.summarize()` tailored to short-form note context.
- Rewrites via `chrome.ai.rewriter.rewrite()` with preset prompt templates and optional custom instruction field.
- Prompt API sessions (`LanguageModel.create`) with audio-enabled prompts for free-form requests; streams responses into a compose buffer with quick actions (insert, copy, retry, follow-up).
- Floating Ekko widget injected via content script on every page (toggleable from settings) with quick-record controls, mode switch, prompt editor, and re-generate action.
- Transcript editor with inline controls: highlight errors, quick voice command to insert punctuation, undo/redo.
- Notes history panel with timestamp, active tab URL, applied actions (summarized, polished, composed).
- Quick export: copy to clipboard, download Markdown/plain text, or auto-insert into active text field (if user permits).
- Direct-insert bridge: content script channel mirrors live transcription and AI outputs into the user’s currently focused editable element when toggled on.

## Built-in AI Integration
- Summarizer API is fully shipped in Chrome 138 stable; follow the official doc at https://developer.chrome.com/docs/ai/summarizer-api for availability checks (`Summarizer.availability()`), model download triggers (`Summarizer.create()`), and streaming/batch usage patterns.
- The Rewriter API remains in origin trial (Chrome 137–142) per https://developer.chrome.com/docs/ai/rewriter-api; register the extension ID, retrieve a token, and include it under the MV3 `origin_trials` manifest key (choose the extension registration path, leave “Third-party matching” unchecked, estimate usage in the 0–10k range for early pilots, and lock the ID via the manifest `"key"` field before registering).
- Prompt API (Chrome 138+ for extensions) replaces the older `aiLanguageModelOriginTrial` permission; rely on `LanguageModel.availability()` with the exact `expectedInputs`/`expectedOutputs` planned. Audio + multimodal input currently requires the `AIPromptAPIMultimodalInput` origin trial token in the manifest’s `origin_trials` array.
- When capturing audio for Prompt API, convert the `MediaRecorder` blob to an `ArrayBuffer` and send prompts like:
  ```ts
  const params = await LanguageModel.params();
  const session = await LanguageModel.create({ expectedInputs: [{ type: "audio" }], topK: params.defaultTopK });
  const stream = session.promptStreaming([{
    role: "user",
    content: [
      { type: "text", value: "You are an assistant that drafts formal emails." },
      { type: "audio", value: audioBuffer }
    ]
  }]);
  ```
  Stream responses into compose UI; fall back to text-only prompting if audio support returns `NotSupportedError`.
- Initialize `chrome.ai.summarizer` / `chrome.ai.rewriter` instances lazily; cache availability state, listen for download progress, and respect hardware constraints (desktop Chrome, Gemini Nano requirements: Win10/11, macOS 13+, Linux, ChromeOS Chromebook Plus, ≥22 GB free storage, ≥16 GB RAM when CPU-bound).
- Define prompt templates per rewrite preset (e.g., “Rewrite the provided text to be concise and formal, suitable for an executive email”).
- Handle failure states gracefully: show retry option, surface specific errors (e.g., `NotSupportedError` when origin trial absent), and offer fallbacks when APIs unavailable.
- No server-side AI calls; all inference stays on-device in line with Chrome’s built-in AI policies; adhere to Google’s Generative AI Prohibited Uses policy before shipping.

## Speech Input Pipelines
- **Transcribe mode (Web Speech API)**: Use Web Speech recognition for live text; detect microphone availability and handle permission prompts. Provide language selector (default browser locale, top supported languages), display confidence/alternatives, support auto-punctuation, manual corrections, and rolling 3-minute capture windows. When Direct Insert Mode is enabled, stream deltas into the focused field while the side panel maintains the canonical transcript.
- **Compose mode (Prompt API)**: Record short utterances (default 10–15 seconds) via `MediaRecorder`, surface countdown/progress UI, and immediately convert chunks to `ArrayBuffer` for Prompt API sessions. Prepend system instructions that explain the task (draft email, brainstorm ideas) and append follow-up prompts for iterative refinement. Offer quick re-record if the utterance is unclear, and allow adding typed clarifications before resubmitting to the session.
- **Floating widget compose loop**: Reuse the latest transcript and compose prompt in the popup, and when “Re-generate” is pressed, append an assistant prefix with `prefix: true` so Gemini continues the previous output using the updated hint (“Not what you want? Assist the AI.”).

## UI & UX
- Side panel React app (TypeScript) for persistent workspace.
- Floating Ekko icon in-page (bottom-right by default, dismissible from settings) opens a compact popup with mic control, mode toggle (syncs with side panel), prompt textbox (compose only), settings launcher, and re-generate button.
- Layout: mode switcher (Transcribe vs Compose) anchored above the editor, with context-specific controls underneath (live transcript editor vs compose response viewer), shared AI actions toolbar (Summarize, Polish with dropdown, Copy/Insert), history drawer (bottom/right).
- Visual states for recording (waveform animation for Web Speech, radial countdown for Prompt capture), processing (spinner/stream indicator), success, and errors.
- Mode-specific helper text: Transcribe highlights “Verbatim capture” while Compose says “Gemini drafts for you.” Include inline chips for frequent Compose intents (Email, Summary, Action plan) that adjust the system prompt.
- Keyboard shortcuts: `Ctrl+Shift+.` start/stop recording, `Ctrl+Shift+S` summarize, `Ctrl+Shift+R` polish with last preset.
- Accessibility: ARIA labels, focus management, captions for audio status, high-contrast theme toggle.
- Branding: Ekko palette anchors on primary `#5968F2` for call-to-action elements and accent `#AEB6FF` for backgrounds, focus rings, and hover states to keep the interface cohesive.

## Data Handling & Privacy
- Store transcripts, summaries, compose outputs, and preset preferences in `chrome.storage.local` (optional sync toggle).
- Allow users to clear history and toggle auto-save per session.
- All AI inference (summarizer/rewriter/prompt, STT) occurs locally in the browser; clearly communicate this in onboarding and mode tooltips.
- No audio files stored unless user explicitly exports; Prompt mode buffers audio in-memory for the current request only and discards after response, mirroring the “no audio storage” policy from Transcribe mode.

## Architecture Overview
- Manifest V3 extension with:
  - Background service worker managing storage utilities, keyboard shortcuts, and fallback logic.
  - Side panel React app as primary UI.
  - Content-script overlay that renders the floating Ekko widget inside each frame.
- Modules: speech controller, transcription store, Prompt session manager (LanguageModel lifecycle, prompt templates), AI orchestration service, history manager, settings manager.
- Permissions: `sidePanel`, `storage`, optional `commands`, and `scripting`/`activeTab` to enable the direct-insert bridge safely.
- Manifest: configure `origin_trials` with the Rewriter token and the Prompt API multimodal token; guard usage paths to degrade gracefully once a trial window closes or audio input is unsupported.
- Utilize Vite/ESBuild for bundling; ensure MV3 CSP compliance (no inline scripts).

## Implementation Roadmap
1. Scaffold MV3 extension with React side panel, storage utilities, microphone permission checks.
2. Build Web Speech transcription module with live editor and basic history.
3. Add Prompt API compose flow: request multimodal origin trial token, implement MediaRecorder capture, session management, streaming UI, and follow-up prompts.
4. Integrate Summarizer API (Chrome 138+): implement availability checks, trigger model download, and wire streaming summaries.
5. Secure Rewriter origin trial token for the extension ID, inject via `origin_trials`, then integrate rewrite presets with error handling.
6. Implement floating widget content script with mic controls, prompt editor, and direct insert coordination.
7. Implement history management, tagging, and export options (including composed outputs).
8. Polish UX: keyboard shortcuts, onboarding, accessibility, floating widget styling, and Ekko theming anchored in `#5968F2`/`#AEB6FF`.
9. Testing, performance tuning, and packaging.

## Testing & Validation
- Unit tests for storage, AI wrapper utilities, transcription state machine (mock Web Speech), and Prompt session manager (mock LanguageModel interactions).
- Integration tests with Puppeteer + Chrome for record → summarize → rewrite and compose → insert flows, including fallbacks when Prompt API audio unavailable.
- Manual QA matrix: microphone permissions, unsupported languages, AI APIs disabled, long dictations, rapid toggling between modes/actions, repeated compose follow-ups, session persistence after browser restart, floating widget interactions across iframes/privileged pages.
- Performance: ensure transcription updates don’t lag; debounce calls to AI APIs to avoid race conditions; monitor Prompt streaming UI for backpressure when audio clips are large.

## Open Questions
- Should we auto-stop recording after silence or let users configure silence timeout?
- Do we capture page context (URL/title) automatically for history entries?
- Should history sync across devices using `chrome.storage.sync`, or remain local-only until requested?
- How do we cap Prompt mode recording length without making users feel rushed (e.g., 15s default with retry)?
- What default system prompts best balance helpful drafting with privacy/safety (email vs note vs ideation)?
