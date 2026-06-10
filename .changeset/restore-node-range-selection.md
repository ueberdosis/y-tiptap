---
"@tiptap/y-tiptap": patch
---

Fix duplicated blocks when dragging with the drag handle during collaborative editing. Node range selections are now preserved across remote updates instead of being reset, so dropping a block moves it instead of leaving a copy behind.
