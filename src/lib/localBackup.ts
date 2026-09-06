/** localStorage keys packed into a D15 backup. Document bodies stay on disk. */
export const LOCAL_BACKUP_PREFERENCE_KEYS = [
  "reade-reader-preferences",
  "reade-library-mru",
  "reade-reading-positions",
  "reade-tree-layout",
  "reade-read-marks",
  "reade-vertical-writing",
  "reade-home-baseline",
  "reade-device-id",
] as const;

export function collectLocalBackupPreferences(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): string {
  const payload: Record<string, string | null> = {};
  for (const key of LOCAL_BACKUP_PREFERENCE_KEYS) {
    payload[key] = storage.getItem(key);
  }
  return JSON.stringify(payload);
}

export function restoreLocalBackupPreferences(
  json: string,
  storage: Pick<Storage, "setItem" | "removeItem"> = window.localStorage,
): void {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Preferences snapshot must be a JSON object");
  }
  for (const key of LOCAL_BACKUP_PREFERENCE_KEYS) {
    const value = parsed[key];
    if (typeof value === "string") storage.setItem(key, value);
    else storage.removeItem(key);
  }
}
