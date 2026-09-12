/** Format LocalDataStatus errors for the 286px reading-settings popover. */

export type LocalOpenErrorView = {
  title: string;
  detail: string;
  paths: string[];
};

const CONFLICT_BOTH = /present in both (.+?) and (.+?)(?:, | without )/;
const DEBUG_PATH = /^(?:WindowsPath|Path)\("((?:\\.|[^"\\])*)"\)$/;

export function describeLocalOpenError(
  kind: "user" | "stats",
  message: string,
): LocalOpenErrorView {
  const title = kind === "user" ? "标注库打开失败" : "统计库打开失败";
  const paths = extractConflictPaths(message);
  if (paths.length === 2) {
    const changed = message.includes("old copy changed");
    return {
      title,
      detail: changed
        ? "两处都有标注数据，而且旧副本在迁移后又被改过。Reade 不会自动选哪一份。请只保留要用的那份，把另一份改名挪走，然后重启。"
        : "两处都有标注数据，且没有可信的迁移记录。Reade 不会自动选哪一份。请只保留要用的那份，把另一份改名挪走，然后重启。",
      paths,
    };
  }
  return { title, detail: message, paths: [] };
}

export function extractConflictPaths(message: string): string[] {
  const match = message.match(CONFLICT_BOTH);
  if (!match?.[1] || !match[2]) {
    return [];
  }
  return [cleanPathToken(match[1]), cleanPathToken(match[2])];
}

function cleanPathToken(token: string): string {
  const debug = token.match(DEBUG_PATH);
  if (debug?.[1]) {
    return debug[1].replace(/\\\\/g, "\\");
  }
  return token.replace(/^"|"$/g, "");
}
