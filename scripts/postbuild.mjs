import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

const PLACEHOLDER = '__REPLACE_WITH_REWRITER_ORIGIN_TRIAL_TOKEN__';
const DIST_MANIFEST = resolve('dist', 'manifest.json');
const ENV_PATH = resolve('.env');

async function readEnvToken() {
  const tokenFromEnv = process.env.ORIGIN_TRIAL_TOKEN;
  if (tokenFromEnv) {
    return tokenFromEnv.trim();
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
      if (key === 'ORIGIN_TRIAL_TOKEN') {
        return rest.join('=').trim();
      }
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn('[postbuild] Unable to read .env file:', error);
    }
  }

  return undefined;
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

  const token = await readEnvToken();

  if (!token) {
    console.warn(
      '[postbuild] ORIGIN_TRIAL_TOKEN not set. Leaving manifest placeholder in place.'
    );
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    console.error('[postbuild] Failed to parse dist/manifest.json:', error);
    process.exitCode = 1;
    return;
  }

  const trialEntries = Array.isArray(manifest.origin_trials) ? manifest.origin_trials : [];
  const patched = trialEntries.map((entry) => {
    if (entry.trial === PLACEHOLDER) {
      return { ...entry, trial: token };
    }
    return entry;
  });

  const replacements = patched.filter((entry) => entry.trial === token).length;

  if (!replacements) {
    console.warn('[postbuild] No origin trial placeholder found in manifest. Skipping patch.');
    return;
  }

  manifest.origin_trials = patched;
  await writeFile(DIST_MANIFEST, JSON.stringify(manifest, null, 2));
  console.info('[postbuild] Injected origin trial token into dist/manifest.json.');
}

patchManifest().catch((error) => {
  console.error('[postbuild] Unexpected error:', error);
  process.exitCode = 1;
});
