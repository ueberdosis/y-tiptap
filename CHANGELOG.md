# @tiptap/y-tiptap

## 3.0.3

### Patch Changes

- 7a1b55a: Handle stale cursor awareness meta transactions more safely by retrying the queued cursor-only update once and dropping it if the transaction is still mismatched, preventing editor crashes during asynchronous awareness refreshes.
