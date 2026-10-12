import * as t from 'lib0/testing'
import * as Y from 'yjs'
import { TextSelection } from 'prosemirror-state'
import { findAbsolutePositionAfterStructuralChange } from '../../src/y-tiptap.js'
import { createNewProsemirrorView, schema, syncYDocs } from '../shared.js'

const withNestedMove = (nested, selectedIndex, offset) => {
  const writerDoc = new Y.Doc()
  const readerDoc = new Y.Doc()
  const writer = createNewProsemirrorView(writerDoc)
  const reader = createNewProsemirrorView(readerDoc)
  try {
    const paragraphs = ['First nested paragraph', 'Second nested paragraph'].map(text => schema.node('paragraph', undefined, schema.text(text)))
    const inner = schema.node('blockquote', undefined, paragraphs)
    writer.dispatch(writer.state.tr.replaceWith(0, writer.state.doc.content.size, [
      schema.node('paragraph', undefined, schema.text('Before')),
      nested ? schema.node('blockquote', undefined, inner) : inner,
      schema.node('paragraph', undefined, schema.text('After'))
    ]))
    syncYDocs(writerDoc, readerDoc)
    const innerStart = reader.state.doc.firstChild.nodeSize + (nested ? 2 : 1)
    const selectedStart = innerStart + selectedIndex * paragraphs[0].nodeSize
    reader.dispatch(reader.state.tr.setSelection(TextSelection.create(reader.state.doc, selectedStart + 1 + offset)))
    writer.dispatch(writer.state.tr.insertText('Z', innerStart + 2))
    syncYDocs(writerDoc, readerDoc)
    const before = reader.state.selection.$head
    const quote = nested ? writer.state.doc.child(1).firstChild : writer.state.doc.child(1)
    const moved = quote.child(1)
    const moveStart = innerStart + quote.firstChild.nodeSize
    writer.dispatch(writer.state.tr.delete(moveStart, moveStart + moved.nodeSize).insert(innerStart, moved))
    syncYDocs(writerDoc, readerDoc)
    t.assert(reader.state.doc.eq(writer.state.doc), 'documents converge after the nested move')
    t.assert(reader.state.selection.$head.parent.textContent === before.parent.textContent, 'cursor stays in the same nested paragraph')
    t.assert(reader.state.selection.$head.parentOffset === before.parentOffset, 'cursor keeps its paragraph offset')
  } finally {
    writer.destroy()
    reader.destroy()
    writerDoc.destroy()
    readerDoc.destroy()
  }
}

/** @param {t.TestCase} _tc */
export const testCursorFollowsMovedNestedParagraph = (_tc) => {
  withNestedMove(false, 1, 3)
}

/** @param {t.TestCase} _tc */
export const testCursorStaysInNestedSiblingAfterMove = (_tc) => {
  withNestedMove(false, 0, 3)
}

/** @param {t.TestCase} _tc */
export const testCursorFollowsDeeplyNestedParagraph = (_tc) => {
  withNestedMove(true, 1, 3)
}

/** @param {t.TestCase} _tc */
export const testCursorAtNestedParagraphStartFollowsMove = (_tc) => {
  withNestedMove(false, 1, 0)
}

/** @param {t.TestCase} _tc */
export const testDeletedNestedParagraphDoesNotMatchSiblingIndex = (_tc) => {
  const paragraphs = ['First', 'Second', 'Third'].map(text => schema.node('paragraph', undefined, schema.text(text)))
  const oldDoc = schema.node('doc', undefined, schema.node('blockquote', undefined, paragraphs))
  const newDoc = schema.node('doc', undefined, schema.node('blockquote', undefined, [paragraphs[0], paragraphs[2]]))
  t.assert(findAbsolutePositionAfterStructuralChange(oldDoc, newDoc, paragraphs[0].nodeSize + 4) === null, 'a deleted nested paragraph does not match its replacement sibling')
}
