// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef, type ComponentPropsWithoutRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TtsSpeakRequest } from "./ttsPlayer";
import {
  buildReadAloudQueue,
  TTS_ACTIVE_ID,
  useReadAloud,
  type ReadAloudContentKind,
  type ReadAloudControls,
  type ReadAloudSpeech,
} from "./useReadAloud";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// CSS Custom Highlight API 测试替身(RA-D3 修订)。
// jsdom 没有 CSS.highlights / Highlight;用 Map + 记录构造参数的类搭一个
// 同构注册表,断言"高亮机制被正确调用"而不触碰 DOM。
// ---------------------------------------------------------------------------

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

type MutableCssNamespace = { highlights?: Map<string, FakeHighlight> };

function installHighlightRegistry(): Map<string, FakeHighlight> {
  const registry = new Map<string, FakeHighlight>();
  (globalThis.CSS as unknown as MutableCssNamespace).highlights = registry;
  vi.stubGlobal("Highlight", FakeHighlight);
  return registry;
}

function uninstallHighlightRegistry(): void {
  delete (globalThis.CSS as unknown as MutableCssNamespace).highlights;
  vi.unstubAllGlobals();
}

/** 当前注册的朗读句高亮所覆盖的文本;null = 没有注册高亮。 */
function activeHighlightText(registry: Map<string, FakeHighlight>): string | null {
  const highlight = registry.get(TTS_ACTIVE_ID);
  if (!highlight) return null;
  return highlight.ranges.map((range) => range.toString()).join("");
}

