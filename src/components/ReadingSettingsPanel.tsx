// D12：从 App.tsx 提取的阅读设置面板（行为/hook 顺序不变，仅移动）。
// ThemeStylePicker 一并导出：App.tsx 的其它入口仍在使用。
import { ANNOTATION_TONES, ANNOTATION_TONE_META } from "../lib/annotationModel";
import { ANNOTATION_COLOR_NAME_MAX_CHARS } from "../lib/annotations";
import { READER_CJK_FONTS, READER_FONT_PAIRS, READER_LATIN_FONTS, ReaderFontId, ReaderFontPairId, resolveReaderFontSelection } from "../lib/readerFonts";
import { WHEEL_SPEED_MAX, WHEEL_SPEED_MIN, WHEEL_SPEED_STEP } from "../lib/readerWheelSpeed";
import { setNextThemeTransitionOrigin } from "../lib/themeTransition";
import { SERIES_FONT_PRESET, THEME_META, THEME_SERIES, ThemeSeriesId } from "../lib/themes";
import { VERTICAL_DISABLED_FEATURES } from "../lib/verticalWriting";
import { CONTENT_WIDTH_MAX, CONTENT_WIDTH_MIN, ReaderFontFamily, useReaderStore } from "../store/useReaderStore";
import { RotateCcw, X } from "lucide-react";
import {
  ChangeEvent,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { APP_RUNTIME } from "../lib/backend";


export function ReadingSettingsPanel({
  open,
  onClose,
  onNotice,
  focusUnavailableReason = null,
  verticalUnavailableReason = null,
  isWeb = IS_WEB_RUNTIME,
}: {
  open: boolean;
  onClose: () => void;
  onNotice: (message: string) => void;
  /** 聚焦模式在当前内容不适用的原因(如 PDF 原版式);null = 可用。 */
  focusUnavailableReason?: string | null;
  /** 竖排开关对当前文档不可用的原因(如 PDF/mdx);null = 可用。 */
  verticalUnavailableReason?: string | null;
  /** Explicit runtime seam keeps desktop-only controls independently testable. */
  isWeb?: boolean;
}) {
  const settings = useReaderStore((state) => state.readingSettings);
  const update = useReaderStore((state) => state.updateReadingSettings);
  const motionLevel = useReaderStore((state) => state.motionLevel);
  const setMotionLevel = useReaderStore((state) => state.setMotionLevel);
  const fuzzyAnnotationAnchoring = useReaderStore((state) => state.fuzzyAnnotationAnchoring);
  const setFuzzyAnnotationAnchoring = useReaderStore(
    (state) => state.setFuzzyAnnotationAnchoring,
  );
  const allowRemoteImages = useReaderStore((state) => state.allowRemoteImages);
  const setAllowRemoteImages = useReaderStore((state) => state.setAllowRemoteImages);
  const showHighlightCaret = useReaderStore((state) => state.showHighlightCaret);
  const setShowHighlightCaret = useReaderStore((state) => state.setShowHighlightCaret);
  const showScrollMap = useReaderStore((state) => state.showScrollMap);
  const setShowScrollMap = useReaderStore((state) => state.setShowScrollMap);
  const focusSpotlight = useReaderStore((state) => state.focusSpotlight);
  const setFocusSpotlight = useReaderStore((state) => state.setFocusSpotlight);
  const typewriterScroll = useReaderStore((state) => state.typewriterScroll);
  const setTypewriterScroll = useReaderStore((state) => state.setTypewriterScroll);
  const readingRuler = useReaderStore((state) => state.readingRuler);
  const setReadingRuler = useReaderStore((state) => state.setReadingRuler);
  const autoPaceEnabled = useReaderStore((state) => state.autoPaceEnabled);
  const setAutoPaceEnabled = useReaderStore((state) => state.setAutoPaceEnabled);
  const readNextEnabled = useReaderStore((state) => state.readNextEnabled);
  const setReadNextEnabled = useReaderStore((state) => state.setReadNextEnabled);
  const verticalWriting = useReaderStore((state) => state.verticalWriting);
  const setVerticalWriting = useReaderStore((state) => state.setVerticalWriting);
  const annotationColorNames = useReaderStore((state) => state.annotationColorNames);
  const setAnnotationColorName = useReaderStore((state) => state.setAnnotationColorName);
  const resetAnnotationColorNames = useReaderStore(
    (state) => state.resetAnnotationColorNames,
  );
  const resetReaderPreferences = useReaderStore((state) => state.resetReaderPreferences);
  const clearDocumentCache = useReaderStore((state) => state.clearDocumentCache);
  const [clearingCache, setClearingCache] = useState(false);
  // 命名输入草稿:空值回落默认只在提交(blur/Enter)时发生,而非每个键击。
  const [colorNameDrafts, setColorNameDrafts] = useState(annotationColorNames);
  useEffect(() => {
    setColorNameDrafts(annotationColorNames);
  }, [annotationColorNames]);

  const numericSetting =
    (key: "fontSize" | "lineHeight" | "contentWidth" | "paragraphSpacing" | "wheelSpeed") =>
    (event: ChangeEvent<HTMLInputElement>) => {
      update({ [key]: Number(event.target.value) });
    };
  const resolvedFontSelection = resolveReaderFontSelection(settings);

  return (
    <div
      className="settings-popover reade-motion-panel"
      role="dialog"
      aria-label="阅读设置"
      aria-hidden={!open}
      data-open={open}
      inert={!open}
    >
      <div className="settings-heading">
        <span>阅读设置</span>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭阅读设置">
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <label className="setting-row">
        <span className="setting-label">
          <span>正文字号</span>
          <span className="setting-value">{settings.fontSize}px</span>
        </span>
        <input
          type="range"
          min="13"
          max="26"
          step="1"
          value={settings.fontSize}
          onChange={numericSetting("fontSize")}
        />
      </label>

      <label className="setting-row">
        <span className="setting-label">
          <span>正文行高</span>
          <span className="setting-value">{settings.lineHeight.toFixed(2)}</span>
        </span>
        <input
          type="range"
          min="1.4"
          max="2.4"
          step="0.05"
          value={settings.lineHeight}
          onChange={numericSetting("lineHeight")}
        />
      </label>

      <label className="setting-row">
        <span className="setting-label">
          <span>最大正文宽度</span>
          <span className="setting-value">
            {settings.contentWidth >= CONTENT_WIDTH_MAX
              ? "随窗口"
              : `${settings.contentWidth}px`}
          </span>
        </span>
        <input
          type="range"
          min={CONTENT_WIDTH_MIN}
          max={CONTENT_WIDTH_MAX}
          step="20"
          value={settings.contentWidth}
          onChange={numericSetting("contentWidth")}
        />
      </label>

      <label className="setting-row">
        <span className="setting-label">
          <span>段落间距</span>
          <span className="setting-value">{settings.paragraphSpacing.toFixed(1)}×</span>
        </span>
        <input
          type="range"
          min="0.5"
          max="2"
          step="0.1"
          value={settings.paragraphSpacing}
          onChange={numericSetting("paragraphSpacing")}
        />
      </label>

      <label className="setting-row">
        <span className="setting-label">
          <span>滚轮速度</span>
          <span className="setting-value">{settings.wheelSpeed.toFixed(1)}×</span>
        </span>
        <input
          type="range"
          min={WHEEL_SPEED_MIN}
          max={WHEEL_SPEED_MAX}
          step={WHEEL_SPEED_STEP}
          value={settings.wheelSpeed}
          onChange={numericSetting("wheelSpeed")}
          aria-label="滚轮速度"
        />
      </label>

      {isWeb ? (
        <label className="setting-row">
          <span className="setting-label">字体风格</span>
          <select
            className="setting-select"
            value={settings.fontFamily}
            onChange={(event) =>
              update({ fontFamily: event.target.value as ReaderFontFamily })
            }
          >
            <option value="system">系统均衡</option>
            <option value="sans">清晰无衬线</option>
            <option value="serif">书刊衬线</option>
          </select>
        </label>
      ) : (
        <fieldset className="setting-row font-setting">
          <legend className="setting-label">中西文字体</legend>
          <div className="font-mode-control" role="group" aria-label="字体选择模式">
            {([
              ["theme", "跟随主题"],
              ["pair", "搭配预设"],
              ["custom", "高级选择"],
            ] as const).map(([mode, label]) => (
              <button
                type="button"
                key={mode}
                aria-pressed={settings.fontMode === mode}
                className={settings.fontMode === mode ? "active" : undefined}
                onClick={() => update({ fontMode: mode })}
              >
                {label}
              </button>
            ))}
          </div>

          {settings.fontMode === "theme" && (
            <label className="font-setting-field">
              <span>主题字体风格</span>
              <select
                className="setting-select"
                value={settings.fontFamily}
                onChange={(event) =>
                  update({ fontFamily: event.target.value as ReaderFontFamily })
                }
              >
                <option value="system">系统均衡</option>
                <option value="sans">清晰无衬线</option>
                <option value="serif">书刊衬线</option>
              </select>
            </label>
          )}

          {settings.fontMode === "pair" && (
            <label className="font-setting-field">
              <span>策展搭配</span>
              <select
                className="setting-select"
                aria-label="字体搭配预设"
                value={settings.fontPairId}
                onChange={(event) =>
                  update({
                    fontMode: "pair",
                    fontPairId: event.target.value as ReaderFontPairId,
                  })
                }
              >
                {READER_FONT_PAIRS.map((pair) => (
                  <option value={pair.id} key={pair.id}>
                    {pair.label} · {pair.description}
                  </option>
                ))}
              </select>
            </label>
          )}

          {settings.fontMode === "custom" && (
            <div className="font-custom-grid">
              <label className="font-setting-field">
                <span>中文字体</span>
                <select
                  className="setting-select"
                  aria-label="中文字体"
                  value={settings.cjkFontId}
                  onChange={(event) =>
                    update({
                      fontMode: "custom",
                      cjkFontId: event.target.value as ReaderFontId,
                    })
                  }
                >
                  {READER_CJK_FONTS.map((font) => (
                    <option value={font.id} key={font.id}>
                      {font.label}{font.bodyRecommended ? "" : "（展示/特定方向）"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="font-setting-field">
                <span>西文字体</span>
                <select
                  className="setting-select"
                  aria-label="西文字体"
                  value={settings.latinFontId}
                  onChange={(event) =>
                    update({
                      fontMode: "custom",
                      latinFontId: event.target.value as ReaderFontId,
                    })
                  }
                >
                  {READER_LATIN_FONTS.map((font) => (
                    <option value={font.id} key={font.id}>
                      {font.label}{font.bodyRecommended ? "" : "（展示/特定方向）"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <p className="font-selection-summary">当前：{resolvedFontSelection.label}</p>
          {resolvedFontSelection.warnings.map((warning) => (
            <p className="setting-hint font-warning" key={warning}>
              {warning}
            </p>
          ))}
          <p className="setting-hint">仅桌面版注册字体；实际只加载当前选择及正文所需字重。</p>
        </fieldset>
      )}

      <fieldset className="setting-row motion-setting">
        <legend className="setting-label">动态效果</legend>
        <div className="motion-level-control" role="group" aria-label="动态效果级别">
          {([
            ["off", "关闭"],
            ["subtle", "克制"],
            ["full", "完整"],
          ] as const).map(([level, label]) => (
            <button
              type="button"
              key={level}
              aria-pressed={motionLevel === level}
              className={motionLevel === level ? "active" : undefined}
              onClick={() => setMotionLevel(level)}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="setting-row motion-setting">
        <legend className="setting-label">标注模糊定位</legend>
        <div className="motion-level-control" role="group" aria-label="标注模糊定位开关">
          {([
            [false, "关闭"],
            [true, "开启"],
          ] as const).map(([enabled, label]) => (
            <button
              type="button"
              key={label}
              aria-pressed={fuzzyAnnotationAnchoring === enabled}
              className={fuzzyAnnotationAnchoring === enabled ? "active" : undefined}
              onClick={() => setFuzzyAnnotationAnchoring(enabled)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-hint">
          文档修改后按相似度匹配失锚标注；可能把标注定位到相似但不同的文本。
        </p>
      </fieldset>

      <fieldset className="setting-row motion-setting">
        <legend className="setting-label">远程图片</legend>
        <div className="motion-level-control" role="group" aria-label="远程图片开关">
          {([
            [false, "拦截"],
            [true, "加载"],
          ] as const).map(([enabled, label]) => (
            <button
              type="button"
              key={label}
              aria-pressed={allowRemoteImages === enabled}
              className={allowRemoteImages === enabled ? "active" : undefined}
              onClick={() => setAllowRemoteImages(enabled)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-hint">
          默认不联网请求 Markdown 中的 HTTPS 图片；开启后仅加载 https 地址，仍拒绝 http 与危险协议。
        </p>
      </fieldset>

      <fieldset className="setting-row motion-setting">
        <legend className="setting-label">高亮角标</legend>
        <div className="motion-level-control" role="group" aria-label="高亮角标开关">
          {([
            [false, "关闭"],
            [true, "开启"],
          ] as const).map(([enabled, label]) => (
            <button
              type="button"
              key={label}
              aria-pressed={showHighlightCaret === enabled}
              className={showHighlightCaret === enabled ? "active" : undefined}
              onClick={() => setShowHighlightCaret(enabled)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-hint">
          在高亮标注左上角显示红色倒三角，便于扫视定位；不影响下划线标注。
        </p>
      </fieldset>

      <fieldset className="setting-row motion-setting">
        <legend className="setting-label">文档地图</legend>
        <div className="motion-level-control" role="group" aria-label="文档地图开关">
          {([
            [false, "关闭"],
            [true, "开启"],
          ] as const).map(([enabled, label]) => (
            <button
              type="button"
              key={label}
              aria-pressed={showScrollMap === enabled}
              className={showScrollMap === enabled ? "active" : undefined}
              onClick={() => setShowScrollMap(enabled)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-hint">
          正文右缘的刻度层：标出标注三色、书签与搜索命中，点击可跳转。
        </p>
      </fieldset>

      <fieldset className="setting-row motion-setting">
        <legend className="setting-label">读完接着读</legend>
        <div className="motion-level-control" role="group" aria-label="读完接着读开关">
          {([
            [false, "关闭"],
            [true, "开启"],
          ] as const).map(([enabled, label]) => (
            <button
              type="button"
              key={label}
              aria-pressed={readNextEnabled === enabled}
              className={readNextEnabled === enabled ? "active" : undefined}
              onClick={() => setReadNextEnabled(enabled)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-hint">
          滚动到文档末尾时推荐下一篇：合集顺序优先，其次同文件夹，再次互链最多的文档。
        </p>
      </fieldset>

      <fieldset className="setting-row motion-setting focus-mode-setting">
        <legend className="setting-label">聚焦模式</legend>
        {([
          ["段落聚焦", focusSpotlight, setFocusSpotlight, "focus-spotlight"],
          ["打字机滚动", typewriterScroll, setTypewriterScroll, "typewriter-scroll"],
          ["阅读标尺", readingRuler, setReadingRuler, "reading-ruler"],
          ["自动推进", autoPaceEnabled, setAutoPaceEnabled, "auto-pace"],
        ] as const).map(([label, value, setValue, key]) => (
          <div className="focus-mode-row" key={key}>
            <span className="focus-mode-row-label">{label}</span>
            <div
              className="motion-level-control"
              role="group"
              aria-label={`${label}开关`}
            >
              {([
                [false, "关闭"],
                [true, "开启"],
              ] as const).map(([enabled, optionLabel]) => (
                <button
                  type="button"
                  key={optionLabel}
                  aria-pressed={value === enabled}
                  className={value === enabled ? "active" : undefined}
                  disabled={focusUnavailableReason !== null}
                  onClick={() => setValue(enabled)}
                >
                  {optionLabel}
                </button>
              ))}
            </div>
          </div>
        ))}
        <p className="setting-hint">
          {focusUnavailableReason ??
            "段落聚焦淡化当前段落以外的内容；打字机滚动把阅读行保持在视口中部；阅读标尺是跟随指针的横向色带；自动推进按段停留后跳到下一段，并根据你的抢滚/回退自感应调速。"}
        </p>
      </fieldset>

      {/* 竖排模式(plan-vertical-writing VW-D1):每文档开关,实验档。 */}
      <fieldset className="setting-row motion-setting">
        <legend className="setting-label">
          竖排模式<span className="setting-badge">实验</span>
        </legend>
        <div className="motion-level-control" role="group" aria-label="竖排模式开关">
          {([
            [false, "关闭"],
            [true, "开启"],
          ] as const).map(([enabled, label]) => (
            <button
              type="button"
              key={label}
              aria-pressed={verticalWriting === enabled}
              className={verticalWriting === enabled ? "active" : undefined}
              disabled={verticalUnavailableReason !== null}
              onClick={() => setVerticalWriting(enabled)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-hint">
          {verticalUnavailableReason ??
            `当前文档改为竖排（从右往左）阅读，逐文档记忆。竖排下暂停：${VERTICAL_DISABLED_FEATURES}；关闭后完全恢复。`}
        </p>
      </fieldset>

      <fieldset className="setting-row color-names-setting">
        <legend className="setting-label">颜色外观名</legend>
        <div className="color-name-grid">
          {ANNOTATION_TONES.map((tone) => {
            const legacyColor = ANNOTATION_TONE_META[tone].legacyColor;
            return (
              <label className="color-name-row" key={tone}>
                <span
                  className={`annotation-tone-swatch annotation-tone-swatch--${tone}`}
                  aria-hidden="true"
                />
                <input
                  type="text"
                  className="color-name-input"
                  value={colorNameDrafts[legacyColor]}
                  maxLength={ANNOTATION_COLOR_NAME_MAX_CHARS}
                  aria-label={`${ANNOTATION_TONE_META[tone].label}的外观名`}
                  onChange={(event) =>
                    setColorNameDrafts((drafts) => ({
                      ...drafts,
                      [legacyColor]: event.target.value,
                    }))
                  }
                  onBlur={(event) => setAnnotationColorName(legacyColor, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </label>
            );
          })}
        </div>
        <p className="setting-hint">
          命名显示在颜色选择、筛选与图例中；清空某项则恢复该色默认名。新标记只有暖砂、青灰、墨蓝三种外观。
        </p>
        <button
          className="settings-reset color-names-reset"
          type="button"
          onClick={resetAnnotationColorNames}
        >
          <RotateCcw size={13} aria-hidden="true" />
          恢复默认命名
        </button>
      </fieldset>

      <button
        className="settings-reset"
        type="button"
        onClick={resetReaderPreferences}
      >
        <RotateCcw size={13} aria-hidden="true" />
        恢复默认
      </button>
      {!IS_WEB_RUNTIME && <button
        className="settings-reset settings-cache-clear"
        type="button"
        disabled={clearingCache}
        onClick={() => {
          if (clearingCache) return;
          setClearingCache(true);
          void clearDocumentCache().then((succeeded) => {
            if (succeeded) onNotice("文档索引缓存已清理，将在后台重新建立索引。");
          }).finally(() => setClearingCache(false));
        }}
      >
        <RotateCcw size={13} aria-hidden="true" />
        {clearingCache ? "正在清理缓存…" : "清理文档索引缓存"}
      </button>}
    </div>
  );
}

/**
 * 「界面风格」popover: one swatch tile per theme series (5.5). Selecting a tile
 * applies the series immediately, keeping the current light/dark mode; the
 * series' typography preset lands with it (D4) and a hint line explains the
 * serif preset. Reuses the settings-popover / reade-motion-panel pattern.
 */
export function ThemeStylePicker({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const theme = useReaderStore((state) => state.theme);
  const setThemeSeries = useReaderStore((state) => state.setThemeSeries);
  const [hint, setHint] = useState<string | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const activeSeries = THEME_META[theme].series;
  const mode = THEME_META[theme].mode;

  useEffect(() => {
    if (!open) setHint(null);
  }, [open]);

  const pickSeries = (series: ThemeSeriesId, anchor?: HTMLElement | null) => {
    if (series === activeSeries) return;
    // 墨水扩散以色卡中心为圆心(TT-D3 定稿修订);等值早退在上一行,
    // 不会留下陈旧 origin。
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      setNextThemeTransitionOrigin({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
    }
    setThemeSeries(series);
    const fontMode = useReaderStore.getState().readingSettings.fontMode;
    setHint(
      fontMode === "theme" && SERIES_FONT_PRESET[series] === "serif"
        ? "已切换为书刊衬线，可在阅读设置中调整"
        : null,
    );
  };

  // Radio-group keyboard pattern: arrows cycle (with wrap) and select as they
  // move — the instant-preview behavior of the tiles — Home/End jump.
  const onGroupKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(key)) {
      return;
    }
    event.preventDefault();
    const focused = groupRef.current?.querySelector<HTMLButtonElement>(
      ".theme-style-tile:focus",
    );
    const focusedIndex = THEME_SERIES.findIndex(
      (series) => series.id === focused?.dataset.series,
    );
    const currentIndex =
      focusedIndex >= 0
        ? focusedIndex
        : THEME_SERIES.findIndex((series) => series.id === activeSeries);
    let nextIndex = currentIndex;
    if (key === "Home") nextIndex = 0;
    else if (key === "End") nextIndex = THEME_SERIES.length - 1;
    else {
      const delta = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
      nextIndex = (currentIndex + delta + THEME_SERIES.length) % THEME_SERIES.length;
    }
    const nextSeries = THEME_SERIES[nextIndex].id;
    const tile = groupRef.current?.querySelector<HTMLButtonElement>(
      `.theme-style-tile[data-series="${nextSeries}"]`,
    );
    tile?.focus();
    pickSeries(nextSeries, tile);
  };

  return (
    <div
      className="settings-popover reade-motion-panel theme-style-popover"
      role="dialog"
      aria-label="界面风格"
      aria-hidden={!open}
      data-open={open}
      inert={!open}
    >
      <div className="settings-heading">
        <span>界面风格</span>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭界面风格">
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <div
        ref={groupRef}
        className="theme-style-options"
        role="radiogroup"
        aria-label="界面风格系列"
        onKeyDown={onGroupKeyDown}
      >
        {THEME_SERIES.map((series) => {
          const meta = THEME_META[`${series.id}-${mode}`];
          const active = series.id === activeSeries;
          return (
            <button
              key={series.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-series={series.id}
              tabIndex={active ? 0 : -1}
              className={`theme-style-tile${active ? " active" : ""}`}
              aria-label={`${series.label}系列${active ? "（当前使用）" : ""}`}
              onClick={(event) => pickSeries(series.id, event.currentTarget)}
            >
              <span className="theme-style-swatch" aria-hidden="true">
                <i style={{ background: meta.swatch.paper }} />
                <i style={{ background: meta.swatch.chrome }} />
                <i style={{ background: meta.swatch.accent }} />
              </span>
              <span className="theme-style-name">{series.label}</span>
            </button>
          );
        })}
      </div>
      {hint && (
        <p className="theme-style-hint" role="status">
          {hint}
        </p>
      )}
    </div>
  );
}

const IS_WEB_RUNTIME = APP_RUNTIME === "web";
