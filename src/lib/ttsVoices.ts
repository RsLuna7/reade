/**
 * Voice enumeration and the offline allow-list for local read-aloud
 * (docs/plan-read-aloud.md §3.1, decision RA-D1).
 *
 * The offline promise is enforced here, not in a setting: only voices whose
 * `localService === true` pass the primary filter, and voices whose name
 * contains the word "Online" are additionally excluded (defense in depth,
 * because `localService` is ultimately implementation-reported). An empty
 * filtered list is the disable signal for the whole feature — callers must
 * never fall back to remote voices.
 *
 * Everything takes structural parameters (`VoiceSource` / `VoiceInfo`) so the
 * asynchronous `getVoices()` timing can be unit-tested with plain doubles;
 * the real `window.speechSynthesis` and `SpeechSynthesisVoice` satisfy those
 * shapes as-is.
 */

/** The subset of `SpeechSynthesisVoice` this module reads. */
export interface VoiceInfo {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

/** The subset of `SpeechSynthesis` needed to enumerate voices. */
export interface VoiceSource<T extends VoiceInfo = SpeechSynthesisVoice> {
  getVoices(): T[];
  addEventListener(type: "voiceschanged", listener: () => void): void;
  removeEventListener(type: "voiceschanged", listener: () => void): void;
}

/**
 * How long to wait for `voiceschanged` before settling with whatever the
 * source reports. Chromium populates the list asynchronously; some engines
 * never fire the event, hence the timeout.
 */
export const VOICES_CHANGED_TIMEOUT_MS = 2000;

/**
 * Resolves the voice list, handling the async `getVoices()` timing: a
 * non-empty first call resolves immediately, otherwise the promise settles on
 * the first `voiceschanged` that yields voices, or after `timeoutMs` with the
 * then-current (possibly empty) list. Never rejects.
 */
export function loadVoices<T extends VoiceInfo>(
  source: VoiceSource<T>,
  timeoutMs: number = VOICES_CHANGED_TIMEOUT_MS,
): Promise<T[]> {
  const immediate = source.getVoices();
  if (immediate.length > 0) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      source.removeEventListener("voiceschanged", onVoicesChanged);
      resolve(source.getVoices());
    };
    const onVoicesChanged = () => {
      // Some engines fire the event while the list is still empty; keep
      // waiting for the timeout in that case.
      if (source.getVoices().length > 0) settle();
    };
    const timer = setTimeout(settle, timeoutMs);
    source.addEventListener("voiceschanged", onVoicesChanged);
  });
}

/** Names carrying this marker are treated as network voices regardless of flags. */
const ONLINE_NAME_PATTERN = /\bonline\b/i;

/**
 * Offline allow-list: keeps only `localService === true` voices and drops
 * names containing "Online". An empty result means read-aloud must render
 * as disabled — there is deliberately no remote fallback.
 */
export function filterLocalVoices<T extends VoiceInfo>(voices: readonly T[]): T[] {
  return voices.filter(
    (voice) => voice.localService === true && !ONLINE_NAME_PATTERN.test(voice.name),
  );
}

function languagePrimarySubtag(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/, 1)[0] ?? "";
}

/**
 * Default voice pick (plan §3.1): language-prefix match against the document
 * language first (a `zh` document prefers `zh-*` voices), then the
 * engine-flagged default, then the first voice; null for an empty list.
 */
export function pickDefaultVoice<T extends VoiceInfo>(
  voices: readonly T[],
  documentLang?: string | null,
): T | null {
  if (voices.length === 0) return null;
  const wanted = documentLang ? languagePrimarySubtag(documentLang) : "";
  if (wanted) {
    const matches = voices.filter((voice) => languagePrimarySubtag(voice.lang) === wanted);
    if (matches.length > 0) return matches.find((voice) => voice.default) ?? matches[0];
  }
  return voices.find((voice) => voice.default) ?? voices[0];
}