/** Scripted speech double: utterances settle only when the test says so. */
function scriptedSpeech(voiceList?: Array<Partial<SpeechSynthesisVoice>>) {
  const spoken: TtsSpeakRequest[] = [];
  const voices = (
    voiceList ?? [{ name: "Local Voice", lang: "zh-CN", localService: true, default: true }]
  ) as SpeechSynthesisVoice[];
  const cancel = vi.fn();
  const speech: ReadAloudSpeech = {
    voices: {
      getVoices: () => voices,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    port: {
      speak: (request) => {
        spoken.push(request);
        return request;
      },
      cancel,
    },
  };
  return { speech, spoken, cancel };
}

function Harness({
  speech,
  onControls,
  contentKey = "guide.md",
  contentKind = "markdown" as ReadAloudContentKind,
  active = true,
  onSentenceEnd,
  onNotice,
  children,
}: {
  speech: ReadAloudSpeech | null;
  onControls: (controls: ReadAloudControls) => void;
  contentKey?: string;
  contentKind?: ReadAloudContentKind;
  active?: boolean;
  onSentenceEnd?: () => void;
  onNotice?: (message: string) => void;
  children: React.ReactNode;
}) {
  const articleRef = useRef<HTMLDivElement | null>(null);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const controls = useReadAloud({
    articleRef,
    readerRef,
    contentKind,
    contentKey,
    active,
    motionLevel: "off",
    rate: 1,
    voiceName: null,
    onSentenceEnd,
    onNotice,
    speech,
  });
  onControls(controls);
  return (
    <div ref={readerRef} className="reading-scroll">
      <div ref={articleRef} className="article-shell">
        {children}
      </div>
    </div>
  );
}

const markdownBody = (
  <div className="markdown-body">
    <p>第一句。第二句。</p>
    <pre>
      <code>console.log("skip me");</code>
    </pre>
    <p>第三句。</p>
  </div>
);

describe("buildReadAloudQueue", () => {
  it("segments markdown into sentences and skips excluded subtrees", () => {
    const article = document.createElement("div");
    article.innerHTML =
      '<div class="markdown-body"><p>第一句。第二句。</p><pre><code>code text.</code></pre><p>第三句。</p></div>';
    const queue = buildReadAloudQueue(article, "markdown");
    expect(queue.sentences.map((sentence) => sentence.text)).toEqual([
      "第一句。",
      "第二句。",
      "第三句。",
    ]);
  });

  it("collects one source per EPUB chapter and leaves book-end notes out", () => {
    const article = document.createElement("div");
    article.innerHTML =
      '<div class="epub-reader">' +
      '<section class="epub-chapter"><h2>第一章</h2><p>正文甲。</p></section>' +
      '<section class="epub-chapter"><h2>第二章</h2><p>正文乙。</p></section>' +
      '<section class="epub-notes"><aside>注释不读。</aside></section>' +
      "</div>";
    const queue = buildReadAloudQueue(article, "epub");
    expect(queue.sources).toHaveLength(2);
    const spokenText = queue.sentences.map((sentence) => sentence.text).join("");
    expect(spokenText).toContain("第一章");
    expect(spokenText).toContain("正文乙。");
    expect(spokenText).not.toContain("注释不读");
  });

  it("reads PDF reading-mode page bodies and skips page chrome", () => {
    const article = document.createElement("div");
    article.innerHTML =
      '<div class="pdf-reading-mode">' +
      '<section class="pdf-reading-page"><span class="pdf-reading-page-label">Page 1</span><article class="markdown-body"><p>第一页正文。</p></article></section>' +
      '<section class="pdf-reading-page"><span class="pdf-reading-page-label">Page 2</span><p class="pdf-page-missing">本页需要 OCR</p></section>' +
      "</div>";
    const queue = buildReadAloudQueue(article, "pdf");
    expect(queue.sentences.map((sentence) => sentence.text)).toEqual(["第一页正文。"]);
  });
});

describe("useReadAloud", () => {
  let registry: Map<string, FakeHighlight>;

  beforeEach(() => {
    registry = installHighlightRegistry();
  });

  afterEach(() => {
    uninstallHighlightRegistry();
  });

  it("plays sentence by sentence with a single moving sentence highlight", async () => {
    const { speech, spoken } = scriptedSpeech();
    let controls!: ReadAloudControls;
    const view = render(
      <Harness speech={speech} onControls={(next) => (controls = next)}>
        {markdownBody}
      </Harness>,
    );
    // 语音列表在 microtask 中就绪。
    await act(async () => {});
    expect(controls.supported).toBe(true);
    expect(controls.voices).toHaveLength(1);

    act(() => controls.start());
    expect(controls.barOpen).toBe(true);
    expect(controls.status).toBe("playing");
    expect(controls.sentenceCount).toBe(3);
    expect(spoken.map((request) => request.text)).toEqual(["第一句。"]);
    expect(spoken[0].voice).toMatchObject({ name: "Local Voice" });

    // 当前句注册为 CSS 高亮;pre/code 文本不进入队列。
    expect(activeHighlightText(registry)).toBe("第一句。");
    // 高亮机制零 DOM 变异:正文里绝不出现临时 mark 元素。
    expect(view.container.querySelector("mark")).toBeNull();

    act(() => spoken[0].onEnd());
    expect(spoken.map((request) => request.text)).toEqual(["第一句。", "第二句。"]);
    expect(activeHighlightText(registry)).toBe("第二句。");

    act(() => spoken[1].onEnd());
    expect(spoken[2].text).toBe("第三句。");
    expect(activeHighlightText(registry)).toBe("第三句。");

    // 播完最后一句:队列结束,高亮清除,控制条保留(可从头再播)。
    act(() => spoken[2].onEnd());
    expect(controls.status).toBe("idle");
    expect(registry.has(TTS_ACTIVE_ID)).toBe(false);
  });

  it(
    "keeps playing across a sentence with an inline link while React remounts it " +
      "(P1 insertBefore-crash regression)",
    async () => {
      // App 侧 MarkdownRenderer 每次渲染都重建 components 映射,自定义 <a>
      // 的组件函数身份随之变化,React 便以「删除旧节点 + insertBefore 新节点」
      // 重挂链接。旧的 wrapRangeWithMark 高亮在句推进时恰好搬走/合并了插入
      // 参照的文本节点,insertBefore 抛 NotFoundError 并卸载整棵树 —— 修复前
      // 本用例在第一次句推进处即以该异常失败。
      const { speech, spoken } = scriptedSpeech();
      let controls!: ReadAloudControls;

      function LinkHarness() {
        const articleRef = useRef<HTMLDivElement | null>(null);
        const readerRef = useRef<HTMLDivElement | null>(null);
        const next = useReadAloud({
          articleRef,
          readerRef,
          contentKind: "markdown",
          contentKey: "linked.md",
          active: true,
          motionLevel: "off",
          rate: 1,
          voiceName: null,
          speech,
        });
        controls = next;
        // 每次渲染都是新的组件身份 —— 复刻 MarkdownRenderer 内联 components 的效果。
        const InlineLink = (props: ComponentPropsWithoutRef<"a">) => <a {...props} />;
        return (
          <div ref={readerRef} className="reading-scroll">
            <div ref={articleRef} className="article-shell">
              <div className="markdown-body">
                <p>
                  第一句。外部链接需要交给系统浏览器打开，例如 <InlineLink href="https://tauri.app/">Tauri</InlineLink>。
                </p>
                <p>链接之后的下一句。</p>
              </div>
            </div>
          </div>
        );
      }

      const view = render(<LinkHarness />);
      await act(async () => {});
      act(() => controls.start());
      expect(activeHighlightText(registry)).toBe("第一句。");

      // 修复前:此处 React 重挂 <a> 时抛 NotFoundError(insertBefore)。
      expect(() => act(() => spoken[0].onEnd())).not.toThrow();
      expect(spoken.map((request) => request.text)).toEqual([
        "第一句。",
        "外部链接需要交给系统浏览器打开，例如 Tauri。",
      ]);
      // 含链接句被完整注册为高亮(跨越 <a> 边界),且链接 DOM 完好。
      expect(activeHighlightText(registry)).toBe("外部链接需要交给系统浏览器打开，例如 Tauri。");
      expect(view.container.querySelector("a")?.textContent).toBe("Tauri");
      expect(view.container.querySelector("mark")).toBeNull();

      expect(() => act(() => spoken[1].onEnd())).not.toThrow();
      expect(activeHighlightText(registry)).toBe("链接之后的下一句。");

      act(() => spoken[2].onEnd());
      expect(controls.status).toBe("idle");
      expect(registry.has(TTS_ACTIVE_ID)).toBe(false);
    },
  );

  it("degrades to no visual highlight (never DOM wrapping) without the Highlight API", async () => {
    // 特性检测兜底:没有 CSS.highlights 的运行时照常播放,只失去视觉高亮。
    uninstallHighlightRegistry();
    const { speech, spoken } = scriptedSpeech();
    let controls!: ReadAloudControls;
    const view = render(
      <Harness speech={speech} onControls={(next) => (controls = next)}>
        {markdownBody}
      </Harness>,
    );
    await act(async () => {});
    act(() => controls.start());
    expect(controls.status).toBe("playing");
    act(() => spoken[0].onEnd());
    expect(spoken.map((request) => request.text)).toEqual(["第一句。", "第二句。"]);
    // 绝不回退到会崩的 DOM 包裹方案。
    expect(view.container.querySelector("mark")).toBeNull();
    act(() => controls.stop());
    expect(controls.status).toBe("idle");
  });

  it("reports activity on every finished sentence (RA-D4)", async () => {
    const { speech, spoken } = scriptedSpeech();
    const onSentenceEnd = vi.fn();
    let controls!: ReadAloudControls;
    render(
      <Harness
        speech={speech}
        onControls={(next) => (controls = next)}
        onSentenceEnd={onSentenceEnd}
      >
        {markdownBody}
      </Harness>,
    );
    await act(async () => {});
    act(() => controls.start());
    act(() => spoken[0].onEnd());
    act(() => spoken[1].onEnd());
    expect(onSentenceEnd).toHaveBeenCalledTimes(2);
  });

  it("stops and clears the highlight on stop(), document switch and view leave", async () => {
    const { speech, spoken } = scriptedSpeech();
    let controls!: ReadAloudControls;
    const view = render(
      <Harness speech={speech} onControls={(next) => (controls = next)}>
        {markdownBody}
      </Harness>,
    );
    await act(async () => {});
    act(() => controls.start());
    expect(registry.has(TTS_ACTIVE_ID)).toBe(true);

    act(() => controls.stop());
    expect(controls.status).toBe("idle");
    expect(controls.barOpen).toBe(false);
    expect(registry.has(TTS_ACTIVE_ID)).toBe(false);

    // 重新播放后切换文档 → 自动停止。
    act(() => controls.start());
    expect(controls.status).toBe("playing");
    view.rerender(
      <Harness
        speech={speech}
        onControls={(next) => (controls = next)}
        contentKey="other.md"
      >
        {markdownBody}
      </Harness>,
    );
    expect(controls.status).toBe("idle");
    expect(registry.has(TTS_ACTIVE_ID)).toBe(false);

    // 再播放后离开阅读视图 → 自动停止。
    act(() => controls.start());
    view.rerender(
      <Harness
        speech={speech}
        onControls={(next) => (controls = next)}
        contentKey="other.md"
        active={false}
      >
        {markdownBody}
      </Harness>,
    );
    expect(controls.status).toBe("idle");
    void spoken;
  });

  it("pauses at sentence granularity and resumes the current sentence", async () => {
    const { speech, spoken, cancel } = scriptedSpeech();
    let controls!: ReadAloudControls;
    render(
      <Harness speech={speech} onControls={(next) => (controls = next)}>
        {markdownBody}
      </Harness>,
    );
    await act(async () => {});
    act(() => controls.start());
    act(() => spoken[0].onEnd());
    expect(spoken).toHaveLength(2);

    act(() => controls.toggle());
    expect(controls.status).toBe("paused");
    expect(cancel).toHaveBeenCalled();

    act(() => controls.toggle());
    expect(controls.status).toBe("playing");
    // 恢复 = 从当前句(第二句)重新朗读。
    expect(spoken[2].text).toBe("第二句。");
  });

  it("supports next/previous while playing", async () => {
    const { speech, spoken } = scriptedSpeech();
    let controls!: ReadAloudControls;
    render(
      <Harness speech={speech} onControls={(next) => (controls = next)}>
        {markdownBody}
      </Harness>,
    );
    await act(async () => {});
    act(() => controls.start());
    act(() => controls.next());
    expect(spoken[spoken.length - 1].text).toBe("第二句。");
    act(() => controls.previous());
    expect(spoken[spoken.length - 1].text).toBe("第一句。");
  });

  it("notices instead of playing when there is no readable body", async () => {
    const { speech, spoken } = scriptedSpeech();
    const onNotice = vi.fn();
    let controls!: ReadAloudControls;
    render(
      <Harness speech={speech} onControls={(next) => (controls = next)} onNotice={onNotice}>
        <div className="markdown-body">
          <pre>
            <code>only code here</code>
          </pre>
        </div>
      </Harness>,
    );
    await act(async () => {});
    act(() => controls.start());
    expect(onNotice).toHaveBeenCalledWith("当前文档没有可朗读的正文。");
    expect(controls.barOpen).toBe(false);
    expect(spoken).toHaveLength(0);
  });

  it("filters non-local voices and renders unsupported without speech", async () => {
    const { speech } = scriptedSpeech([
      { name: "Online Neural", lang: "zh-CN", localService: true, default: false },
      { name: "Cloud Voice", lang: "en-US", localService: false, default: false },
      { name: "Huihui", lang: "zh-CN", localService: true, default: false },
    ]);
    let controls!: ReadAloudControls;
    const view = render(
      <Harness speech={speech} onControls={(next) => (controls = next)}>
        {markdownBody}
      </Harness>,
    );
    await act(async () => {});
    expect(controls.voices.map((voice) => voice.name)).toEqual(["Huihui"]);
    view.unmount();

    let unsupported!: ReadAloudControls;
    render(
      <Harness speech={null} onControls={(next) => (unsupported = next)}>
        {markdownBody}
      </Harness>,
    );
    expect(unsupported.supported).toBe(false);
    expect(unsupported.voicesReady).toBe(true);
    // start 在不支持的环境下是安全的 no-op。
    act(() => unsupported.start());
    expect(unsupported.status).toBe("idle");
  });
});
