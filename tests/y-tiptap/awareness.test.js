import * as t from 'lib0/testing'
import * as Y from 'yjs'
import * as promise from 'lib0/promise'
import { Awareness } from 'y-protocols/awareness'
import { TextSelection } from 'prosemirror-state'
import {
  absolutePositionToRelativePosition,
  ySyncPluginKey
} from '../../src/y-tiptap.js'
import {
  createNewProsemirrorView,
  createViewWithCursor,
  schema,
  syncAwareness,
  syncYDocs
} from '../shared.js'

/**
 * @param {t.TestCase} _tc
 */
export const testUnchangedCursorNotPublishedAfterRemoteEdits = async (_tc) => {
  const writerDoc = new Y.Doc()
  const readerDoc = new Y.Doc()
  const awareness = new Awareness(readerDoc)
  const writer = createNewProsemirrorView(writerDoc)
  const reader = createViewWithCursor(readerDoc, awareness)

  try {
    writer.dispatch(writer.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('hello')),
      schema.node('paragraph', undefined, schema.text('other block'))
    ]))
    syncYDocs(writerDoc, readerDoc)
    // JSDOM cannot focus the editor, but publishing requires a focused view.
    reader.hasFocus = () => true
    reader.dispatch(reader.state.tr.setSelection(TextSelection.create(reader.state.doc, 3)))
    await promise.wait(10)

    const cursor = awareness.getLocalState().cursor
    let updates = 0
    awareness.on('update', ({ updated }) => {
      if (updated.includes(readerDoc.clientID)) updates++
    })

    writer.dispatch(writer.state.tr.insertText('!', writer.state.doc.content.size - 1))
    Y.applyUpdate(readerDoc, Y.encodeStateAsUpdate(writerDoc))
    t.assert(Y.compareRelativePositions(cursor.head, awareness.getLocalState().cursor.head))
    t.assert(updates === 0, 'remote typing must not publish an unchanged cursor')

    writer.dispatch(writer.state.tr.insert(0, schema.node('paragraph', undefined, schema.text('new block'))))
    Y.applyUpdate(readerDoc, Y.encodeStateAsUpdate(writerDoc))
    t.assert(reader.state.doc.eq(writer.state.doc), 'documents converge')
    t.assert(Y.compareRelativePositions(cursor.head, awareness.getLocalState().cursor.head))
    t.assert(updates === 0, 'remote block insertion must not publish an unchanged cursor')

    reader.dispatch(reader.state.tr.setSelection(TextSelection.create(reader.state.doc, 1)))
    t.assert(updates === 1, 'moving the cursor must still publish its new position')
  } finally {
    await promise.wait(10)
    writer.destroy()
    reader.destroy()
    awareness.destroy()
    writerDoc.destroy()
    readerDoc.destroy()
  }
}

/**
 * @param {t.TestCase} _tc
 */
export const testCursorRenderingPreservesAwarenessUser = async (_tc) => {
  const readerDoc = new Y.Doc()
  const publisherDoc = new Y.Doc()
  const awareness = new Awareness(readerDoc)
  const publisher = new Awareness(publisherDoc)
  const view = createViewWithCursor(readerDoc, awareness)

  try {
    view.dispatch(view.state.tr.insertText('hello', 1))
    const binding = ySyncPluginKey.getState(view.state).binding
    const relativePosition = absolutePositionToRelativePosition(3, binding.type, binding.mapping)
    publisher.setLocalState({
      cursor: { anchor: relativePosition, head: relativePosition },
      user: { name: null, color: null }
    })
    syncAwareness(publisher, awareness, publisherDoc.clientID)
    await promise.wait(10)

    t.compare(awareness.getStates().get(publisherDoc.clientID).user, { name: null, color: null })
    const cursor = view.dom.querySelector('.ProseMirror-yjs-cursor')
    t.assert(cursor !== null, 'remote cursor renders with default user data')
    t.assert(cursor.textContent.includes(`User: ${publisherDoc.clientID}`), 'default name is displayed')
    t.assert(cursor.getAttribute('style').includes('#ffa500'), 'default color is displayed')

    let changes = 0
    awareness.on('change', ({ updated }) => {
      if (updated.includes(publisherDoc.clientID)) changes++
    })
    publisher.setLocalState(publisher.getLocalState())
    syncAwareness(publisher, awareness, publisherDoc.clientID)
    t.assert(changes === 0, 'an identical awareness state must not cause another change')
  } finally {
    await promise.wait(10)
    view.destroy()
    awareness.destroy()
    publisher.destroy()
    readerDoc.destroy()
    publisherDoc.destroy()
  }
}
