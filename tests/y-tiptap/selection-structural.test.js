import * as t from 'lib0/testing'
import * as Y from 'yjs'
import { TextSelection } from 'prosemirror-state'
import { findAbsolutePositionAfterStructuralChange } from '../../src/y-tiptap.js'
import {
  createNewProsemirrorView,
  NodeRangeSelection,
  schema,
  syncYDocs
} from '../shared.js'

/**
 * Local selection must stay in the correct block when multiple blocks share the
 * same text content and a remote structural change reorders the document.
 *
 * @param {t.TestCase} _tc
 */
export const testLocalSelectionRestoredWithDuplicateBlockText = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const view1 = createNewProsemirrorView(ydoc1)
  const view2 = createNewProsemirrorView(ydoc2)

  view1.dispatch(
    view1.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('same')),
      schema.node('paragraph', undefined, schema.text('same'))
    ])
  )
  syncYDocs(ydoc1, ydoc2)

  const firstBlockSize = view1.state.doc.child(0).nodeSize
  const cursorPos = firstBlockSize + 3
  view1.dispatch(
    view1.state.tr.setSelection(TextSelection.create(view1.state.doc, cursorPos))
  )

  const oldDoc = view1.state.doc
  t.assert(
    oldDoc.resolve(cursorPos).index(0) === 1,
    'precondition: selection should start in the second duplicate block'
  )

  view2.dispatch(
    view2.state.tr.insert(0, schema.node('paragraph', undefined, schema.text('other')))
  )

  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  const expectedCursorPos = findAbsolutePositionAfterStructuralChange(
    oldDoc,
    view1.state.doc,
    cursorPos
  )

  t.assert(
    expectedCursorPos !== null,
    'precondition: expected remapped cursor position should exist'
  )
  t.assert(
    view1.state.selection.anchor === expectedCursorPos,
    `selection in duplicate block should remap to ${expectedCursorPos}, got ${view1.state.selection.anchor}`
  )
  t.assert(
    view1.state.doc.resolve(view1.state.selection.anchor).index(0) === 2,
    'selection should stay in the second matching block after a remote insert'
  )
  t.assert(
    view1.state.doc.resolve(view1.state.selection.anchor).parentOffset ===
      oldDoc.resolve(cursorPos).parentOffset,
    'selection should preserve its in-paragraph offset inside the duplicate block'
  )
}

/**
 * A NodeRangeSelection on a single block (e.g. drag-handle node pick) must stay on
 * the correct block when multiple blocks share the same text content.
 *
 * @param {t.TestCase} _tc
 */
export const testNodeRangeSelectionRestoredWithDuplicateBlockText = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const view1 = createNewProsemirrorView(ydoc1)
  const view2 = createNewProsemirrorView(ydoc2)

  view1.dispatch(
    view1.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('same')),
      schema.node('paragraph', undefined, schema.text('same'))
    ])
  )
  syncYDocs(ydoc1, ydoc2)

  const oldDoc = view1.state.doc
  const blockStart = oldDoc.child(0).nodeSize
  const blockEnd = blockStart + oldDoc.child(1).nodeSize
  view1.dispatch(
    view1.state.tr.setSelection(
      new NodeRangeSelection(oldDoc.resolve(blockStart), oldDoc.resolve(blockEnd), 0)
    )
  )

  t.assert(
    view1.state.selection instanceof NodeRangeSelection,
    'precondition: peer 1 holds a NodeRangeSelection on the second duplicate block'
  )
  t.assert(
    oldDoc.resolve(blockStart).index(0) === 1,
    'precondition: node range should start at the second duplicate block'
  )

  view2.dispatch(
    view2.state.tr.insert(0, schema.node('paragraph', undefined, schema.text('other')))
  )

  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  const sel = view1.state.selection
  t.assert(
    sel instanceof NodeRangeSelection,
    'NodeRangeSelection should be preserved across a remote structural change'
  )
  t.assert(
    /** @type {any} */ (sel).depth === 0,
    'node range depth should be preserved'
  )

  const newDoc = view1.state.doc
  const expectedBlockIndex = 2
  const expectedBlockStart = newDoc.child(0).nodeSize + newDoc.child(1).nodeSize
  const expectedBlockEnd = expectedBlockStart + newDoc.child(expectedBlockIndex).nodeSize

  t.assert(
    sel.anchor >= expectedBlockStart && sel.anchor <= expectedBlockEnd,
    `node range anchor should stay inside the second matching block (${expectedBlockStart}-${expectedBlockEnd}), got ${sel.anchor}`
  )
  t.assert(
    sel.head >= expectedBlockStart && sel.head <= expectedBlockEnd,
    `node range head should stay inside the second matching block (${expectedBlockStart}-${expectedBlockEnd}), got ${sel.head}`
  )
  t.assert(
    newDoc.resolve(Math.min(sel.anchor, sel.head)).index(0) === expectedBlockIndex,
    'node range should still select the second duplicate block, not the first'
  )
}

