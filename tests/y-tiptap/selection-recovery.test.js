import * as t from 'lib0/testing'
import * as Y from 'yjs'
import { TextSelection } from 'prosemirror-state'
import { findAbsolutePositionAfterStructuralChange } from '../../src/y-tiptap.js'
import { Schema } from 'prosemirror-model'
import { createNewProsemirrorView, createNewProsemirrorViewWithSchema, schema, syncYDocs } from '../shared.js'

/**
 * Content-based fallback must run when only the head misresolves to doc start.
 *
 * @param {t.TestCase} _tc
 */
export const testSelectionFallbackWhenOnlyHeadMisresolves = (_tc) => {
  const oldDoc = schema.node('doc', undefined, [
    schema.node('paragraph', undefined, schema.text('hello')),
    schema.node('paragraph', undefined, schema.text('world'))
  ])
  const newDoc = schema.node('doc', undefined, [
    schema.node('paragraph', undefined, schema.text('world')),
    schema.node('paragraph', undefined, schema.text('hello'))
  ])

  const relSel = { absAnchor: 6, absHead: 12 }

  const remappedHead = findAbsolutePositionAfterStructuralChange(
    oldDoc,
    newDoc,
    relSel.absHead
  )
  const remappedAnchor = findAbsolutePositionAfterStructuralChange(
    oldDoc,
    newDoc,
    relSel.absAnchor
  )

  t.assert(
    remappedHead === 5 && remappedAnchor === 13,
    `fallback should remap both endpoints, got anchor=${remappedAnchor}, head=${remappedHead}`
  )
}

/**
 * Range selections must remap both endpoints after a remote block reorder.
 *
 * @param {t.TestCase} _tc
 */
export const testLocalRangeSelectionRestoredAfterRemoteBlockMove = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const view1 = createNewProsemirrorView(ydoc1)
  const view2 = createNewProsemirrorView(ydoc2)

  view1.dispatch(
    view1.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('hello')),
      schema.node('paragraph', undefined, schema.text('world'))
    ])
  )
  syncYDocs(ydoc1, ydoc2)

  const anchorPos = 6
  const headPos = 12
  view1.dispatch(
    view1.state.tr.setSelection(TextSelection.create(view1.state.doc, anchorPos, headPos))
  )

  const oldDoc = view1.state.doc
  const doc2 = view2.state.doc
  const blockNode = doc2.child(1)
  const blockStart = doc2.child(0).nodeSize
  view2.dispatch(
    view2.state.tr.delete(blockStart, blockStart + blockNode.nodeSize).insert(0, blockNode)
  )

  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  const expectedAnchor = findAbsolutePositionAfterStructuralChange(
    oldDoc,
    view1.state.doc,
    anchorPos
  )
  const expectedHead = findAbsolutePositionAfterStructuralChange(
    oldDoc,
    view1.state.doc,
    headPos
  )

  t.assert(
    expectedAnchor !== null && expectedHead !== null,
    'precondition: expected remapped selection endpoints should exist'
  )
  t.assert(
    view1.state.selection.head === expectedHead,
    `selection head should remap to ${expectedHead}, got ${view1.state.selection.head}`
  )
  t.assert(
    view1.state.selection.anchor === expectedAnchor,
    `selection anchor should remap to ${expectedAnchor}, got ${view1.state.selection.anchor}`
  )
}

/**
 * User A's local selection must survive a remote block reorder.
 *
 * @param {t.TestCase} _tc
 */
export const testLocalSelectionRestoredAfterRemoteBlockMove = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const view1 = createNewProsemirrorView(ydoc1)
  const view2 = createNewProsemirrorView(ydoc2)

  view1.dispatch(
    view1.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('hello')),
      schema.node('paragraph', undefined, schema.text('block'))
    ])
  )
  syncYDocs(ydoc1, ydoc2)

  const typingCursorPos = 6
  view1.dispatch(
    view1.state.tr.setSelection(TextSelection.create(view1.state.doc, typingCursorPos))
  )

  const doc2 = view2.state.doc
  const blockNode = doc2.child(1)
  const blockStart = doc2.child(0).nodeSize
  view2.dispatch(
    view2.state.tr.delete(blockStart, blockStart + blockNode.nodeSize).insert(0, blockNode)
  )

  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  const expectedCursorPos = typingCursorPos + blockNode.nodeSize
  t.assert(
    view1.state.selection.anchor >= expectedCursorPos - 1 &&
      view1.state.selection.anchor <= expectedCursorPos + 1,
    `local selection should remap to ~${expectedCursorPos}, got ${view1.state.selection.anchor}`
  )
}

