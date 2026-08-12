/**
 * Read-aloud control bar (docs/plan-read-aloud.md §3.6): a floating
 * `reade-motion-panel` toolbar at the bottom of the reading surface (same
 * placement pattern as the relocate confirmation bar). Play/pause, previous/
 * next sentence, restart, a 0.5–2.0 rate slider, the local-voice selector
 * and stop — nothing else. Sentence progress is announced politely for
 * screen readers.
 */

import { ChevronLeft, ChevronRight, Pause, Play, X } from "lucide-react";
import { TTS_MAX_RATE, TTS_MIN_RATE, type TtsPlayerStatus } from "../lib/ttsPlayer";

export interface ReadAloudVoiceOption {
  name: string;
  lang: string;
}

export interface ReadAloudBarProps {
  status: TtsPlayerStatus;
  sentenceIndex: number | null;
  sentenceCount: number;
  rate: number;
  voices: ReadonlyArray<ReadAloudVoiceOption>;
  /** Name of the effective voice (empty while none resolved). */
  voiceName: string;
  onToggle: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onRestart: () => void;
  onRateChange: (rate: number) => void;
  onVoiceChange: (name: string) => void;
  onStop: () => void;
}

export function ReadAloudBar({
  status,
  sentenceIndex,
  sentenceCount,
  rate,
  voices,
  voiceName,
  onToggle,
  onPrevious,
  onNext,
  onRestart,
  onRateChange,
  onVoiceChange,
  onStop,
}: ReadAloudBarProps) {
  const playing = status === "playing";
  const progressLabel =
    sentenceIndex !== null && sentenceCount > 0
      ? `第 ${sentenceIndex + 1} / ${sentenceCount} 句`
      : status === "paused"
        ? "已暂停"
        : "朗读结束";

  return (
    <div className="read-aloud-bar reade-motion-panel" role="toolbar" aria-label="朗读控制">
      <div className="read-aloud-transport">
        <button
          type="button"
          className="read-aloud-toggle"
          aria-label={playing ? "暂停朗读" : "继续朗读"}
          aria-pressed={playing}
          onClick={onToggle}
        >
          {playing ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
        </button>
        <button type="button" aria-label="上一句" onClick={onPrevious}>
          <ChevronLeft size={15} aria-hidden="true" />
        </button>
        <button type="button" aria-label="下一句" onClick={onNext}>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
        <button type="button" className="read-aloud-restart" onClick={onRestart}>
          从头朗读
        </button>
        <span className="read-aloud-progress" aria-live="polite">
          {progressLabel}
        </span>
        <button
          type="button"
          className="read-aloud-stop"
          aria-label="停止朗读并关闭"
          title="停止朗读（Esc）"
          onClick={onStop}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="read-aloud-settings">
        <label className="read-aloud-rate">
          <span>
            语速 <strong>{rate.toFixed(1)}×</strong>
          </span>
          <input
            type="range"
            min={TTS_MIN_RATE}
            max={TTS_MAX_RATE}
            step={0.1}
            value={rate}
            aria-label="朗读语速"
            onChange={(event) => onRateChange(Number(event.target.value))}
          />
        </label>
        <label className="read-aloud-voice">
          <span>语音</span>
          <select
            aria-label="朗读语音"
            value={voiceName}
            onChange={(event) => onVoiceChange(event.target.value)}
          >
            {voices.map((voice) => (
              <option key={voice.name} value={voice.name}>
                {voice.name}（{voice.lang}）
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

export default ReadAloudBar;
