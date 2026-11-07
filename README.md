# IntraAI

A modern browser interface that keeps research, AI, notes, and external tools in one resizable workspace.

![Main view with AI Context and YouTube](images/SelectTools.png)
*AI Context and related YouTube content open alongside the browser.*

![External app embedded](images/EmbedApps.png)
*Anki embedded directly in the tools panel.*

## Features

- **Resizable multi-panel layout** — tools, browser, and AI panels that can be dragged and minimized
- **Full browser with tabs** — up to 6 tabs, address bar, back/forward history, and “Open Link in New Tab”
- **AI Context tool** — right-click selected text to inject an explanation prompt into a dedicated AI webview
- **Related YouTube tool** — right-click selected text to open a relevant YouTube search
- **Notes** — simple grid of notes with titles and content, persisted locally
- **External apps** — launch and position macOS apps (Anki, Obsidian, Cursor, etc.) inside a transparent panel
- **Session persistence** — tabs, AI URLs, tool layout, and notes restore on launch

## Process

### Paper Prototype
![Paper prototype](images/Paper.png)

### Low-Fidelity Prototype
![Low-fidelity prototype](images/Low_Fidelity.png)

### High-Fidelity Prototype (Figma)
![High-fidelity Figma prototype](images/High_Fidelity.png)

### Final Implementation
The finished app is built with **Tauri + React** and uses native webviews for the browser and AI panels, with AppleScript for external app placement on macOS.

## Tech Stack

- Tauri v2
- React + TypeScript
- react-resizable-panels
- localStorage for session and notes

## To Do
- Add unique handling for common LLMs for Auto-Inject and Hide Chatbox features
- Enable main webviews to be swappable with tools 
- Add multi-session profiles and select on launch (for multiple projects)

## Running Locally

```bash
npm install
npx tauri dev

