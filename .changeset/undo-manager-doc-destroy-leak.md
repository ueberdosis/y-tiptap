---
"@tiptap/y-tiptap": patch
---

Fix a memory leak in `yUndoPlugin`. Yjs' `UndoManager` registers a `doc.on('destroy', …)` listener in its constructor that `UndoManager.destroy()` never removes. When the Y.Doc outlives the editor (e.g. several editors sharing one provider), that listener kept the `UndoManager` — and everything it referenced — reachable from the doc, leaking memory on every editor destroy. The plugin now removes that listener when its view is destroyed (only for managers it created; a caller-provided `undoManager` is left untouched).