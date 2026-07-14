---
"@tiptap/y-tiptap": patch
---

Fix cursor jumping to the end of the document when undoing plain text edits. The structural-change fallback introduced in 3.0.6 misfired on text-only undo/redo because the paragraph's textContent always differs; the fallback now only overrides the resolved selection when the original block still exists in the new document (i.e. it was actually moved).
