# Ekko: Write with Voice

## Problem & Vision
- Knowledge workers and students often jot down voice notes during research or meetings but rarely convert them into actionable, polished text.
- Vision: Ekko: Write with Voice provides a Chrome side panel that captures voice input in real time, transcribes speech locally, and lets users instantly summarize or rewrite the text using Chrome’s built-in AI APIs.
- Success metrics: time-to-first-draft reduction, % of notes summarized or polished, user satisfaction with rewrite presets, and daily active sessions.

## Target Personas
- **Meeting multitasker** needing quick voice capture while browsing shared docs or project dashboards.
- **Research-heavy student** narrating thoughts while reading articles in Chrome.
- Both want low-friction capture, privacy-first processing, and quick ways to turn rough speech into clean text.

## Core User Journeys
- **Capture & Transcribe**: User opens side panel → presses “Record” → Web Speech API transcribes locally → live text appears in editor with confidence indicators.
- **Summarize**: User taps “Summarize” once transcription is complete → built-in Summarizer API condenses the note, outputs inline summary block beneath original text.
- **Polish**: User selects rewrite tone (Shorter, Longer, Formal, Casual, Bullet list, Action items) → clicks “Polish” → built-in Rewriter API rewrites the transcribed text; user can accept, copy, or revert.
- **Direct Insert Mode**: User focuses any editable field (URL bar, Gmail composer, doc comment) → activates Ekko mic → live transcription streams into side-panel editor and, with user consent, mirrors into the active DOM element so text appears where they are typing; summarize/rewriter actions can then replace or append within that field.
- **Session Management**: Users can save transcripts, summaries, and rewrites as entries in a local history list, tag them, or export to clipboard/Downloads.

## Feature Set
- Live transcription using Web Speech API (with start/stop hotkeys, microphone permissions guidance, language selection).
- Summaries via `chrome.ai.summarizer.summarize()` tailored to short-form note context.
- Rewrites via `chrome.ai.rewriter.rewrite()` with preset prompt templates and optional custom instruction field.
- Transcript editor with inline controls: highlight errors, quick voice command to insert punctuation, undo/redo.
- Notes history panel with timestamp, active tab URL, applied actions (summarized, polished).
- Quick export: copy to clipboard, download Markdown/plain text, or auto-insert into active text field (if user permits).
- Direct-insert bridge: content script channel mirrors live transcription and AI outputs into the user’s currently focused editable element when toggled on.

## Built-in AI Integration
- Summarizer API is fully shipped in Chrome 138 stable; follow the official doc at https://developer.chrome.com/docs/ai/summarizer-api for availability checks (`Summarizer.availability()`), model download triggers (`Summarizer.create()`), and streaming/batch usage patterns.
- The Rewriter API remains in origin trial (Chrome 137–142) per https://developer.chrome.com/docs/ai/rewriter-api; register the extension ID, retrieve a token, and include it under the MV3 `origin_trials` manifest key (choose the extension registration path, leave “Third-party matching” unchecked, estimate usage in the 0–10k range for early pilots, and lock the ID via the manifest `"key"` field before registering).
- Initialize `chrome.ai.summarizer` / `chrome.ai.rewriter` instances lazily; cache availability state, listen for download progress, and respect hardware constraints (desktop Chrome, Gemini Nano requirements: Win10/11, macOS 13+, Linux, ChromeOS Chromebook Plus, ≥22 GB free storage, ≥16 GB RAM when CPU-bound).
- Define prompt templates per rewrite preset (e.g., “Rewrite the provided text to be concise and formal, suitable for an executive email”).
- Handle failure states gracefully: show retry option, surface specific errors (e.g., `NotSupportedError` when origin trial absent), and offer fallbacks when APIs unavailable.
- No server-side AI calls; all inference stays on-device in line with Chrome’s built-in AI policies; adhere to Google’s Generative AI Prohibited Uses policy before shipping.

## Speech-to-Text Pipeline
- Use Web Speech API for recognition; detect microphone availability and handle permission prompts.
- Provide language selector (default to browser locale; allow common languages supported by Web Speech API).
- Display transcription confidence or alternative hypotheses if available.
- Implement auto-punctuation toggle and manual correction tools.
- Enforce rolling 3-minute capture windows per recording to keep STT sessions responsive; prompt users to resume if they need longer notes.
- Provide mirrored output hooks: when Direct Insert Mode is enabled, stream transcription deltas to the focused field through a content script while maintaining the canonical transcript in the side panel.

## UI & UX
- Side panel React app (TypeScript) for persistent workspace.
- Layout: transcription editor (top), AI actions toolbar (Summarize, Polish with dropdown, Copy), history drawer (bottom/right).
- Visual states for recording (waveform animation), processing (spinner), success, and errors.
- Keyboard shortcuts: `Ctrl+Shift+.` start/stop recording, `Ctrl+Shift+S` summarize, `Ctrl+Shift+R` polish with last preset.
- Accessibility: ARIA labels, focus management, captions for audio status, high-contrast theme toggle.
- Branding: Ekko palette anchors on primary `#5968F2` for call-to-action elements and accent `#AEB6FF` for backgrounds, focus rings, and hover states to keep the interface cohesive.

## Data Handling & Privacy
- Store transcripts, summaries, rewrite outputs, and preset preferences in `chrome.storage.local` (optional sync toggle).
- Allow users to clear history and toggle auto-save per session.
- All AI inference (summarizer/rewriter, STT) occurs locally in the browser; clearly communicate this in onboarding.
- No audio files stored unless user explicitly exports; transcription is text-only unless they opt to download audio (not in scope initially).

## Architecture Overview
- Manifest V3 extension with:
  - Background service worker managing storage utilities, keyboard shortcuts, and fallback logic.
  - Side panel React app as primary UI.
  - Minimal action popup to open side panel or show quick status (optional).
- Modules: speech controller, transcription store, AI orchestration service, history manager, settings manager.
- Permissions: `sidePanel`, `storage`, optional `commands`, and `scripting`/`activeTab` to enable the direct-insert bridge safely.
- Manifest: configure `origin_trials` with the Rewriter token (joint Writer/Rewriter trial) and guard usage paths to degrade gracefully once the trial window closes.
- Utilize Vite/ESBuild for bundling; ensure MV3 CSP compliance (no inline scripts).

## Implementation Roadmap
1. Scaffold MV3 extension with React side panel, storage utilities, microphone permission checks.
2. Build Web Speech transcription module with live editor and basic history.
3. Integrate Summarizer API (Chrome 138+): implement availability checks, trigger model download, and wire streaming summaries.
4. Secure Rewriter origin trial token for the extension ID, inject via `origin_trials`, then integrate rewrite presets with error handling.
5. Implement history management, tagging, and export options.
6. Polish UX: keyboard shortcuts, onboarding, accessibility, and Ekko theming anchored in `#5968F2`/`#AEB6FF`.
7. Testing, performance tuning, and packaging.

## Testing & Validation
- Unit tests for storage, AI wrapper utilities, transcription state machine (mock Web Speech).
- Integration tests with Puppeteer + Chrome for record → summarize → rewrite flow.
- Manual QA matrix: microphone permissions, unsupported languages, AI APIs disabled, long dictations, rapid toggling between actions.
- Performance: ensure transcription updates don’t lag; debounce calls to AI APIs to avoid race conditions.

## Open Questions
- Should we auto-stop recording after silence or let users configure silence timeout?
- Do we capture page context (URL/title) automatically for history entries?
- Should history sync across devices using `chrome.storage.sync`, or remain local-only until requested?
