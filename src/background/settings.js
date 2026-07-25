/* Background settings, including the SerpApi key.
 *
 * chrome.storage.LOCAL on purpose: storage.sync is uploaded to Google's servers
 * under the user's account, which is not somewhere an API key belongs.
 *
 * On first run the key is seeded from `secrets.local.json` if that file exists.
 * It is gitignored — the key never enters the repository, and there is nothing
 * to strip before sharing the extension.
 */

const DEFAULTS = {
  serpApiKey: '',
  autoTranscribe: true, // fetch the transcript as soon as a video is opened
  // Requested language. If the video has no track in it, SerpApi falls back to
  // the first one it does have — the result records which was actually used.
  transcriptLanguage: 'en',
  // '' lets SerpApi pick the track YouTube marks as selected (human captions
  // when they exist). 'asr' forces the auto-generated one.
  transcriptType: '',
};

const SEEDED_FLAG = 'serpApiKeySeeded';

export async function getSettings() {
  const stored = await chrome.storage.local.get({ ...DEFAULTS, [SEEDED_FLAG]: false });
  const settings = { ...DEFAULTS, ...stored };

  // Seed exactly once. Re-seeding whenever the key looks empty would quietly
  // undo the user clearing it.
  if (!settings.serpApiKey && !stored[SEEDED_FLAG]) {
    const seeded = await readLocalSecrets();
    await chrome.storage.local.set({
      [SEEDED_FLAG]: true,
      ...(seeded?.serpApiKey ? { serpApiKey: seeded.serpApiKey } : {}),
    });
    if (seeded?.serpApiKey) settings.serpApiKey = seeded.serpApiKey;
  }

  delete settings[SEEDED_FLAG];
  return settings;
}

export async function setSettings(patch) {
  const allowed = Object.fromEntries(
    Object.entries(patch).filter(([key]) => key in DEFAULTS)
  );
  await chrome.storage.local.set(allowed);
  return getSettings();
}

async function readLocalSecrets() {
  try {
    const response = await fetch(chrome.runtime.getURL('secrets.local.json'));
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null; // file absent — expected for a fresh clone
  }
}
