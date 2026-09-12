// D12：从 App.tsx 提取的全局快捷键监听（行为/依赖数组不变，仅移动）。
import { useEffect, type RefObject } from "react";
import { APP_RUNTIME, type DocumentContent } from "./backend";
import type { AnnotationToolPreference } from "../store/useReaderStore";

const IS_WEB_RUNTIME = APP_RUNTIME === "web";

export function useReaderHotkeys({
  canUndo,
  chooseAndOpenLibrary,
  clearRelocatePreview,
  closeFind,
  currentContent,
  currentPath,
  dismissReadNext,
  findOpen,
  handleCreateBookmark,
  handleNavBack,
  handleNavForward,
  handleUndoAnnotation,
  closeRelatedPassages,
  openFind,
  openFolderDocsList,
  autoPaceBarOpen,
  autoPaceStop,
  annotationTool,
  setAnnotationTool,
  searchRef,
  setSettingsOpen,
  setStylePickerOpen,
  setAnnotationPanelOpen,
  setCollectionsPopoverOpen,
  setLibrarySwitcherOpen,
  setCommandPaletteOpen,
  setFolderDocsOpen,
  setCompactTocOpen,
  setMobileLibraryOpen,
  setPendingSelection,
  setNoteDraft,
  setMarkEditor,
  setQuoteCardSource,
  setBookDigestOpen,
}: {
  canUndo: boolean;
  chooseAndOpenLibrary: () => void | Promise<void>;
  clearRelocatePreview: () => void;
  closeFind: () => void;
  currentContent: DocumentContent | null;
  currentPath: string | null;
  dismissReadNext: () => void;
  findOpen: boolean;
  handleCreateBookmark: () => void | Promise<void>;
  handleNavBack: () => void;
  handleNavForward: () => void;
  handleUndoAnnotation: () => void | Promise<void>;
  closeRelatedPassages: () => void;
  openFind: () => void;
  openFolderDocsList: () => void;
  autoPaceBarOpen: boolean;
  autoPaceStop: () => void;
  annotationTool: AnnotationToolPreference;
  setAnnotationTool: (tool: AnnotationToolPreference) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  setSettingsOpen: (open: boolean) => void;
  setStylePickerOpen: (open: boolean) => void;
  setAnnotationPanelOpen: (open: boolean) => void;
  setCollectionsPopoverOpen: (open: boolean) => void;
  setLibrarySwitcherOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  setFolderDocsOpen: (open: boolean) => void;
  setCompactTocOpen: (open: boolean) => void;
  setMobileLibraryOpen: (open: boolean) => void;
  setPendingSelection: (value: null) => void;
  setNoteDraft: (value: null) => void;
  setMarkEditor: (value: null) => void;
  setQuoteCardSource: (value: null) => void;
  setBookDigestOpen: (open: boolean) => void;
}): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Alt+←/→:阅读回退栈(plan-nav-history)。必须 preventDefault,
      // 否则 WebView2/浏览器把 Alt+← 当整页 history back。
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          handleNavBack();
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          handleNavForward();
          return;
        }
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) {
        if (event.key === "Escape") {
          if (findOpen) {
            closeFind();
            return;
          }
          if (autoPaceBarOpen) {
            autoPaceStop();
            return;
          }
          if (annotationTool !== "view") {
            setAnnotationTool("view");
          }
          setSettingsOpen(false);
          setStylePickerOpen(false);
          setAnnotationPanelOpen(false);
          setCollectionsPopoverOpen(false);
          setLibrarySwitcherOpen(false);
          setCommandPaletteOpen(false);
          setFolderDocsOpen(false);
          setCompactTocOpen(false);
          setMobileLibraryOpen(false);
          setPendingSelection(null);
          setNoteDraft(null);
          setMarkEditor(null);
          setQuoteCardSource(null);
          setBookDigestOpen(false);
          dismissReadNext();
          closeRelatedPassages();
          clearRelocatePreview();
        }
        return;
      }
      if (event.key.toLowerCase() === "z" && !event.shiftKey) {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        if (!canUndo) return;
        event.preventDefault();
        void handleUndoAnnotation();
        return;
      }
      if (event.key.toLowerCase() === "o" && !event.shiftKey && !event.altKey) {
        if (IS_WEB_RUNTIME) return;
        event.preventDefault();
        void chooseAndOpenLibrary();
      } else if (event.key.toLowerCase() === "o" && event.shiftKey && !event.altKey) {
        event.preventDefault();
        openFolderDocsList();
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key.toLowerCase() === "p" && !event.shiftKey && !event.altKey) {
        // WebView2/浏览器把 Ctrl+P 默认给系统打印;开与关都要拦掉。
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
      } else if (event.key.toLowerCase() === "b") {
        if (!currentPath || !currentContent) return;
        event.preventDefault();
        void handleCreateBookmark();
      } else if (event.key.toLowerCase() === "f" && !event.shiftKey && !event.altKey) {
        if (IS_WEB_RUNTIME) return;
        const target = event.target;
        if (target instanceof HTMLElement && target.closest(".secondary-pane")) return;
        event.preventDefault();
        openFind();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    canUndo,
    chooseAndOpenLibrary,
    clearRelocatePreview,
    closeFind,
    currentContent,
    currentPath,
    dismissReadNext,
    findOpen,
    handleCreateBookmark,
    handleNavBack,
    handleNavForward,
    handleUndoAnnotation,
    closeRelatedPassages,
    openFind,
    openFolderDocsList,
    autoPaceBarOpen,
    autoPaceStop,
    annotationTool,
    setAnnotationTool,
    searchRef,
    setSettingsOpen,
    setStylePickerOpen,
    setAnnotationPanelOpen,
    setCollectionsPopoverOpen,
    setLibrarySwitcherOpen,
    setCommandPaletteOpen,
    setFolderDocsOpen,
    setCompactTocOpen,
    setMobileLibraryOpen,
    setPendingSelection,
    setNoteDraft,
    setMarkEditor,
    setQuoteCardSource,
    setBookDigestOpen,
  ]);
}
