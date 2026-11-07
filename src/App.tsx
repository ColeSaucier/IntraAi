import React, { useState, useEffect, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { PhysicalPosition, PhysicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";

const DEFAULT_LAYOUT = { tools: 22, main: 62, ai: 38 };
const MAX_TABS = 6;
const MINIMIZED_STRIP = 6;
const BOTH_MINIMIZED = 10;
const STORAGE_KEY = "intraai-session";
const NOTES_KEY = "intraai-notes";

const LLMS = [
  { name: "Grok", url: "https://grok.com" },
  { name: "ChatGPT", url: "https://chat.openai.com" },
  { name: "Claude", url: "https://claude.ai" },
  { name: "Gemini", url: "https://gemini.google.com" },
  { name: "Perplexity", url: "https://www.perplexity.ai" },
];

type Tab = {
  id: string;
  url: string;
  title: string;
  history: string[];
  historyIndex: number;
};

type ToolType = "ai-context" | "youtube-related" | "notes" | "external-app";

type ToolWindow = {
  id: string;
  type: ToolType;
  label: string;
  minimized: boolean;
  appName?: string;
};

type Note = { id: string; title: string; content: string };

type Session = {
  tabs: Tab[];
  activeTabId: string;
  aiUrl: string | null;
  aiContextUrl: string | null;
  toolWindows: ToolWindow[];
  aiContextQueryOpen: boolean;
  autoSendOnInject: boolean;
};

const loadSession = (): Session | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Ensure older sessions get history fields
    if (parsed.tabs) {
      parsed.tabs = parsed.tabs.map((t: any) => ({
        ...t,
        history: t.history || [t.url],
        historyIndex: t.historyIndex ?? 0,
      }));
    }
    return parsed;
  } catch {
    return null;
  }
};

const saveSession = (data: Session) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
};