/**
 * Builds two synced views with the given top-level paragraphs.
 *
 * @param {string[]} texts
 */
const createSyncedParagraphs = (texts) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const view1 = createNewProsemirrorView(ydoc1)
  const view2 = createNewProsemirrorView(ydoc2)
  // replace the initial empty paragraph so the document holds exactly `texts`
  view1.dispatch(
    view1.state.tr.replaceWith(0, view1.state.doc.content.size, texts.map((text) =>
      schema.node('paragraph', undefined, text === '' ? undefined : schema.text(text))
    ))
  )
  syncYDocs(ydoc1, ydoc2)
  return { ydoc1, ydoc2, view1, view2 }
}

/**
 * Position just inside the top-level block at `index`.
 *
 * @param {import('prosemirror-model').Node} doc
 * @param {number} index
 */
const startOfBlock = (doc, index) => {
  let pos = 0
  for (let i = 0; i < index; i++) {
    pos += doc.child(i).nodeSize
  }
  return pos + 1
}

/**
 * Two peers press Enter at the end of the same line, one after the other: the remote
 * empty paragraph lands right before the local caret's empty paragraph. The caret must
 * stay in its own (now shifted) empty block instead of jumping into the remote one.
 * Empty blocks cannot be told apart by text (#51).
 *
 * @param {t.TestCase} _tc
 */
export const testCaretStaysInOwnEmptyBlockWhenRemoteInsertsEmptySibling = (_tc) => {
  const { ydoc1, ydoc2, view1, view2 } = createSyncedParagraphs(['first', 'second', ''])
  view1.dispatch(
    view1.state.tr.setSelection(TextSelection.create(view1.state.doc, startOfBlock(view1.state.doc, 2)))
  )
  t.assert(view1.state.selection.$from.index(0) === 2, 'precondition: caret in the trailing empty block')

  // the remote peer splits right after "second" — a new empty paragraph before ours
  const afterSecond = startOfBlock(view2.state.doc, 2) - 1
  view2.dispatch(view2.state.tr.insert(afterSecond, schema.node('paragraph')))
  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  t.compare(view1.state.doc.childCount, 4, 'remote empty paragraph applied')
  t.compare(view1.state.selection.$from.index(0), 3, 'caret stays in its own empty block (shifted by one)')
}

/**
 * #51: a remote peer types into the empty block the local caret is in, while other empty
 * blocks exist. The caret must stay in its own block.
 *
 * @param {t.TestCase} _tc
 */
export const testCaretStaysWhenRemoteTypesIntoCaretEmptyBlock = (_tc) => {
  const { ydoc1, ydoc2, view1, view2 } = createSyncedParagraphs(['', '', ''])
  view1.dispatch(
    view1.state.tr.setSelection(TextSelection.create(view1.state.doc, startOfBlock(view1.state.doc, 1)))
  )
  view2.dispatch(view2.state.tr.insertText('ab', startOfBlock(view2.state.doc, 1)))
  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  t.compare(view1.state.doc.child(1).textContent, 'ab', 'remote text applied')
  t.compare(view1.state.selection.$from.index(0), 1, 'caret stays in the block the remote typed into')
}
