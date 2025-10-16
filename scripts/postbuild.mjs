import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

const PLACEHOLDER_TO_ENV = new Map([
  ['__REPLACE_WITH_REWRITER_ORIGIN_TRIAL_TOKEN__', 'REWRITER_TRIAL_TOKEN'],
  ['__REPLACE_WITH_PROMPT_MULTIMODAL_TRIAL_TOKEN__', 'PROMPT_TRIAL_TOKEN']
]);
const ENV_KEYS = new Set(PLACEHOLDER_TO_ENV.values());
const DIST_MANIFEST = resolve('dist', 'manifest.json');
const ENV_PATH = resolve('.env');

async function readEnvValues() {
  const tokens = new Map();

  // Prefer process.env
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value && value.trim()) {
      tokens.set(key, value.trim());
    }
  }

  const missingKeys = [...ENV_KEYS].filter((key) => !tokens.has(key));
  if (!missingKeys.length) {
    return tokens;
  }

  try {
    const contents = await readFile(ENV_PATH, 'utf8');
    const lines = contents.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const [key, ...rest] = trimmed.split('=');
      if (ENV_KEYS.has(key) && !tokens.has(key)) {
        const value = rest.join('=').trim();
        if (value) {
          tokens.set(key, value);
        }
      }
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn('[postbuild] Unable to read .env file:', error);
    }
  }

  return tokens;
}

async function patchManifest() {
  let manifestRaw;
  try {
    manifestRaw = await readFile(DIST_MANIFEST, 'utf8');
  } catch (error) {
    console.error('[postbuild] Missing dist/manifest.json. Did the build complete?');
    process.exitCode = 1;
    return;
  }

  const tokens = await readEnvValues();

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    console.error('[postbuild] Failed to parse dist/manifest.json:', error);
    process.exitCode = 1;
    return;
  }

  const trialEntries = Array.isArray(manifest.origin_trials) ? manifest.origin_trials : [];
  let replacements = 0;

  const patched = trialEntries.map((entry) => {
    if (!(entry && typeof entry === 'object')) {
      return entry;
    }

    const envKey = PLACEHOLDER_TO_ENV.get(entry.trial);
    if (!envKey) {
      return entry;
    }

    const token = tokens.get(envKey);
    if (!token) {
      console.warn(`[postbuild] ${envKey} not set. Leaving placeholder ${entry.trial}.`);
      return entry;
    }

    replacements += 1;
    return { ...entry, trial: token };
  });

  if (!replacements) {
    console.warn('[postbuild] No origin trial placeholder found in manifest. Skipping patch.');
    return;
  }

  manifest.origin_trials = patched;
  await writeFile(DIST_MANIFEST, JSON.stringify(manifest, null, 2));
  console.info('[postbuild] Injected origin trial tokens into dist/manifest.json.');
}

patchManifest().catch((error) => {
  console.error('[postbuild] Unexpected error:', error);
  process.exitCode = 1;
});