const loadNotes = (): Note[] => {
  try {
    const raw = localStorage.getItem(NOTES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
};

const saveNotes = (notes: Note[]) => {
  try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch {}
};

export default function App() {
  const [layout, setLayout] = useState(DEFAULT_LAYOUT);
  const [installedApps, setInstalledApps] = useState<string[]>([]);
  const [isToolsMinimized, setIsToolsMinimized] = useState(false);
  const [isBrowserMinimized, setIsBrowserMinimized] = useState(false);
  const [isAIMinimized, setIsAIMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [notes, setNotes] = useState<Note[]>(loadNotes);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const initialSession = useRef(loadSession()).current;

  const [session, setSession] = useState<Session>(() => {
    if (initialSession) return initialSession;
    return {
      tabs: [{ id: "tab-1", url: "https://example.com", title: "Example", history: ["https://example.com"], historyIndex: 0 }],
      activeTabId: "tab-1",
      aiUrl: null,
      aiContextUrl: null,
      toolWindows: [],
      aiContextQueryOpen: true,
      autoSendOnInject: false,
    };
  });

  const [inputUrl, setInputUrl] = useState(
    session.tabs.find((t) => t.id === session.activeTabId)?.url || "https://example.com"
  );

  const browserContainerRef = useRef<HTMLDivElement>(null);
  const aiContainerRef = useRef<HTMLDivElement>(null);
  const webviewsRef = useRef<Map<string, Webview>>(new Map());
  const aiWebviewRef = useRef<Webview | null>(null);
  const aiContextWebviewRef = useRef<Webview | null>(null);
  const aiContextLabelRef = useRef<string | null>(null);
  const youtubeWebviewRef = useRef<Webview | null>(null);
  const youtubeLabelRef = useRef<string | null>(null);
  const creatingRef = useRef<Set<string>>(new Set());
  const syncTimeouts = useRef<number[]>([]);
  const chromeRef = useRef<HTMLDivElement>(null);
  const hasRestored = useRef(false);
  const aiContextReadyPromise = useRef<{ resolve: (label: string) => void; reject: (e: any) => void } | null>(null);
  const lastAiUrlSet = useRef<string | null>(null);
  const lastAiContextUrlSet = useRef<string | null>(null);

  const TOOL_OPTIONS: { type: ToolType; label: string; unique?: boolean }[] = [
    { type: "ai-context", label: "AI Context", unique: true },
    { type: "youtube-related", label: "Related Content", unique: true },
    { type: "notes", label: "Notes" },
    { type: "external-app", label: "External App", unique: true },
  ];

  const toolContainerRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const TOOL_STRIP = 8;

  const minimizedCount = session.toolWindows.filter((t) => t.minimized).length;
  const openCount = session.toolWindows.length - minimizedCount;
  const remaining = Math.max(0, 100 - minimizedCount * TOOL_STRIP);
  const openSize = openCount > 0 ? remaining / openCount : 0;

  useEffect(() => {
    invoke<string[]>("list_installed_apps")
      .then(setInstalledApps)
      .catch((e) => console.warn("Failed to list apps", e));
  }, []);

  useEffect(() => {
    if (!hasRestored.current) return;
    saveSession(session);
  }, [session]);

  useEffect(() => {
    hasRestored.current = true;
    if (session.aiUrl) setTimeout(() => openAi(session.aiUrl!), 400);
    const hasAiContext = session.toolWindows.some((t) => t.type === "ai-context");
    const urlToRestore = session.aiContextUrl || session.aiUrl;
    if (hasAiContext && urlToRestore) setTimeout(() => openAiContext(urlToRestore), 600);
    const hasYoutube = session.toolWindows.some((t) => t.type === "youtube-related");
    if (hasYoutube) setTimeout(() => openYoutube("https://www.youtube.com"), 700);
  }, []);

  const updateSession = (patch: Partial<Session>) => {
    setSession((prev) => ({ ...prev, ...patch }));
  };

  const addTool = (type: ToolType) => {
    const def = TOOL_OPTIONS.find((t) => t.type === type);
    if (!def) return;
    if (def.unique && session.toolWindows.some((w) => w.type === type)) return;

    const id = `${type}-${Date.now()}`;
    const newTools = [...session.toolWindows, { id, type, label: def.label, minimized: false }];
    updateSession({ toolWindows: newTools });

    if (type === "ai-context") {
      const urlToUse = session.aiContextUrl || session.aiUrl || "https://grok.com";
      updateSession({ aiContextUrl: urlToUse, toolWindows: newTools });
      openAiContext(urlToUse);
    }
    if (type === "youtube-related") openYoutube("https://www.youtube.com");
  };

  const toggleToolMinimized = (id: string) => {
    updateSession({
      toolWindows: session.toolWindows.map((w) =>
        w.id === id ? { ...w, minimized: !w.minimized } : w
      ),
    });
    setTimeout(() => {
      syncAiContextWebview();
      syncYoutubeWebview();
      session.toolWindows.forEach((t) => {
        if (t.type === "external-app" && t.appName && !t.minimized) {
          placeExternalApp(t.id, t.appName);
        }
      });
    }, 50);
  };

  const removeTool = (id: string) => {
    const tool = session.toolWindows.find((w) => w.id === id);
    updateSession({ toolWindows: session.toolWindows.filter((w) => w.id !== id) });
    toolContainerRefs.current.delete(id);
    if (tool?.type === "ai-context" && aiContextWebviewRef.current) {
      aiContextWebviewRef.current.close().catch(() => {});
      aiContextWebviewRef.current = null;
      aiContextLabelRef.current = null;
    }
    if (tool?.type === "youtube-related" && youtubeWebviewRef.current) {
      youtubeWebviewRef.current.close().catch(() => {});
      youtubeWebviewRef.current = null;
      youtubeLabelRef.current = null;
    }
  };

  const setExternalApp = (toolId: string, appName: string) => {
    updateSession({
      toolWindows: session.toolWindows.map((w) =>
        w.id === toolId ? { ...w, appName, label: appName } : w
      ),
    });
    setTimeout(() => placeExternalApp(toolId, appName), 150);
  };

  const placeExternalApp = async (toolId: string, appName: string) => {
    const bounds = await getToolBounds(toolId);
    if (!bounds || bounds.width < 50 || bounds.height < 50) return;
    try {
      await invoke("place_external_app", {
        appName,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
    } catch (e) {
      console.warn("place_external_app failed", e);
    }
  };

  const getToolBounds = async (id: string) => {
    const el = toolContainerRefs.current.get(id);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const headerHeight = 32;
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top + headerHeight),
      width: Math.round(rect.width),
      height: Math.round(rect.height - headerHeight),
    };
  };

  const getWebToolBounds = async (id: string) => {
    const el = toolContainerRefs.current.get(id);
    if (!el) return null;
    const scale = await getCurrentWindow().scaleFactor();
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left * scale),
      y: Math.round(rect.top * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
    };
  };

  // Notes helpers
  const openNote = (note: Note) => {
    setEditingNoteId(note.id);
    setNoteDraft(note.content);
  };

  const saveCurrentNote = () => {
    if (!editingNoteId) return;
    const updated = notes.map((n) =>
      n.id === editingNoteId ? { ...n, content: noteDraft } : n
    );
    setNotes(updated);
    saveNotes(updated);
  };

  const createNote = () => {
    const id = `note-${Date.now()}`;
    const newNote: Note = { id, title: "Untitled", content: "" };
    const updated = [...notes, newNote];
    setNotes(updated);
    saveNotes(updated);
    openNote(newNote);
  };

  const backToGrid = () => {
    saveCurrentNote();
    setEditingNoteId(null);
  };

  useEffect(() => {
    const saved = localStorage.getItem("layout-template");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setLayout(parsed.layout || DEFAULT_LAYOUT);
        setIsToolsMinimized(!!parsed.isToolsMinimized);
        setIsBrowserMinimized(!!parsed.isBrowserMinimized);
        setIsAIMinimized(!!parsed.isAIMinimized);
      } catch {}
    }
  }, []);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    appWindow.setTitleBarStyle("overlay").catch(() => {});
    appWindow.setTitle("").catch(() => {});

    const updateMaximized = async () => {
      try {
        const maximized = await appWindow.isMaximized();
        const fullscreen = await appWindow.isFullscreen();
        setIsMaximized(maximized || fullscreen);
      } catch {}
    };
    updateMaximized();

    let unlisten: (() => void) | undefined;
    appWindow.onResized(() => updateMaximized()).then((fn) => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ url?: string }>("open-in-new-tab", (event) => {
      const url = event.payload?.url;
      if (url) openUrlInNewTab(url);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [session.tabs.length]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ url: string }>("ai-url-changed", (event) => {
      const url = event.payload?.url;
      if (!url || url === lastAiUrlSet.current) return;
      console.log("[ai-url-changed] detected", url);
      lastAiUrlSet.current = url;
      updateSession({ aiUrl: url });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ url: string }>("ai-context-url-changed", (event) => {
      const url = event.payload?.url;
      if (!url || url === lastAiContextUrlSet.current) return;
      console.log("[ai-context-url-changed] detected", url);
      lastAiContextUrlSet.current = url;
      updateSession({ aiContextUrl: url });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ tabId: string; url: string }>("browser-url-changed", (event) => {
      const { tabId, url } = event.payload || {};
      if (!tabId || !url) return;

      console.log("[browser-url-changed]", tabId, url);

      setSession((prev) => {
        const updated = prev.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                url,
                title: url.replace(/^https?:\/\//, "").slice(0, 24),
              }
            : t
        );
        return { ...prev, tabs: updated };
      });

      if (tabId === session.activeTabId) {
        setInputUrl(url);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [session.activeTabId]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (isBrowserMinimized) return;
      const tabId = session.activeTabId;
      const wv = webviewsRef.current.get(tabId);
      if (!wv) return;

      injectBrowserUrlWatcher(wv.label, tabId).catch(() => {});
      injectContextMenu(wv.label).catch(() => {});
    }, 1200);

    return () => clearInterval(interval);
  }, [session.activeTabId, isBrowserMinimized]);

// Update the menu listener to include Open Link in New Tab
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ text?: string; href?: string; x?: number; y?: number }>("ai-context-selection", async (event) => {
      const text = event.payload?.text?.trim();
      const href = event.payload?.href;
      if (!text && !href) return;

      let logicalX = event.payload?.x ?? 100;
      let logicalY = event.payload?.y ?? 100;

      const container = browserContainerRef.current;
      const chrome = chromeRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const chromeHeight = chrome?.offsetHeight ?? 0;
        logicalX = rect.left + (event.payload?.x ?? 0);
        logicalY = rect.top + chromeHeight + (event.payload?.y ?? 0);
      }

      const items: any[] = [];
      if (text) {
        items.push({
          id: "explain",
          text: "Explain with AI Context",
          action: async () => {
            let hasAiContext = session.toolWindows.some((t) => t.type === "ai-context");
            if (!hasAiContext) {
              addTool("ai-context");
              await new Promise((r) => setTimeout(r, 200));
            }
            const label = await new Promise<string | null>((resolve) => {
              if (aiContextLabelRef.current) {
                resolve(aiContextLabelRef.current);
                return;
              }
              const timeout = setTimeout(() => resolve(null), 5000);
              aiContextReadyPromise.current = {
                resolve: (lbl) => { clearTimeout(timeout); resolve(lbl); },
                reject: () => { clearTimeout(timeout); resolve(null); },
              };
            });
            if (!label) return;
            scheduleSyncs([50, 150, 400, 800]);
            const prompt = `Provide context or definition or summary explanation of ${text}`;
            injectAiContextPrompt(prompt);
          },
        });
        items.push({
          id: "youtube",
          text: "Find Related Youtube",
          action: async () => {
            const query = text.slice(0, 100);
            const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
            let hasYoutube = session.toolWindows.some((t) => t.type === "youtube-related");
            if (!hasYoutube) {
              addTool("youtube-related");
              await new Promise((r) => setTimeout(r, 300));
            }
            openYoutube(searchUrl);
          },
        });
      }
      if (href) {
        items.push({
          id: "open-new-tab",
          text: "Open Link in New Tab",
          action: () => openUrlInNewTab(href),
        });
      }

      try {
        const menu = await Menu.new({ items });
        await menu.popup(new LogicalPosition(logicalX, logicalY));
      } catch (e) {
        console.warn("Failed to show menu", e);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [session.toolWindows, session.aiContextUrl, session.aiUrl, session.tabs.length]);

  const clearSyncTimeouts = () => {
    syncTimeouts.current.forEach((id) => clearTimeout(id));
    syncTimeouts.current = [];
  };

  const scheduleSyncs = (delays = [100, 300, 600, 1000]) => {
    clearSyncTimeouts();
    delays.forEach((delay) => {
      const id = window.setTimeout(() => {
        syncAllWebviews();
        syncAiWebview();
        syncAiContextWebview();
        syncYoutubeWebview();
      }, delay);
      syncTimeouts.current.push(id);
    });
  };

  const getChromeBounds = async () => {
    const container = browserContainerRef.current;
    if (!container) return null;
    const chromeHeightCss = chromeRef.current?.offsetHeight ?? 0;
    const scale = await getCurrentWindow().scaleFactor();
    const chromeHeight = Math.round(chromeHeightCss * scale);
    const rect = container.getBoundingClientRect();
    return {
      x: Math.round(rect.left * scale),
      y: Math.round(rect.top + chromeHeight),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale - chromeHeight),
    };
  };

  const getAiBounds = async () => {
    const container = aiContainerRef.current;
    if (!container) return null;
    const scale = await getCurrentWindow().scaleFactor();
    const rect = container.getBoundingClientRect();
    const header = 36;
    return {
      x: Math.round(rect.left * scale),
      y: Math.round((rect.top + header) * scale),
      width: Math.round(rect.width * scale),
      height: Math.round((rect.height - header) * scale),
    };
  };

  const syncAllWebviews = async () => {
    if (isBrowserMinimized) {
      for (const wv of webviewsRef.current.values()) {
        await wv.setSize(new PhysicalSize(0, 0)).catch(() => {});
      }
      return;
    }
    const bounds = await getChromeBounds();
    if (!bounds || bounds.width < 50 || bounds.height < 50) return;
    for (const [id, wv] of webviewsRef.current.entries()) {
      try {
        if (id === session.activeTabId) {
          await wv.setPosition(new PhysicalPosition(bounds.x, bounds.y));
          await wv.setSize(new PhysicalSize(bounds.width, bounds.height));
        } else {
          await wv.setPosition(new PhysicalPosition(-10000, -10000));
          await wv.setSize(new PhysicalSize(0, 0));
        }
      } catch (e) {
        console.warn("sync failed for", id, e);
      }
    }
  };

  const syncAiWebview = async () => {
    const wv = aiWebviewRef.current;
    if (!wv) return;
    if (isAIMinimized) {
      await wv.setSize(new PhysicalSize(0, 0)).catch(() => {});
      return;
    }
    const bounds = await getAiBounds();
    if (!bounds || bounds.width < 50 || bounds.height < 50) return;
    try {
      await wv.setPosition(new PhysicalPosition(bounds.x, bounds.y));
      await wv.setSize(new PhysicalSize(bounds.width, bounds.height));
    } catch (e) {
      console.warn("AI sync failed", e);
    }
  };

  const syncAiContextWebview = async () => {
    const wv = aiContextWebviewRef.current;
    if (!wv) return;
    const tool = session.toolWindows.find((t) => t.type === "ai-context");
    if (!tool || tool.minimized) {
      await wv.setSize(new PhysicalSize(0, 0)).catch(() => {});
      return;
    }
    const bounds = await getWebToolBounds(tool.id);
    if (!bounds || bounds.width < 50 || bounds.height < 50) {
      await wv.setSize(new PhysicalSize(0, 0)).catch(() => {});
      return;
    }
    try {
      await wv.setPosition(new PhysicalPosition(bounds.x, bounds.y));
      await wv.setSize(new PhysicalSize(bounds.width, bounds.height));
    } catch (e) {
      console.warn("AI Context sync failed", e);
    }
  };

  const syncYoutubeWebview = async () => {
    const wv = youtubeWebviewRef.current;
    if (!wv) return;
    const tool = session.toolWindows.find((t) => t.type === "youtube-related");
    if (!tool || tool.minimized) {
      await wv.setSize(new PhysicalSize(0, 0)).catch(() => {});
      return;
    }
    const bounds = await getWebToolBounds(tool.id);
    if (!bounds || bounds.width < 50 || bounds.height < 50) {
      await wv.setSize(new PhysicalSize(0, 0)).catch(() => {});
      return;
    }
    try {
      await wv.setPosition(new PhysicalPosition(bounds.x, bounds.y));
      await wv.setSize(new PhysicalSize(bounds.width, bounds.height));
    } catch (e) {
      console.warn("YouTube sync failed", e);
    }
  };

  const isHistoryNav = useRef(false);
  const pushHistory = (tabId: string, url: string) => {
    setSession((prev) => {
      const tabs = prev.tabs.map((t) => {
        if (t.id !== tabId) return t;

        const existingIndex = t.history.indexOf(url);
        if (existingIndex !== -1) {
          // URL already in history — just move the index, do not modify the list
          return { ...t, url, historyIndex: existingIndex, title: url.replace(/^https?:\/\//, "").slice(0, 24) };
        }

        // New URL — truncate forward history and append
        const newHistory = t.history.slice(0, t.historyIndex + 1);
        newHistory.push(url);
        return {
          ...t,
          url,
          history: newHistory,
          historyIndex: newHistory.length - 1,
          title: url.replace(/^https?:\/\//, "").slice(0, 24),
        };
      });
      return { ...prev, tabs };
    });
  };

const goBack = async () => {
  const activeId = session.activeTabId;
  const tab = session.tabs.find((t) => t.id === activeId);
  if (!tab?.history || tab.historyIndex <= 0) return;

  const newIndex = tab.historyIndex - 1;
  const url = tab.history[newIndex];
  const title = url.replace(/^https?:\/\//, "").slice(0, 24);

  isHistoryNav.current = true;

  setSession((prev) => ({
    ...prev,
    tabs: prev.tabs.map((t) =>
      t.id === activeId ? { ...t, historyIndex: newIndex, url, title } : t
    ),
  }));
  setInputUrl(url);

  const existing = webviewsRef.current.get(activeId);
  if (existing) {
    await existing.close().catch(() => {});
    webviewsRef.current.delete(activeId);
  }

  setTimeout(() => {
    const updated = session.tabs.find((t) => t.id === activeId);
    if (updated) ensureWebview({ ...updated, url, title });
    setTimeout(() => { isHistoryNav.current = false; }, 600);
  }, 100);
};

const goForward = async () => {
  const activeId = session.activeTabId;
  const tab = session.tabs.find((t) => t.id === activeId);
  if (!tab?.history || tab.historyIndex >= tab.history.length - 1) return;

  const newIndex = tab.historyIndex + 1;
  const url = tab.history[newIndex];
  const title = url.replace(/^https?:\/\//, "").slice(0, 24);

  isHistoryNav.current = true;

  setSession((prev) => ({
    ...prev,
    tabs: prev.tabs.map((t) =>
      t.id === activeId ? { ...t, historyIndex: newIndex, url, title } : t
    ),
  }));
  setInputUrl(url);

  const existing = webviewsRef.current.get(activeId);
  if (existing) {
    await existing.close().catch(() => {});
    webviewsRef.current.delete(activeId);
  }

  setTimeout(() => {
    const updated = session.tabs.find((t) => t.id === activeId);
    if (updated) ensureWebview({ ...updated, url, title });
    setTimeout(() => { isHistoryNav.current = false; }, 600);
  }, 100);
};

  // Update the browser-url-changed listener to call pushHistory
useEffect(() => {
  let unlisten: (() => void) | undefined;
  let cancelled = false;

  listen<{ tabId: string; url: string }>("browser-url-changed", (event) => {
    const { tabId, url } = event.payload || {};
    if (!tabId || !url) return;
    if (isHistoryNav.current) return;

    // Also skip if this tab is already on that URL at the current index
    const tab = session.tabs.find((t) => t.id === tabId);
    if (tab && tab.history[tab.historyIndex] === url) return;

    pushHistory(tabId, url);
    if (tabId === session.activeTabId) setInputUrl(url);
  }).then((fn) => { unlisten = fn; });

  return () => {
    cancelled = true;
    if (unlisten) unlisten();
  };
}, [session.activeTabId]);

  // Update injectContextMenu to also capture links
  const injectContextMenu = async (label: string) => {
    const script = `
      if (!window.__aiContextMenuAttached) {
        window.__aiContextMenuAttached = true;
        document.addEventListener('contextmenu', (e) => {
          const sel = window.getSelection();
          const text = sel ? sel.toString().trim() : '';
          const link = e.target.closest('a');
          const href = link ? link.href : null;
          if ((text || href) && window.__TAURI__?.event?.emit) {
            e.preventDefault();
            e.stopPropagation();
            window.__TAURI__.event.emit('ai-context-selection', {
              text, href, x: e.clientX, y: e.clientY
            });
          }
        }, true);
      }
    `;
    try { await invoke("eval_on_webview", { label, script }); } catch {}
  };

  const injectBrowserUrlWatcher = async (label: string, tabId: string) => {
    const script = `
      (function() {
        if (window.__browserUrlWatcherInstalled) return;
        window.__browserUrlWatcherInstalled = true;
        const emit = (url) => {
          if (window.__TAURI__?.event?.emit) {
            window.__TAURI__.event.emit('browser-url-changed', { tabId: '${tabId}', url });
          }
        };
        const origPush = history.pushState;
        const origReplace = history.replaceState;
        history.pushState = function() {
          origPush.apply(this, arguments);
          emit(location.href);
        };
        history.replaceState = function() {
          origReplace.apply(this, arguments);
          emit(location.href);
        };
        window.addEventListener('popstate', () => emit(location.href));
        window.addEventListener('hashchange', () => emit(location.href));
        const observer = new MutationObserver(() => emit(location.href));
        observer.observe(document, { subtree: true, childList: true });
        emit(location.href);
      })();
    `;
    try {
      await invoke("eval_on_webview", { label, script });
    } catch (e) {
      console.warn("browser url watcher inject failed", e);
    }
  };

  const ensureWebview = async (tab: Tab) => {
    if (webviewsRef.current.has(tab.id) || creatingRef.current.has(tab.id)) return;
    creatingRef.current.add(tab.id);
    const appWindow = getCurrentWindow();
    try {
      const webview = new Webview(appWindow, `browser-${tab.id}-${Date.now()}`, {
        url: tab.url,
        x: -10000,
        y: -10000,
        width: 0,
        height: 0,
      });
      webview.once("tauri://created", async () => {
        webviewsRef.current.set(tab.id, webview);
        creatingRef.current.delete(tab.id);
        try {
          if (typeof (webview as any).on === "function") {
            (webview as any).on("tauri://new-window", (event: any) => {
              const url = event.payload?.url;
              if (url) openUrlInNewTab(url);
            });
          }
        } catch {}
        await injectContextMenu(webview.label);
        setTimeout(() => injectBrowserUrlWatcher(webview.label, tab.id), 300);
        scheduleSyncs([100, 300, 600, 1000]);
      });
      webview.once("tauri://error", () => {
        creatingRef.current.delete(tab.id);
      });
    } catch {
      creatingRef.current.delete(tab.id);
    }
  };

  const injectUrlWatcher = async (label: string, eventName: string) => {
    const script = `
      (function() {
        if (window.__urlWatcherInstalled) return;
        window.__urlWatcherInstalled = true;
        const emit = (url) => {
          if (window.__TAURI__?.event?.emit) {
            window.__TAURI__.event.emit('${eventName}', { url });
          }
        };
        const origPush = history.pushState;
        const origReplace = history.replaceState;
        history.pushState = function() {
          origPush.apply(this, arguments);
          emit(location.href);
        };
        history.replaceState = function() {
          origReplace.apply(this, arguments);
          emit(location.href);
        };
        window.addEventListener('popstate', () => emit(location.href));
        window.addEventListener('hashchange', () => emit(location.href));
        const observer = new MutationObserver(() => emit(location.href));
        observer.observe(document, { subtree: true, childList: true });
        emit(location.href);
      })();
    `;
    try {
      await invoke("eval_on_webview", { label, script });
    } catch (e) {
      console.warn("url watcher inject failed", e);
    }
  };

  const applyAiContextUiSettings = async (label: string) => {
    const show = session.aiContextQueryOpen;
    const script = `
      (function() {
        const form = document.querySelector('form[data-composer="true"]');
        const bar = document.querySelector('.query-bar');
        const target = form || bar;
        if (target) {
          target.style.display = ${show ? "'block'" : "'none'"};
        }
      })();
    `;
    try {
      await invoke("eval_on_webview", { label, script });
    } catch (e) {
      console.warn("applyAiContextUiSettings failed", e);
    }
  };

  const openAi = async (url: string) => {
    console.log("[openAi] opening", url);
    lastAiUrlSet.current = url;
    updateSession({ aiUrl: url });

    if (aiWebviewRef.current) {
      await aiWebviewRef.current.close().catch(() => {});
      aiWebviewRef.current = null;
    }

    const appWindow = getCurrentWindow();
    try {
      const webview = new Webview(appWindow, `ai-view-${Date.now()}`, {
        url,
        x: -10000,
        y: -10000,
        width: 0,
        height: 0,
      });
      webview.once("tauri://created", async () => {
        aiWebviewRef.current = webview;
        scheduleSyncs([100, 300, 600, 1000]);
        setTimeout(() => injectUrlWatcher(webview.label, "ai-url-changed"), 500);
      });
    } catch (e) {
      console.error("Failed to open AI webview", e);
    }
  };

  const openAiContext = async (url: string) => {
    console.log("[openAiContext] opening", url);
    lastAiContextUrlSet.current = url;
    updateSession({ aiContextUrl: url });

    if (aiContextWebviewRef.current) {
      await aiContextWebviewRef.current.close().catch(() => {});
      aiContextWebviewRef.current = null;
      aiContextLabelRef.current = null;
    }

    const appWindow = getCurrentWindow();
    const label = `ai-context-${Date.now()}`;
    try {
      const webview = new Webview(appWindow, label, {
        url,
        x: -10000,
        y: -10000,
        width: 0,
        height: 0,
      });
      webview.once("tauri://created", async () => {
        aiContextWebviewRef.current = webview;
        aiContextLabelRef.current = label;
        console.log("[openAiContext] webview ready, label:", label);
        if (aiContextReadyPromise.current) {
          aiContextReadyPromise.current.resolve(label);
          aiContextReadyPromise.current = null;
        }
        scheduleSyncs([50, 150, 300, 600, 1000, 1500]);
        setTimeout(() => injectUrlWatcher(label, "ai-context-url-changed"), 500);
        setTimeout(() => applyAiContextUiSettings(label), 800);
      });
    } catch (e) {
      console.error("Failed to open AI Context webview", e);
      if (aiContextReadyPromise.current) {
        aiContextReadyPromise.current.reject(e);
        aiContextReadyPromise.current = null;
      }
    }
  };

  const openYoutube = async (url: string) => {
    console.log("[openYoutube] opening", url);

    if (youtubeWebviewRef.current) {
      await youtubeWebviewRef.current.close().catch(() => {});
      youtubeWebviewRef.current = null;
      youtubeLabelRef.current = null;
    }

    const appWindow = getCurrentWindow();
    const label = `youtube-${Date.now()}`;
    try {
      const webview = new Webview(appWindow, label, {
        url,
        x: -10000,
        y: -10000,
        width: 0,
        height: 0,
      });
      webview.once("tauri://created", async () => {
        youtubeWebviewRef.current = webview;
        youtubeLabelRef.current = label;
        console.log("[openYoutube] webview ready, label:", label);
        scheduleSyncs([50, 150, 300, 600, 1000]);
      });
    } catch (e) {
      console.error("Failed to open YouTube webview", e);
    }
  };

  const toggleAiContextQuery = async () => {
    const next = !session.aiContextQueryOpen;
    updateSession({ aiContextQueryOpen: next });
    const label = aiContextLabelRef.current;
    if (!label) return;
    await applyAiContextUiSettings(label);
  };

  const toggleAutoSend = () => {
    updateSession({ autoSendOnInject: !session.autoSendOnInject });
  };

  const injectAiContextPrompt = async (overrideText?: string) => {
    const label = aiContextLabelRef.current;
    if (!label) {
      console.warn("No AI Context webview label available for inject");
      return;
    }

    const base = overrideText ?? AI_CONTEXT_TEMPLATE;
    const text = base.replace(/`/g, "\\`").replace(/\$/g, "\\$");
    const shouldAutoSend = session.autoSendOnInject;

    const script = `
      (function() {
        const form = document.querySelector('form[data-composer="true"]');
        const bar = document.querySelector('.query-bar');
        const target = form || bar;
        const wasHidden = target && target.style.display === 'none';

        if (target) target.style.display = 'block';

        const editor = document.querySelector('[contenteditable="true"][aria-label="Ask Grok anything"]') ||
                       document.querySelector('[contenteditable="true"]');
        if (editor) {
          editor.innerHTML = '<p>' + ${JSON.stringify(text)} + '</p>';
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          editor.focus();
        }

        ${shouldAutoSend ? `
        setTimeout(() => {
          const btn = document.querySelector('button[data-testid="chat-submit"]') ||
                      document.querySelector('button[aria-label="Submit"]') ||
                      document.querySelector('form[data-composer="true"] button[type="submit"]');
          if (btn) btn.click();
          if (wasHidden && target) {
            setTimeout(() => { target.style.display = 'none'; }, 300);
          }
        }, 200);
        ` : ""}
      })();
    `;

    try {
      await invoke("eval_on_webview", { label, script });
    } catch (e) {
      console.warn("Prompt inject failed", e);
    }
  };

  useEffect(() => {
    const tab = session.tabs.find((t) => t.id === session.activeTabId);
    if (!tab || isBrowserMinimized) return;
    const timer = setTimeout(() => ensureWebview(tab), 200);
    return () => clearTimeout(timer);
  }, [session.activeTabId, isBrowserMinimized, session.tabs]);

  useEffect(() => {
    if (isBrowserMinimized && isAIMinimized) return;
    const appWindow = getCurrentWindow();
    let unlistenResize: (() => void) | undefined;
    let unlistenScale: (() => void) | undefined;
    const handleResize = () => scheduleSyncs([100, 300, 600]);
    appWindow.onResized(handleResize).then((fn) => {
      unlistenResize = fn;
    });
    appWindow.onScaleChanged(handleResize).then((fn) => {
      unlistenScale = fn;
    });
    return () => {
      if (unlistenResize) unlistenResize();
      if (unlistenScale) unlistenScale();
      clearSyncTimeouts();
    };
  }, [isBrowserMinimized, isAIMinimized]);

  useEffect(() => {
    scheduleSyncs([50, 150, 400]);
  }, [session.activeTabId, isBrowserMinimized, isAIMinimized, session.toolWindows]);

  const saveTemplate = () => {
    localStorage.setItem(
      "layout-template",
      JSON.stringify({
        layout,
        isToolsMinimized,
        isBrowserMinimized,
        isAIMinimized,
      })
    );
    alert("Template saved");
  };

  const resetTemplate = () => {
    setLayout(DEFAULT_LAYOUT);
    setIsToolsMinimized(false);
    setIsBrowserMinimized(false);
    setIsAIMinimized(false);
    localStorage.removeItem("layout-template");
  };

  const toggleTools = () => setIsToolsMinimized((p) => !p);
  const toggleBrowser = () => setIsBrowserMinimized((p) => !p);
  const toggleAI = () => setIsAIMinimized((p) => !p);

  const loadUrl = async () => {
    let raw = inputUrl.trim();
    if (!raw) return;

    let url = raw;
    let title = raw;

    if (!raw.includes(".")) {
      url = `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
      title = raw.slice(0, 24);
    } else if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
      url = "https://" + raw;
      title = raw.replace(/^https?:\/\//, "").slice(0, 24);
    } else {
      title = raw.replace(/^https?:\/\//, "").slice(0, 24);
    }

    setInputUrl(url);
    updateSession({
      tabs: session.tabs.map((t) =>
        t.id === session.activeTabId ? { ...t, url, title } : t
      ),
    });

    const existing = webviewsRef.current.get(session.activeTabId);
    if (existing) {
      await existing.close().catch(() => {});
      webviewsRef.current.delete(session.activeTabId);
    }
    setTimeout(() => {
      const tab = session.tabs.find((t) => t.id === session.activeTabId);
      if (tab) ensureWebview({ ...tab, url, title });
    }, 100);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") loadUrl();
  };

  const createTab = (url: string) => {
    const id = `tab-${Date.now()}`;
    const title = url.replace(/^https?:\/\//, "").slice(0, 24);
    return {
      id,
      url,
      title,
      history: [url],
      historyIndex: 0,
    };
  };

  const addTab = () => {
    if (session.tabs.length >= MAX_TABS) return;
    const newTab = createTab("https://example.com");
    updateSession({
      tabs: [...session.tabs, newTab],
      activeTabId: newTab.id,
    });
    setInputUrl(newTab.url);
  };

  const openUrlInNewTab = (url: string) => {
    if (session.tabs.length >= MAX_TABS) return;
    const newTab = createTab(url);
    updateSession({
      tabs: [...session.tabs, newTab],
      activeTabId: newTab.id,
    });
    setInputUrl(newTab.url);
  };

  const closeTab = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (session.tabs.length === 1) return;
    const wv = webviewsRef.current.get(id);
    if (wv) {
      await wv.close().catch(() => {});
      webviewsRef.current.delete(id);
    }
    creatingRef.current.delete(id);
    const next = session.tabs.filter((t) => t.id !== id);
    const newActive = session.activeTabId === id ? next[0].id : session.activeTabId;
    updateSession({ tabs: next, activeTabId: newActive });
    if (session.activeTabId === id) {
      setInputUrl(next[0].url);
    }
  };

  const switchTab = (tab: Tab) => {
    updateSession({ activeTabId: tab.id });
    setInputUrl(tab.url);
  };

  const toolsHeaderPaddingLeft = !isMaximized && !isToolsMinimized ? 80 : isToolsMinimized ? 4 : 8;
  const toolsTopClearance = !isMaximized && isToolsMinimized ? 28 : 0;

  const browserMinSize = isBrowserMinimized
    ? isAIMinimized
      ? BOTH_MINIMIZED
      : MINIMIZED_STRIP
    : 15;
  const aiMinSize = isAIMinimized
    ? isBrowserMinimized
      ? BOTH_MINIMIZED
      : MINIMIZED_STRIP
    : 15;

  const toolsPanelKey = session.toolWindows.map((t) => `${t.id}-${t.minimized}`).join("|");

  return (
    <div style={{ height: "100vh", width: "100vw", overflow: "hidden" }}>
      <PanelGroup
        key={isToolsMinimized ? "tools-min" : "tools-exp"}
        direction="horizontal"
        style={{ height: "100%" }}
      >
        <Panel
          defaultSize={isToolsMinimized ? 2.7 : layout.tools}
          minSize={isToolsMinimized ? 2.7 : 12}
          maxSize={isToolsMinimized ? 2.7 : 40}
          onResize={(size) => {
            if (!isToolsMinimized) {
              setLayout((l) => ({ ...l, tools: size }));
              setTimeout(() => {
                syncAllWebviews();
                syncAiWebview();
                syncAiContextWebview();
                syncYoutubeWebview();
              }, 50);
            }
          }}
        >
          <div
            style={{
              height: "100%",
              background: "#1e1e1e",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              paddingTop: toolsTopClearance,
            }}
          >
            <div
              style={{
                padding: isToolsMinimized ? "8px 4px" : "6px 8px",
                paddingLeft: toolsHeaderPaddingLeft,
                background: "#1e1e1e",
                color: "white",
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexShrink: 0,
                justifyContent: isToolsMinimized ? "center" : "flex-start",
                flexDirection: isToolsMinimized ? "column" : "row",
                minWidth: 0,
              }}
            >
              {!isToolsMinimized && <strong style={{ fontSize: 14, flexShrink: 0 }}>Tools</strong>}
              {!isToolsMinimized && (
                <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0, flex: 1, overflow: "hidden" }}>
                  <button
                    onClick={async () => {
                      const win = getCurrentWindow();
                      const isMax = await win.isMaximized();
                      if (isMax) {
                        await win.unmaximize();
                      } else {
                        await win.maximize();
                      }
                    }}
                    style={{ fontSize: 12, padding: "2px 6px", flexShrink: 1 }}
                  >
                    {isMaximized ? "Minimize" : "Maximize"}
                  </button>
                </div>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); toggleTools(); }}
                title={isToolsMinimized ? "Expand Tools" : "Minimize Tools"}
                style={{
                  width: 28, height: 28, padding: 0,
                  marginLeft: isToolsMinimized ? 0 : "auto",
                  background: "#333", color: "white", border: "1px solid #555",
                  borderRadius: 4, cursor: "pointer", fontSize: 14,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {isToolsMinimized ? "▶" : "◀"}
              </button>
            </div>
            {isToolsMinimized && (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#aaa", fontSize: 13, writingMode: "vertical-rl", textOrientation: "mixed", letterSpacing: 1, userSelect: "none" }}>
                Tools
              </div>
            )}
            {!isToolsMinimized && (
              <div style={{ flex: 1, background: "#252525", color: "white", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{ padding: 8, borderBottom: "1px solid #444", flexShrink: 0 }}>
                  <select
                    value=""
                    onChange={(e) => {
                      const type = e.target.value as ToolType;
                      if (type) addTool(type);
                      e.target.value = "";
                    }}
                    style={{
                      background: "#2a2a2a",
                      color: "#ccc",
                      border: "1px solid #555",
                      borderRadius: 4,
                      padding: "4px 8px",
                      fontSize: 12,
                      outline: "none",
                      cursor: "pointer",
                      width: "100%",
                    }}
                  >
                    <option value="" disabled>
                      + Add Tool
                    </option>
                    {TOOL_OPTIONS.map((opt) => {
                      const alreadyAdded = opt.unique && session.toolWindows.some((w) => w.type === opt.type);
                      return (
                        <option key={opt.type} value={opt.type} disabled={alreadyAdded}>
                          {opt.label}{alreadyAdded ? " (added)" : ""}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <PanelGroup key={toolsPanelKey} direction="vertical" style={{ flex: 1 }}>
                  {session.toolWindows.length === 0 && (
                    <div style={{ color: "#666", fontSize: 13, padding: 8 }}>No tools added</div>
                  )}
                  {session.toolWindows.map((tool, index) => {
                    const size = tool.minimized ? TOOL_STRIP : openSize;
                    return (
                      <React.Fragment key={tool.id}>
                        <Panel
                          defaultSize={size}
                          minSize={tool.minimized ? TOOL_STRIP : 12}
                          maxSize={tool.minimized ? TOOL_STRIP : 100}
                          onResize={() => {
                            setTimeout(() => {
                              syncAiContextWebview();
                              syncYoutubeWebview();
                            }, 30);
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              background: "#1e1e1e",
                              border: "1px solid #444",
                              borderRadius: 4,
                              display: "flex",
                              flexDirection: "column",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              onClick={() => toggleToolMinimized(tool.id)}
                              style={{
                                height: 32,
                                flexShrink: 0,
                                display: "flex",
                                alignItems: "center",
                                padding: "0 8px",
                                background: "#2a2a2a",
                                borderBottom: tool.minimized ? "none" : "1px solid #444",
                                cursor: "pointer",
                                userSelect: "none",
                                fontSize: 13,
                                color: "#ccc",
                                gap: 6,
                              }}
                            >
                              <span style={{ flexShrink: 0 }}>{tool.label}</span>

                              {tool.type === "ai-context" && !tool.minimized && (
                                <>
                                  <select
                                    value={session.aiContextUrl ?? ""}
                                    onChange={(e) => {
                                      const url = e.target.value;
                                      console.log("[select] AI Context changed to", url);
                                      if (url) openAiContext(url);
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    style={{
                                      marginLeft: 4,
                                      background: "#333",
                                      color: "#ccc",
                                      border: "1px solid #555",
                                      borderRadius: 4,
                                      padding: "1px 4px",
                                      fontSize: 11,
                                      outline: "none",
                                      cursor: "pointer",
                                      maxWidth: 90,
                                    }}
                                  >
                                    <option value="" disabled>
                                      Site
                                    </option>
                                    {LLMS.map((llm) => (
                                      <option key={llm.name} value={llm.url}>
                                        {llm.name}
                                      </option>
                                    ))}
                                  </select>

                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleAiContextQuery();
                                    }}
                                    style={{
                                      background: "#333",
                                      color: "#ccc",
                                      border: "1px solid #555",
                                      borderRadius: 3,
                                      fontSize: 11,
                                      padding: "1px 6px",
                                      cursor: "pointer",
                                      flexShrink: 0,
                                    }}
                                    title="Toggle query bar"
                                  >
                                    {session.aiContextQueryOpen ? "Hide Q" : "Show Q"}
                                  </button>

                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleAutoSend();
                                    }}
                                    style={{
                                      background: session.autoSendOnInject ? "#3a5a3a" : "#333",
                                      color: "#ccc",
                                      border: "1px solid #555",
                                      borderRadius: 3,
                                      fontSize: 11,
                                      padding: "1px 6px",
                                      cursor: "pointer",
                                      flexShrink: 0,
                                    }}
                                    title="Toggle auto-send on right-click inject"
                                  >
                                    {session.autoSendOnInject ? "Auto On" : "Auto Off"}
                                  </button>
                                </>
                              )}

                              <span style={{ fontSize: 12, opacity: 0.7, marginLeft: "auto" }}>
                                {tool.minimized ? "▶" : "▼"}
                              </span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeTool(tool.id);
                                }}
                                style={{
                                  marginLeft: 4,
                                  background: "transparent",
                                  color: "#aaa",
                                  border: "none",
                                  cursor: "pointer",
                                  fontSize: 14,
                                }}
                              >
                                ×
                              </button>
                            </div>

                            {!tool.minimized && (
                              <div
                                ref={(el) => {
                                  if (el) toolContainerRefs.current.set(tool.id, el);
                                  else toolContainerRefs.current.delete(tool.id);
                                }}
                                style={{
                                  flex: 1,
                                  background: tool.type === "external-app" ? "transparent" : "#252525",
                                  position: "relative",
                                  minHeight: 0,
                                  overflow: "auto",
                                }}
                              >
                                {tool.type === "ai-context" ? (
                                  <div style={{ padding: 8, fontSize: 12, color: "#888" }}>
                                    AI Context ({session.aiContextUrl || "no url"})
                                  </div>
                                ) : tool.type === "youtube-related" ? (
                                  <div style={{ padding: 8, fontSize: 12, color: "#888" }}>YouTube</div>
                                ) : tool.type === "notes" ? (
                                  editingNoteId ? (
                                    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                                      <div style={{ padding: "6px 8px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #444" }}>
                                        <button
                                          onClick={backToGrid}
                                          style={{ background: "transparent", color: "#ccc", border: "none", fontSize: 16, cursor: "pointer" }}
                                        >
                                          ←
                                        </button>
                                        <input
                                          value={notes.find((n) => n.id === editingNoteId)?.title || ""}
                                          onChange={(e) => {
                                            const updated = notes.map((n) =>
                                              n.id === editingNoteId ? { ...n, title: e.target.value } : n
                                            );
                                            setNotes(updated);
                                            saveNotes(updated);
                                          }}
                                          style={{
                                            flex: 1,
                                            background: "transparent",
                                            color: "#ccc",
                                            border: "none",
                                            fontSize: 13,
                                            outline: "none",
                                            padding: "2px 4px",
                                          }}
                                          placeholder="Note title"
                                        />
                                      </div>
                                      <textarea
                                        value={noteDraft}
                                        onChange={(e) => setNoteDraft(e.target.value)}
                                        onBlur={saveCurrentNote}
                                        style={{
                                          flex: 1,
                                          background: "#1a1a1a",
                                          color: "white",
                                          border: "none",
                                          padding: 12,
                                          fontSize: 14,
                                          resize: "none",
                                          outline: "none",
                                          fontFamily: "inherit",
                                        }}
                                        placeholder="Write your note..."
                                      />
                                    </div>
                                  ) : (
                                    <div style={{ padding: 8 }}>
                                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                                        <span style={{ fontSize: 13, color: "#ccc" }}>Notes</span>
                                        <button onClick={createNote} style={{ fontSize: 12, padding: "2px 8px", background: "#333", color: "white", border: "1px solid #555", borderRadius: 4, cursor: "pointer" }}>+ New</button>
                                      </div>
                                      <div style={{
                                        display: "grid",
                                        gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                                        gap: 8,
                                      }}>
                                        {notes.map((note) => (
                                          <div
                                            key={note.id}
                                            onClick={() => openNote(note)}
                                            style={{
                                              background: "#2a2a2a",
                                              border: "1px solid #444",
                                              borderRadius: 6,
                                              padding: 10,
                                              minHeight: 80,
                                              cursor: "pointer",
                                              fontSize: 13,
                                              color: "#ddd",
                                              overflow: "hidden",
                                            }}
                                          >
                                            <div style={{ fontWeight: 600, marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                              {note.title || "Untitled"}
                                            </div>
                                            <div style={{ fontSize: 11, color: "#888", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                                              {note.content || "Empty note"}
                                            </div>
                                          </div>
                                        ))}
                                        {notes.length === 0 && (
                                          <div style={{ color: "#666", fontSize: 13, gridColumn: "1 / -1" }}>No notes yet. Click + New.</div>
                                        )}
                                      </div>
                                    </div>
                                  )
                                ) : tool.type === "external-app" ? (
                                  <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                                    {!tool.appName ? (
                                      <select
                                        value=""
                                        onChange={(e) => {
                                          const name = e.target.value;
                                          if (name) setExternalApp(tool.id, name);
                                        }}
                                        style={{ width: "80%", padding: "6px 8px", background: "#2a2a2a", color: "#ccc", border: "1px solid #555", borderRadius: 4, fontSize: 13 }}
                                      >
                                        <option value="" disabled>Select app…</option>
                                        {installedApps.map((name) => (
                                          <option key={name} value={name}>{name}</option>
                                        ))}
                                      </select>
                                    ) : (
                                      <div onClick={() => placeExternalApp(tool.id, tool.appName!)} style={{ color: "#888", fontSize: 13, cursor: "pointer", textAlign: "center", padding: 12 }}>
                                        {tool.appName}<br />
                                        <span style={{ fontSize: 11, opacity: 0.7 }}>(click to focus & position)</span>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <div style={{ padding: 8, fontSize: 12, color: "#888" }}>{tool.type} content</div>
                                )}
                              </div>
                            )}
                          </div>
                        </Panel>

                        {index < session.toolWindows.length - 1 && (
                          <PanelResizeHandle
                            style={{
                              height: 6,
                              background: "#555",
                              cursor: "row-resize",
                              flexShrink: 0,
                            }}
                          />
                        )}
                      </React.Fragment>
                    );
                  })}
                </PanelGroup>
              </div>
            )}
          </div>
        </Panel>

        {!isToolsMinimized && <PanelResizeHandle style={{ width: 6, background: "#555", cursor: "col-resize" }} />}

        <Panel defaultSize={isToolsMinimized ? 97.3 : 100 - layout.tools} minSize={30}>
          <PanelGroup key={`${isBrowserMinimized}-${isAIMinimized}`} direction="vertical" style={{ height: "100%" }}>
            <Panel
              defaultSize={isBrowserMinimized ? (isAIMinimized ? BOTH_MINIMIZED : MINIMIZED_STRIP) : layout.main}
              minSize={browserMinSize}
              maxSize={isBrowserMinimized ? (isAIMinimized ? BOTH_MINIMIZED : MINIMIZED_STRIP) : 85}
              onResize={() => {
                setTimeout(() => {
                  syncAiContextWebview();
                  syncYoutubeWebview();
                  session.toolWindows.forEach((t) => {
                    if (t.type === "external-app" && t.appName && !t.minimized) {
                      placeExternalApp(t.id, t.appName);
                    }
                  });
                }, 30);
              }}
            >
              <div
                ref={browserContainerRef}
                style={{
                  height: "100%",
                  background: isBrowserMinimized ? "#1e1e1e" : "#1a1a1a",
                  color: "white",
                  position: "relative",
                  overflow: "hidden",
                  cursor: isBrowserMinimized ? "pointer" : "default",
                  display: "flex",
                  flexDirection: "column",
                }}
                onClick={isBrowserMinimized ? toggleBrowser : undefined}
              >
                {isBrowserMinimized ? (
                  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: "#ccc", userSelect: "none" }}>Browser</div>
                ) : (
                  <>
                    <div ref={chromeRef} style={{ flexShrink: 0, display: "flex", flexDirection: "column" }}>
                      <div style={{ display: "flex", alignItems: "center", background: "#1e1e1e", borderBottom: "1px solid #444", height: 32, padding: "0 4px", gap: 2, overflowX: "auto" }}>
                        {session.tabs.map((tab) => (
                          <div key={tab.id} onClick={() => switchTab(tab)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", background: tab.id === session.activeTabId ? "#333" : "transparent", color: "#ccc", borderRadius: 4, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap", maxWidth: 160 }}>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{tab.title}</span>
                            {session.tabs.length > 1 && <span onClick={(e) => closeTab(tab.id, e)} style={{ fontSize: 14, lineHeight: 1, opacity: 0.7 }}>×</span>}
                          </div>
                        ))}
                        <button onClick={addTab} title={session.tabs.length >= MAX_TABS ? "Max 6 tabs" : "New tab"} disabled={session.tabs.length >= MAX_TABS} style={{ marginLeft: 4, background: "transparent", color: session.tabs.length >= MAX_TABS ? "#555" : "#aaa", border: "none", fontSize: 16, cursor: session.tabs.length >= MAX_TABS ? "not-allowed" : "pointer", padding: "0 6px" }}>+</button>
                      </div>
                      <div style={{ display: "flex", gap: 6, padding: "6px 8px", background: "#252525", borderBottom: "1px solid #444", flexShrink: 0, zIndex: 20, height: 40, boxSizing: "border-box", alignItems: "center" }}>
                        <button
                          onClick={goBack}
                          disabled={!session.tabs.find((t) => t.id === session.activeTabId) || session.tabs.find((t) => t.id === session.activeTabId)!.historyIndex <= 0}
                          style={{ padding: "4px 8px", background: "#333", color: "white", border: "1px solid #555", borderRadius: 4, cursor: "pointer", fontSize: 13 }}
                        >←</button>
                        <button
                          onClick={goForward}
                          disabled={!session.tabs.find((t) => t.id === session.activeTabId) || session.tabs.find((t) => t.id === session.activeTabId)!.historyIndex >= session.tabs.find((t) => t.id === session.activeTabId)!.history.length - 1}
                          style={{ padding: "4px 8px", background: "#333", color: "white", border: "1px solid #555", borderRadius: 4, cursor: "pointer", fontSize: 13 }}
                        >→</button>
                        <input type="text" value={inputUrl} onChange={(e) => setInputUrl(e.target.value)} onKeyDown={handleKeyDown} placeholder="Enter URL or search..." style={{ flex: 1, padding: "4px 8px", background: "#1a1a1a", color: "white", border: "1px solid #555", borderRadius: 4, fontSize: 13, outline: "none" }} />
                        <button onClick={loadUrl} style={{ padding: "4px 12px", background: "#333", color: "white", border: "1px solid #555", borderRadius: 4, cursor: "pointer", fontSize: 13 }}>Go</button>
                      </div>
                    </div>
                    <div style={{ flex: 1 }} />
                    <div onClick={(e) => { e.stopPropagation(); toggleBrowser(); }} style={{ position: "absolute", bottom: 10, right: 10, width: "18%", minWidth: 90, maxWidth: 140, height: 28, background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "#ccc", userSelect: "none", cursor: "pointer", zIndex: 30 }}>Browser</div>
                  </>
                )}
              </div>
            </Panel>

            {!isBrowserMinimized && !isAIMinimized && <PanelResizeHandle style={{ height: 6, background: "#555", cursor: "row-resize" }} />}

            <Panel
              defaultSize={isAIMinimized ? (isBrowserMinimized ? BOTH_MINIMIZED : MINIMIZED_STRIP) : layout.ai}
              minSize={aiMinSize}
              maxSize={isAIMinimized ? (isBrowserMinimized ? BOTH_MINIMIZED : MINIMIZED_STRIP) : 85}
              onResize={(size) => {
                if (!isAIMinimized) {
                  setLayout((l) => ({ ...l, ai: size }));
                  setTimeout(() => { syncAllWebviews(); syncAiWebview(); syncAiContextWebview(); syncYoutubeWebview(); }, 50);
                }
              }}
            >
              <div
                ref={aiContainerRef}
                style={{
                  height: "100%",
                  background: isAIMinimized ? "#1e1e1e" : "#2a2a2a",
                  color: "white",
                  position: "relative",
                  overflow: "hidden",
                  cursor: isAIMinimized ? "pointer" : "default",
                  display: "flex",
                  flexDirection: "column",
                }}
                onClick={isAIMinimized ? toggleAI : undefined}
              >
                {isAIMinimized ? (
                  <div style={{ fontSize: 14, color: "#ccc", userSelect: "none", flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>AI</div>
                ) : (
                  <>
                    <div
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("select, button")) return;
                        toggleAI();
                      }}
                      style={{
                        height: 36,
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        padding: "0 8px",
                        background: "#1e1e1e",
                        borderBottom: "1px solid #444",
                        position: "relative",
                        zIndex: 20,
                        gap: 8,
                        cursor: "pointer",
                        userSelect: "none",
                      }}
                    >
                      <span style={{ fontSize: 13, color: "#ccc" }}>AI</span>
                      <select
                        value={session.aiUrl ?? ""}
                        onChange={(e) => {
                          const url = e.target.value;
                          console.log("[select] main AI changed to", url);
                          if (url) openAi(url);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          marginLeft: "auto",
                          background: "#2a2a2a",
                          color: "#ccc",
                          border: "1px solid #555",
                          borderRadius: 4,
                          padding: "2px 6px",
                          fontSize: 12,
                          outline: "none",
                          cursor: "pointer",
                        }}
                      >
                        <option value="" disabled>
                          Select LLM
                        </option>
                        {LLMS.map((llm) => (
                          <option key={llm.name} value={llm.url}>
                            {llm.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div style={{ flex: 1 }} />
                  </>
                )}
              </div>
            </Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    </div>
  );
}