/**
 * Local selection must keep its in-paragraph offset when a remote block is moved
 * in front of the selected paragraph.
 *
 * @param {t.TestCase} _tc
 */
export const testLocalSelectionRestoredWhenBlockMovedInFront = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const view1 = createNewProsemirrorView(ydoc1)
  const view2 = createNewProsemirrorView(ydoc2)

  view1.dispatch(
    view1.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('one')),
      schema.node('paragraph', undefined, schema.text('two here')),
      schema.node('paragraph', undefined, schema.text('three'))
    ])
  )
  syncYDocs(ydoc1, ydoc2)

  const cursorPos = 10
  view1.dispatch(
    view1.state.tr.setSelection(TextSelection.create(view1.state.doc, cursorPos))
  )

  const oldDoc = view1.state.doc
  t.assert(
    oldDoc.resolve(cursorPos).parentOffset > 0,
    'precondition: selection should start mid-paragraph'
  )
  const doc2 = view2.state.doc
  const movedBlock = doc2.child(2)
  const movedBlockStart = doc2.child(0).nodeSize + doc2.child(1).nodeSize
  view2.dispatch(
    view2.state.tr
      .delete(movedBlockStart, movedBlockStart + movedBlock.nodeSize)
      .insert(0, movedBlock)
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
    `local selection should stay at offset in its paragraph, expected ${expectedCursorPos}, got ${view1.state.selection.anchor}`
  )
  t.assert(
    view1.state.doc.resolve(view1.state.selection.anchor).parentOffset ===
      oldDoc.resolve(cursorPos).parentOffset,
    'selection should preserve its in-paragraph offset after a block is moved in front'
  )
}

/**
 * Selection at the start of a paragraph must follow that paragraph when a block
 * is moved in front of it.
 *
 * @param {t.TestCase} _tc
 */
export const testLocalSelectionAtParagraphStartAfterBlockMovedInFront = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const view1 = createNewProsemirrorView(ydoc1)
  const view2 = createNewProsemirrorView(ydoc2)

  view1.dispatch(
    view1.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('hello')),
      schema.node('paragraph', undefined, schema.text('block'))
    ])
  )
  syncYDocs(ydoc1, ydoc2)

  const cursorPos = 1
  view1.dispatch(
    view1.state.tr.setSelection(TextSelection.create(view1.state.doc, cursorPos))
  )

  const oldDoc = view1.state.doc
  const doc2 = view2.state.doc
  const blockNode = doc2.child(1)
  const blockStart = doc2.child(0).nodeSize
  view2.dispatch(
    view2.state.tr.delete(blockStart, blockStart + blockNode.nodeSize).insert(0, blockNode)
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
    `paragraph-start selection should move with its paragraph, expected ${expectedCursorPos}, got ${view1.state.selection.anchor}`
  )
}

/**
 * When the content fallback cannot find the block (e.g. a remote edit changed
 * the text of the cursor's own paragraph), the Yjs-resolved position must be
 * kept. Dropping it unsets the selection and the cursor jumps to the start.
 *
 * @param {t.TestCase} _tc
 */
export const testLocalSelectionKeptWhenContentFallbackFails = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const view1 = createNewProsemirrorView(ydoc1)
  const view2 = createNewProsemirrorView(ydoc2)

  view1.dispatch(
    view1.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('hello')),
      schema.node('paragraph', undefined, schema.text('world'))
    ])
  )
  syncYDocs(ydoc1, ydoc2)

  // Cursor at "wor|ld" in the second paragraph.
  const cursorPos = view1.state.doc.child(0).nodeSize + 1 + 3
  view1.dispatch(
    view1.state.tr.setSelection(TextSelection.create(view1.state.doc, cursorPos))
  )

  // Remote prepends a character to the same paragraph, so no block in the
  // rebuilt doc carries the old text and the fallback returns null.
  const remoteInsertPos = view2.state.doc.child(0).nodeSize + 1
  view2.dispatch(view2.state.tr.insertText('X', remoteInsertPos, remoteInsertPos))

  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  t.assert(
    view1.state.selection.anchor === cursorPos + 1,
    `cursor should stay at its character after a remote insert, expected ${cursorPos + 1}, got ${view1.state.selection.anchor}`
  )
}

