---
'@tiptap/y-tiptap': patch
---

Fix carets jumping or splitting when a remote user drags a block above a paragraph being typed in. Cursor recovery now detects more misresolved positions, matches blocks by attrs when text diverged, and no longer sends the cursor to the document start when recovery fails.
