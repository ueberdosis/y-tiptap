import { Slice } from 'prosemirror-model'
import { replaceStep } from 'prosemirror-transform'

/**
 * Replace changed top-level children while preserving the unchanged ends.
 * Fall back to a full replacement when schema fitting changes the result.
 *
 * @param {import('prosemirror-state').Transaction} tr
 * @param {import('prosemirror-model').Fragment} content
 * @returns {import('prosemirror-state').Transaction}
 */
export const replaceChangedChildren = (tr, content) => {
  const oldContent = tr.doc.content
  let start = 0
  let from = 0
  while (start < oldContent.childCount && start < content.childCount &&
    oldContent.child(start) === content.child(start)) {
    from += oldContent.child(start).nodeSize
    start++
  }

  let oldEnd = oldContent.childCount
  let newEnd = content.childCount
  let suffixSize = 0
  while (oldEnd > start && newEnd > start &&
    oldContent.child(oldEnd - 1) === content.child(newEnd - 1)) {
    suffixSize += oldContent.child(oldEnd - 1).nodeSize
    oldEnd--
    newEnd--
  }
  if (start === oldEnd && start === newEnd) return tr

  const slice = new Slice(content.cut(from, content.size - suffixSize), 0, 0)
  const step = replaceStep(tr.doc, from, oldContent.size - suffixSize, slice)
  if (step !== null && step.apply(tr.doc).doc?.content.eq(content)) {
    return tr.step(step)
  }
  return tr.replace(0, oldContent.size, new Slice(content, 0, 0))
}