/**
 * A misresolved head must not drag a correctly resolved anchor into the
 * content fallback; endpoints are handled independently.
 *
 * @param {t.TestCase} _tc
 */
export const testRangeSelectionEndpointsRestoredIndependently = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const view1 = createNewProsemirrorView(ydoc1)
  const view2 = createNewProsemirrorView(ydoc2)

  view1.dispatch(
    view1.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('hello')),
      schema.node('paragraph', undefined, schema.text('world'))
    ])
  )
  syncYDocs(ydoc1, ydoc2)

  // Anchor at "he|llo", head at "wor|ld".
  const anchorPos = 3
  const headPos = view1.state.doc.child(0).nodeSize + 1 + 3
  view1.dispatch(
    view1.state.tr.setSelection(
      TextSelection.create(view1.state.doc, anchorPos, headPos)
    )
  )

  const remoteInsertPos = view2.state.doc.child(0).nodeSize + 1
  view2.dispatch(view2.state.tr.insertText('X', remoteInsertPos, remoteInsertPos))

  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  t.assert(
    view1.state.selection.anchor === anchorPos,
    `anchor should be untouched by the head's misresolution, expected ${anchorPos}, got ${view1.state.selection.anchor}`
  )
  t.assert(
    view1.state.selection.head === headPos + 1,
    `head should keep its Yjs resolution, expected ${headPos + 1}, got ${view1.state.selection.head}`
  )
}

// Blocks with an id attribute, like Tiptap's UniqueID extension adds.
const schemaWithBlockIds = new Schema({
  nodes: schema.spec.nodes.update('paragraph', {
    ...schema.spec.nodes.get('paragraph'),
    attrs: { id: { default: null } }
  }),
  marks: schema.spec.marks
})

/**
 * @param {number} anchor
 * @param {number} head
 * @return {{ anchor: number, head: number }} Selection of a local view after
 *   a remote user typed at the start of the same paragraph.
 */
const selectionAfterRemoteTextEditInSameParagraph = (anchor, head) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const view1 = createNewProsemirrorViewWithSchema(ydoc1, schemaWithBlockIds)
  const view2 = createNewProsemirrorViewWithSchema(ydoc2, schemaWithBlockIds)

  view1.dispatch(
    view1.state.tr.insert(0, [
      schemaWithBlockIds.node('paragraph', { id: 'one' }, schemaWithBlockIds.text('Hello world')),
      schemaWithBlockIds.node('paragraph', { id: 'two' }, schemaWithBlockIds.text('Another line'))
    ])
  )
  syncYDocs(ydoc1, ydoc2)

  view1.dispatch(view1.state.tr.setSelection(TextSelection.create(view1.state.doc, anchor, head)))
  view2.dispatch(view2.state.tr.insertText('A ', 1))
  syncYDocs(ydoc1, ydoc2)

  t.compare(view1.state.doc.child(0).textContent, 'A Hello world')
  return view1.state.selection
}

/**
 * A remote text edit in the caret's own paragraph must not move the caret off
 * its text. The Yjs relative position is already correct.
 *
 * @param {t.TestCase} _tc
 */
export const testLocalCaretFollowsTextAfterRemoteTextEditInSameParagraph = (_tc) => {
  const { anchor, head } = selectionAfterRemoteTextEditInSameParagraph(12, 12)
  t.assert(
    anchor === 14 && head === 14,
    `caret should stay after "world" (14), got anchor=${anchor} head=${head}`
  )
}

/**
 * A reversed range selection keeps both endpoints and its direction across a
 * remote text edit earlier in the same paragraph.
 *
 * @param {t.TestCase} _tc
 */
export const testLocalRangeSelectionFollowsTextAfterRemoteTextEditInSameParagraph = (_tc) => {
  const { anchor, head } = selectionAfterRemoteTextEditInSameParagraph(12, 7)
  t.assert(
    anchor === 14 && head === 9,
    `selection should be anchor=14 head=9, got anchor=${anchor} head=${head}`
  )
}
