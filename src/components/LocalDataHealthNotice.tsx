import { useEffect } from "react";
import { APP_RUNTIME, localDataStatus } from "../lib/backend";

/** D15：用户库/统计库打不开时仍进入主界面，并指向设置里的备份恢复入口。 */
export function LocalDataHealthNotice({
  onNotice,
}: {
  onNotice: (message: string) => void;
}) {
  useEffect(() => {
    if (APP_RUNTIME !== "desktop") {
      return;
    }
    let cancelled = false;
    void localDataStatus()
      .then((status) => {
        if (cancelled) {
          return;
        }
        if (status.userOpenError || !status.userDbOk) {
          onNotice(
            "本机标注库未能正常打开。请打开阅读设置 → 本地数据与诊断，从备份恢复。在修复前标注读写会被拒绝。",
          );
        } else if (status.statsOpenError || !status.statsDbOk) {
          onNotice(
            "本机阅读统计库未能正常打开。请打开阅读设置 → 本地数据与诊断，从备份恢复。",
          );
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [onNotice]);
  return null;
}
