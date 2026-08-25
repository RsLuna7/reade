/**
 * 自动推进控制：默认隐式小胶囊，悬停/聚焦时展开节奏滑杆与关闭。
 * 推进中不应抢走正文视线（plan-auto-pace 隐式修订）。
 */

import { Pause, Play, X } from "lucide-react";
import {
  AUTO_PACE_BIAS_MAX,
  AUTO_PACE_BIAS_MIN,
  type AutoPaceStatus,
} from "../lib/autoPace";

export interface AutoPaceBarProps {
  status: AutoPaceStatus;
  paceHint: string;
  bias: number;
  onToggle: () => void;
  onBiasChange: (bias: number) => void;
  onStop: () => void;
}

export function AutoPaceBar({
  status,
  paceHint,
  bias,
  onToggle,
  onBiasChange,
  onStop,
}: AutoPaceBarProps) {
  const playing = status === "playing";
  const statusLabel =
    status === "playing" ? "推进中" : status === "paused" ? "已暂停" : "待开始";

  return (
    <div
      className="auto-pace-bar reade-motion-panel"
      data-playing={playing ? "true" : "false"}
      role="toolbar"
      aria-label="自动推进控制"
    >
      <button
        type="button"
        className="auto-pace-toggle"
        aria-label={playing ? "暂停自动推进" : "开始自动推进"}
        aria-pressed={playing}
        title={playing ? "暂停（空格）" : "开始（空格）"}
        onClick={onToggle}
      >
        {playing ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
      </button>

      <div className="auto-pace-details">
        <span className="auto-pace-status" aria-live="polite">
          {statusLabel}
          <span className="auto-pace-hint"> · {paceHint}</span>
        </span>
        <label className="auto-pace-bias">
          <span>
            节奏 <strong>{bias.toFixed(1)}×</strong>
          </span>
          <input
            type="range"
            min={AUTO_PACE_BIAS_MIN}
            max={AUTO_PACE_BIAS_MAX}
            step={0.1}
            value={bias}
            aria-label="自动推进整体节奏"
            onChange={(event) => onBiasChange(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          className="auto-pace-stop"
          aria-label="停止自动推进并关闭"
          title="停止自动推进（Esc）"
          onClick={onStop}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
