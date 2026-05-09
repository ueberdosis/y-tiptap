---
'@tiptap/y-tiptap': patch
---

Guard against null awareness state values in the cursor plugin so iterating over `awareness.getStates()` after a client disconnects no longer throws a TypeError when accessing `aw.cursor`.
