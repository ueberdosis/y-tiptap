---
"@tiptap/y-tiptap": patch
---

Guard against undefined `ystate` in `updateCursorInfo` to prevent breaking cursor tracking (floating toolbars, selection menus, collaborative cursor overlays) during Yjs sync initialisation and document transitions.
