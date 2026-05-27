# @tiptap/y-tiptap

## 3.0.4

### Patch Changes

- c898728: Guard against undefined `ystate` in `updateCursorInfo` to prevent breaking cursor tracking (floating toolbars, selection menus, collaborative cursor overlays) during Yjs sync initialisation and document transitions.
- 000bda2: Guard against null awareness state values in the cursor plugin so iterating over `awareness.getStates()` after a client disconnects no longer throws a TypeError when accessing `aw.cursor`.
- 09e406d: Fix a memory leak in `yUndoPlugin`. Yjs' `UndoManager` registers a `doc.on('destroy', …)` listener in its constructor that `UndoManager.destroy()` never removes. When the Y.Doc outlives the editor (e.g. several editors sharing one provider), that listener kept the `UndoManager` — and everything it referenced — reachable from the doc, leaking memory on every editor destroy. The plugin now removes that listener when its view is destroyed (only for managers it created; a caller-provided `undoManager` is left untouched).

## 3.0.3

### Patch Changes

- 7a1b55a: Handle stale cursor awareness meta transactions more safely by retrying the queued cursor-only update once and dropping it if the transaction is still mismatched, preventing editor crashes during asynchronous awareness refreshes.
