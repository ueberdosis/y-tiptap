---
"@tiptap/y-tiptap": patch
---

Fix: When recieving undefined from `mapping.get(t)` in `relativePositionToAbsolutePosition` set pos to `0` instead of failing. It fails because position is taken from `nodeSize` on the returned entry, without catching the case of the lookup on `mapping` returning undefined.