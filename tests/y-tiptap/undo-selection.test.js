import * as t from 'lib0/testing'
import * as Y from 'yjs'
import { Schema } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'
import { liftEmptyBlock } from 'prosemirror-commands'
import { addListNodes, liftListItem } from 'prosemirror-schema-list'
import { undo, redo, yUndoPluginKey } from '../../src/y-tiptap.js'
import { createNewProsemirrorViewWithSchema, schema } from '../shared.js'

const listSchema = new Schema({
  nodes: addListNodes(schema.spec.nodes, 'paragraph block*', 'block'),
  marks: schema.spec.marks
})
const paragraph = text => listSchema.node('paragraph', null, text ? listSchema.text(text) : null)
const bulletList = texts => listSchema.node('bullet_list', null,
  texts.map(text => listSchema.node('list_item', null, paragraph(text))))

const checkUndoRedoSelection = (doc, anchor, head, edit) => {
  const ydoc = new Y.Doc()
  const view = createNewProsemirrorViewWithSchema(ydoc, listSchema, true)
  try {
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content))
    yUndoPluginKey.getState(view.state).undoManager.clear()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)))
    const before = view.state
    edit(view)
    const after = view.state
    t.assert(!before.doc.eq(after.doc), 'the command changed the document')

    for (let cycle = 0; cycle < 2; cycle++) {
      undo(view.state)
      t.assert(view.state.doc.eq(before.doc), 'undo restores the document')
      t.compare(view.state.selection.toJSON(), before.selection.toJSON(), 'undo restores the selection')
      redo(view.state)
      t.assert(view.state.doc.eq(after.doc), 'redo restores the document')
      t.compare(view.state.selection.toJSON(), after.selection.toJSON(), 'redo restores the selection')
    }
  } finally {
    view.destroy()
    ydoc.destroy()
  }
}

export const testUndoRedoSelectionAfterExitingEmptyBullet = () => {
  const list = bulletList(['one', 'two', ''])
  const doc = listSchema.node('doc', null, [list, paragraph('below'), paragraph(''), paragraph('last')])
  const cursor = list.nodeSize - 3
  checkUndoRedoSelection(doc, cursor, cursor, view => {
    t.assert(liftEmptyBlock(view.state, view.dispatch), 'Enter exits the empty bullet')
  })
}

export const testUndoRedoSelectionAfterLiftingMiddleBullet = () => {
  const list = bulletList(['one', 'second', 'three'])
  const doc = listSchema.node('doc', null, [list, paragraph('below'), paragraph(''), paragraph('last')])
  const cursor = 1 + list.child(0).nodeSize + 2 + 3
  checkUndoRedoSelection(doc, cursor, cursor, view => {
    t.assert(liftListItem(listSchema.nodes.list_item)(view.state, view.dispatch), 'Shift+Tab lifts the middle bullet')
  })
}

export const testUndoRedoSelectionAfterDeletingDocumentEnd = () => {
  const doc = listSchema.node('doc', null, [paragraph('start'), paragraph('middle'), paragraph('last paragraph')])
  checkUndoRedoSelection(doc, doc.content.size - 1, 3, view => {
    view.dispatch(view.state.tr.deleteSelection())
  })
}
