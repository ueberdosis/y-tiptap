---
"@tiptap/y-tiptap": patch
---

Fixed Recieving null from `mapping.get(t)` or `mapping.get(contentType)` in `relativePositionToAbsolutePosition` return `null` instead of failing. It fails because position is taken from `nodeSize` on the returned entry, without catching the case of the lookup on `mapping` returning null.