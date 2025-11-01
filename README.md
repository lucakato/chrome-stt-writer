# Echo: Write with Voice

An experimental Chrome extension that captures speech, transcribes with the Web Speech API, and uses on-device Gemini Nano via the Prompt API and Rewriter API to draft and refine text inside Chrome’s side panel.

## Prerequisites

- Node.js 18+ (recommended: latest LTS).
- npm 9+ (bundled with recent Node releases).
- Google Chrome 138 or newer (Dev/Canary builds work best for on-device AI features).
- On-device **Prompt API**, **Rewriter API**, and **Web Speech API** components installed:
  1. Open `chrome://flags`, search for “Prompt API for developers” and “Chrome AI Rewriter”, set both to **Enabled**, and relaunch Chrome.
  2. Visit `chrome://components`, locate the *Prompt API* and *Chrome AI Rewriter* entries, and click **Check for update** so the on-device models download.
  3. The Web Speech API ships with Chrome; ensure any OS-level microphone privacy controls allow Chrome to record audio.
- Two active origin trial tokens:
  - `ChromeAIRewriter`
  - `AIPromptAPIMultimodalInput`

  Replace the `__REPLACE_WITH_*` placeholders in `public/manifest.json` with the enrolled tokens from the [Chrome Origin Trials dashboard](https://developer.chrome.com/origintrials).

## Install and Build

Clone the repository and install dependencies:

```bash
git clone https://github.com/your-user/chrome-stt-writer.git
cd chrome-stt-writer
npm install
```

Build the production bundle:

```bash
npm run build
```

The compiled extension assets land in `dist/`. During development you can run `npm run dev` to watch and rebuild automatically, but Chrome still needs to be refreshed after each build.

## Load the Extension in Chrome

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and select the repository’s `dist/` directory.
4. After rebuilding (`npm run build`), click **Reload** next to the extension or press `⌘/Ctrl+R` while the extension card is focused.

## Microphone Permissions

The extension requests audio access when you hit **Record**.

- When Chrome shows the microphone prompt, choose **Allow**. There is no “Allow once” option for extensions; the permission persists until you revoke it.
- If the prompt disappears or you need to grant access manually:
  1. Copy the extension ID from `chrome://extensions` (Developer mode must be on).
  2. Navigate to `chrome://settings/content/siteDetails?site=chrome-extension://<extension-id>`.
  3. Set **Microphone** to **Allow**, then reload the extension.

## API Availability Checks

If the compose or rewrite flows report that an API is unavailable:

- Keep Chrome open while the Prompt API or Rewriter API downloads (shown in `chrome://components`).
- Confirm the origin trial tokens in `public/manifest.json` have not expired and match the extension ID/domain you are running.
- Ensure you are using a Chrome build that supports on-device AI (currently limited to select hardware configurations).

## Development Scripts

- `npm run dev` – Vite dev server for iterative builds (still load from `dist/` in Chrome).
- `npm run build` – Production build + post-build script that prepares the extension bundle.
- `npm run preview` – Preview build with Vite’s static server.
- `npm run lint` – Type-check the project.

## License

This project is open source under the MIT License. See [LICENSE](LICENSE) for details.
