---
'@tiptap/y-tiptap': patch
---

Handle stale cursor awareness meta transactions more safely by retrying the queued cursor-only update once and dropping it if the transaction is still mismatched, preventing editor crashes during asynchronous awareness refreshes.
