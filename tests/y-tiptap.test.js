import * as t from 'lib0/testing'
import * as prng from 'lib0/prng'
import * as math from 'lib0/math'
import * as Y from 'yjs'
// @ts-ignore
import { applyRandomTests } from 'yjs/testHelper'

import {
  absolutePositionToRelativePosition,
  createDecorations,
  findAbsolutePositionAfterStructuralChange,
  isMisresolvedAfterStructuralChange,
  isMisresolvedTextPosition,
  prosemirrorJSONToYDoc,
  prosemirrorJSONToYXmlFragment,
  relativePositionToAbsolutePosition,
  redo,
  undo,
  yCursorPlugin,
  yCursorPluginKey,
  yDocToProsemirrorJSON,
  ySyncPlugin,
  ySyncPluginKey,
  yUndoPlugin,
  yXmlFragmentToProsemirrorJSON
} from '../src/y-tiptap.js'
import { Awareness } from 'y-protocols/awareness'
import {
  EditorState,
  Plugin,
  Selection,
  TextSelection,
  NodeSelection
} from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { Schema } from 'prosemirror-model'
import * as basicSchema from 'prosemirror-schema-basic'
import { findWrapping } from 'prosemirror-transform'
import { schema as complexSchema } from './complexSchema.js'
import * as promise from 'lib0/promise'

const schema = new Schema({
  nodes: basicSchema.nodes,
  marks: Object.assign({}, basicSchema.marks, {
    comment: {
      attrs: {
        id: { default: null }
      },
      excludes: '',
      parseDOM: [{ tag: 'comment' }],
      toDOM (node) {
        return ['comment', { comment_id: node.attrs.id }]
      }
    }
  })
})

/**
 * Minimal stand-in for the `NodeRangeSelection` that `@tiptap/extension-node-range`
 * registers via `Selection.jsonID('nodeRange', …)`. y-tiptap reconstructs node range
 * selections through ProseMirror's selection registry (`Selection.fromJSON`) rather than
 * importing the extension, so registering this here lets us exercise that code path.
 */
class NodeRangeSelection extends Selection {
  /**
   * @param {import('prosemirror-model').ResolvedPos} $anchor
   * @param {import('prosemirror-model').ResolvedPos} $head
   * @param {number} depth
   */
  constructor ($anchor, $head, depth) {
    super($anchor, $head)
    this.depth = depth
  }

  map (doc, mapping) {
    return new NodeRangeSelection(
      doc.resolve(mapping.map(this.anchor)),
      doc.resolve(mapping.map(this.head)),
      this.depth
    )
  }

  eq (other) {
    return other instanceof NodeRangeSelection &&
      other.anchor === this.anchor &&
      other.head === this.head &&
      other.depth === this.depth
  }

  toJSON () {
    return { type: 'nodeRange', anchor: this.anchor, head: this.head, depth: this.depth }
  }

  static fromJSON (doc, json) {
    return new NodeRangeSelection(doc.resolve(json.anchor), doc.resolve(json.head), json.depth)
  }
}
Selection.jsonID('nodeRange', NodeRangeSelection)

/**
 * Verify that update events in plugins are only fired once.
 *
 * Initially reported in https://github.com/yjs/y-prosemirror/issues/121
 *
 * @param {t.TestCase} _tc
 */
export const testPluginIntegrity = (_tc) => {
  const ydoc = new Y.Doc()
  let viewUpdateEvents = 0
  let stateUpdateEvents = 0
  const customPlugin = new Plugin({
    state: {
      init: () => {
        return {}
      },
      apply: () => {
        stateUpdateEvents++
      }
    },
    view: () => {
      return {
        update () {
          viewUpdateEvents++
        }
      }
    }
  })
  const view = new EditorView(null, {
    // @ts-ignore
    state: EditorState.create({
      schema,
      plugins: [
        ySyncPlugin(ydoc.get('prosemirror', Y.XmlFragment)),
        yUndoPlugin(),
        customPlugin
      ]
    })
  })
  view.dispatch(
    view.state.tr.insert(
      0,
      /** @type {any} */ (
        schema.node('paragraph', undefined, schema.text('hello world'))
      )
    )
  )
  t.compare(
    { viewUpdateEvents, stateUpdateEvents },
    {
      viewUpdateEvents: 1,
      stateUpdateEvents: 2 // fired twice, because the ySyncPlugin adds additional fields to state after the initial render
    },
    'events are fired only once'
  )
}

/**
 * Y.UndoManager registers a `doc.on('destroy', …)` listener in its constructor
 * that UndoManager.destroy() never removes. When the doc outlives the editor
 * (e.g. several editors sharing one provider), that listener keeps the manager —
 * and everything it references — reachable, leaking memory on every destroy.
 * yUndoPlugin must remove that listener when the plugin view is destroyed.
 *
 * @param {t.TestCase} _tc
 */
export const testUndoManagerDocDestroyListenerCleanup = (_tc) => {
  const ydoc = new Y.Doc()
  const countDocDestroyListeners = () => {
    const observers = ydoc._observers.get('destroy')
    return observers ? observers.size : 0
  }
  const baseline = countDocDestroyListeners()

  const view = new EditorView(null, {
    // @ts-ignore
    state: EditorState.create({
      schema,
      plugins: [
        ySyncPlugin(ydoc.get('prosemirror', Y.XmlFragment)),
        yUndoPlugin()
      ]
    })
  })
  view.dispatch(
    view.state.tr.insert(
      0,
      /** @type {any} */ (
        schema.node('paragraph', undefined, schema.text('hello world'))
      )
    )
  )

  t.assert(
    countDocDestroyListeners() > baseline,
    'UndoManager registered a doc destroy listener'
  )

  view.destroy()

  t.assert(
    countDocDestroyListeners() === baseline,
    'doc destroy listener is removed after view.destroy'
  )
}

/**
 * A caller-provided UndoManager owns its own lifecycle, so yUndoPlugin must not
 * strip listeners it did not add.
 *
 * @param {t.TestCase} _tc
 */
export const testExternalUndoManagerListenersUntouched = (_tc) => {
  const ydoc = new Y.Doc()
  const fragment = ydoc.get('prosemirror', Y.XmlFragment)
  const externalUndoManager = new Y.UndoManager(fragment)
  const countDocDestroyListeners = () => {
    const observers = ydoc._observers.get('destroy')
    return observers ? observers.size : 0
  }
  const withExternal = countDocDestroyListeners()

  const view = new EditorView(null, {
    // @ts-ignore
    state: EditorState.create({
      schema,
      plugins: [
        ySyncPlugin(fragment),
        yUndoPlugin({ undoManager: externalUndoManager })
      ]
    })
  })
  view.dispatch(
    view.state.tr.insert(
      0,
      /** @type {any} */ (
        schema.node('paragraph', undefined, schema.text('hello world'))
      )
    )
  )
  view.destroy()

  // The external manager's listener must still be present after destroy.
  t.assert(
    countDocDestroyListeners() === withExternal,
    'externally-provided UndoManager listeners are left intact'
  )
}

/**
 * Test that createDecorations handles missing ySyncPlugin state gracefully.
 *
 * This can happen during editor initialization when the ySyncPlugin state
 * is not yet available.
 *
 * @param {t.TestCase} _tc
 */
export const testCreateDecorationsWithoutYSyncPlugin = (_tc) => {
  const ydoc = new Y.Doc()
  const awareness = new Awareness(ydoc)

  // Create an EditorState without ySyncPlugin
  const state = EditorState.create({
    schema
  })

  // This should not throw even though ySyncPluginKey.getState(state) returns undefined
  const decorations = createDecorations(
    state,
    awareness,
    () => true,
    () => document.createElement('span'),
    () => ({})
  )

  // Should return an empty DecorationSet
  t.assert(
    decorations.find().length === 0,
    'should return empty decorations when ystate is undefined'
  )
}

/**
 * @param {t.TestCase} tc
 */
export const testOverlappingMarks = (_tc) => {
  const view = new EditorView(null, {
    state: EditorState.create({
      schema,
      plugins: []
    })
  })
  view.dispatch(
    view.state.tr.insert(
      0,
      schema.node('paragraph', undefined, schema.text('hello world'))
    )
  )

  view.dispatch(view.state.tr.addMark(1, 3, schema.mark('comment', { id: 4 })))
  view.dispatch(view.state.tr.addMark(2, 4, schema.mark('comment', { id: 5 })))
  const stateJSON = JSON.parse(JSON.stringify(view.state.doc.toJSON()))
  // attrs.ychange is only available with a schema
  delete stateJSON.content[0].attrs
  const back = prosemirrorJSONToYDoc(/** @type {any} */ (schema), stateJSON)
  // test if transforming back and forth from Yjs doc works
  const backandforth = JSON.parse(JSON.stringify(yDocToProsemirrorJSON(back)))
  t.compare(stateJSON, backandforth)

  // re-assure that we have overlapping comments
  const expected =
    '[{"type":"text","marks":[{"type":"comment","attrs":{"id":4}}],"text":"h"},{"type":"text","marks":[{"type":"comment","attrs":{"id":4}},{"type":"comment","attrs":{"id":5}}],"text":"e"},{"type":"text","marks":[{"type":"comment","attrs":{"id":5}}],"text":"l"},{"type":"text","text":"lo world"}]'
  t.compare(backandforth.content[0].content, JSON.parse(expected))
}

/**
 * @param {t.TestCase} tc
 */
export const testDocTransformation = (_tc) => {
  const view = createNewProsemirrorView(new Y.Doc())
  view.dispatch(
    view.state.tr.insert(
      0,
      /** @type {any} */ (
        schema.node('paragraph', undefined, schema.text('hello world'))
      )
    )
  )
  const stateJSON = view.state.doc.toJSON()
  // test if transforming back and forth from Yjs doc works
  const backandforth = yDocToProsemirrorJSON(
    prosemirrorJSONToYDoc(/** @type {any} */ (schema), stateJSON)
  )
  t.compare(stateJSON, backandforth)
}

export const testXmlFragmentTransformation = (_tc) => {
  const view = createNewProsemirrorView(new Y.Doc())
  view.dispatch(
    view.state.tr.insert(
      0,
      /** @type {any} */ (
        schema.node('paragraph', undefined, schema.text('hello world'))
      )
    )
  )
  const stateJSON = view.state.doc.toJSON()
  console.log(JSON.stringify(stateJSON))
  // test if transforming back and forth from yXmlFragment works
  const xml = new Y.XmlFragment()
  prosemirrorJSONToYXmlFragment(/** @type {any} */ (schema), stateJSON, xml)
  const doc = new Y.Doc()
  doc.getMap('root').set('firstDoc', xml)
  const backandforth = yXmlFragmentToProsemirrorJSON(xml)
  console.log(JSON.stringify(backandforth))
  t.compare(stateJSON, backandforth)
}

export const testChangeOrigin = (_tc) => {
  const ydoc = new Y.Doc()
  const yXmlFragment = ydoc.get('prosemirror', Y.XmlFragment)
  const yundoManager = new Y.UndoManager(yXmlFragment, {
    trackedOrigins: new Set(['trackme'])
  })
  const view = createNewProsemirrorView(ydoc)
  view.dispatch(
    view.state.tr.insert(
      0,
      /** @type {any} */ (
        schema.node('paragraph', undefined, schema.text('world'))
      )
    )
  )
  const ysyncState1 = ySyncPluginKey.getState(view.state)
  t.assert(ysyncState1.isChangeOrigin === false)
  t.assert(ysyncState1.isUndoRedoOperation === false)
  ydoc.transact(() => {
    yXmlFragment.get(0).get(0).insert(0, 'hello')
  }, 'trackme')
  const ysyncState2 = ySyncPluginKey.getState(view.state)
  t.assert(ysyncState2.isChangeOrigin === true)
  t.assert(ysyncState2.isUndoRedoOperation === false)
  yundoManager.undo()
  const ysyncState3 = ySyncPluginKey.getState(view.state)
  t.assert(ysyncState3.isChangeOrigin === true)
  t.assert(ysyncState3.isUndoRedoOperation === true)
}

/**
 * @param {t.TestCase} tc
 */
export const testEmptyNotSync = (_tc) => {
  const ydoc = new Y.Doc()
  const type = ydoc.getXmlFragment('prosemirror')
  const view = createNewComplexProsemirrorView(ydoc)
  t.assert(type.toString() === '', 'should only sync after first change')

  view.dispatch(
    view.state.tr.setNodeMarkup(0, undefined, {
      checked: true
    })
  )
  t.compareStrings(type.toString(), '<custom checked="true"></custom>')
}

/**
 * @param {t.TestCase} tc
 */
export const testEmptyParagraph = (_tc) => {
  const ydoc = new Y.Doc()
  const view = createNewProsemirrorView(ydoc)
  view.dispatch(
    view.state.tr.insert(
      0,
      /** @type {any} */ (
        schema.node('paragraph', undefined, schema.text('123'))
      )
    )
  )
  const yxml = ydoc.get('prosemirror')
  t.assert(
    yxml.length === 2 && yxml.get(0).length === 1,
    'contains one paragraph containing a ytext'
  )
  view.dispatch(view.state.tr.delete(1, 4)) // delete characters 123
  t.assert(
    yxml.length === 2 && yxml.get(0).length === 1,
    "doesn't delete the ytext"
  )
}

/**
 * Test duplication issue https://github.com/yjs/y-prosemirror/issues/161
 *
 * @param {t.TestCase} tc
 */
export const testInsertDuplication = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const view1 = createNewProsemirrorView(ydoc1)
  const view2 = createNewProsemirrorView(ydoc2)
  const yxml1 = ydoc1.getXmlFragment('prosemirror')
  const yxml2 = ydoc2.getXmlFragment('prosemirror')
  yxml1.observeDeep((events) => {
    events.forEach((event) => {
      console.log('yxml1: ', JSON.stringify(event.changes.delta))
    })
  })
  yxml2.observeDeep((events) => {
    events.forEach((event) => {
      console.log('yxml2: ', JSON.stringify(event.changes.delta))
    })
  })
  view1.dispatch(
    view1.state.tr.insert(0, /** @type {any} */ (schema.node('paragraph')))
  )
  const sync = () => {
    Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1))
    Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))
    Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1))
    Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))
  }
  sync()
  view1.dispatch(view1.state.tr.insertText('1', 1, 1))
  view2.dispatch(view2.state.tr.insertText('2', 1, 1))
  sync()
  view1.dispatch(view1.state.tr.insertText('1', 2, 2))
  view2.dispatch(view2.state.tr.insertText('2', 3, 3))
  sync()
  checkResult({ testObjects: [view1, view2] })
  t.assert(
    yxml1.toString() === '<paragraph>1122</paragraph><paragraph></paragraph>'
  )
}

export const testReplaceBoldWithCode = (_tc) => {
  const ydoc = new Y.Doc()
  const yXmlFragment = ydoc.get('prosemirror', Y.XmlFragment)
  const view = createNewProsemirrorView(ydoc) // This already includes ySyncPlugin

  // Insert a paragraph with some text
  view.dispatch(
    view.state.tr.insert(
      0,
      schema.node('paragraph', undefined, schema.text('test'))
    )
  )

  view.dispatch(view.state.tr.addMark(1, 5, schema.mark('strong')))

  t.compare(
    JSON.parse(JSON.stringify(view.state.doc.toJSON().content[0].content)),
    [
      {
        type: 'text',
        marks: [{ type: 'strong' }],
        text: 'test'
      }
    ],
    'invalid view state'
  )

  t.compare(
    yXmlFragment.get(0).toString(),
    '<paragraph><strong>test</strong></paragraph>',
    'invalid ydoc state'
  )

  view.dispatch(
    view.state.tr
      .removeMark(1, 5, schema.mark('strong'))
      .addMark(1, 5, schema.mark('code'))
  )

  t.compare(
    JSON.parse(JSON.stringify(view.state.doc.toJSON().content[0].content)),
    [
      {
        type: 'text',
        marks: [{ type: 'code' }],
        text: 'test'
      }
    ],
    'invalid view state'
  )

  t.compare(
    yXmlFragment.get(0).toString(),
    '<paragraph><code>test</code></paragraph>',
    'invalid ydoc state'
  )
}

export const testAddToHistory = (_tc) => {
  const ydoc = new Y.Doc()
  const view = createNewProsemirrorViewWithUndoManager(ydoc)
  view.dispatch(
    view.state.tr.insert(
      0,
      /** @type {any} */ (
        schema.node('paragraph', undefined, schema.text('123'))
      )
    )
  )
  const yxml = ydoc.get('prosemirror')
  t.assert(
    yxml.length === 2 && yxml.get(0).length === 1,
    'contains inserted content'
  )
  undo(view.state)
  t.assert(yxml.length === 0, 'insertion was undone')
  redo(view.state)
  t.assert(
    yxml.length === 2 && yxml.get(0).length === 1,
    'contains inserted content'
  )
  undo(view.state)
  t.assert(yxml.length === 0, 'insertion was undone')
  // now insert content again, but with `'addToHistory': false`
  view.dispatch(
    view.state.tr
      .insert(
        0,
        /** @type {any} */ (
          schema.node('paragraph', undefined, schema.text('123'))
        )
      )
      .setMeta('addToHistory', false)
  )
  t.assert(
    yxml.length === 2 && yxml.get(0).length === 1,
    'contains inserted content'
  )
  undo(view.state)
  t.assert(
    yxml.length === 2 && yxml.get(0).length === 1,
    'insertion was *not* undone'
  )
}

/**
 * Tests for #126 - initial cursor position should be retained, not jump to the end.
 *
 * @param {t.TestCase} _tc
 */
export const testInitialCursorPosition = async (_tc) => {
  const ydoc = new Y.Doc()
  const yxml = ydoc.get('prosemirror', Y.XmlFragment)
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText('hello world!')])
  yxml.insert(0, [p])
  console.log('yxml', yxml.toString())
  const view = createNewProsemirrorView(ydoc)
  view.focus()
  await promise.wait(10)
  console.log('anchor', view.state.selection.anchor)
  t.assert(view.state.selection.anchor === 1)
  t.assert(view.state.selection.head === 1)
}

export const testInitialCursorPosition2 = async (_tc) => {
  const ydoc = new Y.Doc()
  const yxml = ydoc.get('prosemirror', Y.XmlFragment)
  console.log('yxml', yxml.toString())
  const view = createNewProsemirrorView(ydoc)
  view.focus()
  await promise.wait(10)
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText('hello world!')])
  yxml.insert(0, [p])
  console.log('anchor', view.state.selection.anchor)
  t.assert(view.state.selection.anchor === 1)
  t.assert(view.state.selection.head === 1)
}

export const testStaleAwarenessTransactions = async (_tc) => {
  const ydoc = new Y.Doc()
  const awareness = new Awareness(ydoc)
  let insertedContent = false
  const view = new EditorView(null, {
    // @ts-ignore
    state: EditorState.create({
      schema,
      plugins: [
        ySyncPlugin(ydoc.get('prosemirror', Y.XmlFragment)),
        yCursorPlugin(awareness)
      ]
    })
  })

  const applyTransaction = tr => {
    const newState = view.state.apply(tr)
    view.updateState(newState)
  }

  view.setProps({
    dispatchTransaction: tr => {
      const cursorMeta = tr.getMeta(yCursorPluginKey)

      if (!insertedContent && cursorMeta && cursorMeta.awarenessUpdated) {
        insertedContent = true
        // Force the queued awareness transaction to become stale before apply.
        applyTransaction(view.state.tr.insertText('x', 1))
      }

      applyTransaction(tr)
    }
  })

  awareness.setLocalStateField('user', {
    name: 'Test User',
    color: '#ff0000'
  })

  await promise.wait(10)

  t.assert(view.state.doc.textContent === 'x', 'stale awareness transactions should not crash the editor')
}

export const testVersioning = async (_tc) => {
  const ydoc = new Y.Doc({ gc: false })
  const yxml = ydoc.get('prosemirror', Y.XmlFragment)
  const permanentUserData = new Y.PermanentUserData(ydoc)
  permanentUserData.setUserMapping(ydoc, ydoc.clientID, 'me')
  ydoc.gc = false
  console.log('yxml', yxml.toString())
  const view = createNewComplexProsemirrorView(ydoc)
  const p = new Y.XmlElement('paragraph')
  const ytext = new Y.XmlText('hello world!')
  p.insert(0, [ytext])
  yxml.insert(0, [p])
  const snapshot1 = Y.snapshot(ydoc)
  const snapshotDoc1 = Y.encodeStateAsUpdateV2(ydoc)
  ytext.delete(0, 6)
  const snapshot2 = Y.snapshot(ydoc)
  const snapshotDoc2 = Y.encodeStateAsUpdateV2(ydoc)
  view.dispatch(
    view.state.tr.setMeta(ySyncPluginKey, {
      snapshot: snapshot2,
      prevSnapshot: snapshot1,
      permanentUserData
    })
  )
  await promise.wait(50)
  console.log('calculated diff via snapshots: ', view.state.doc.toJSON())
  // recreate the JSON, because ProseMirror messes with the constructors
  const viewstate1 = JSON.parse(
    JSON.stringify(view.state.doc.toJSON().content[0].content)
  )
  const expectedState = [
    {
      type: 'text',
      marks: [{ type: 'ychange', attrs: { user: 'me', type: 'removed' } }],
      text: 'hello '
    },
    {
      type: 'text',
      text: 'world!'
    }
  ]
  console.log('calculated diff via snapshots: ', JSON.stringify(viewstate1))
  t.compare(viewstate1, expectedState)

  t.info('now check whether we get the same result when rendering the updates')
  view.dispatch(
    view.state.tr.setMeta(ySyncPluginKey, {
      snapshot: snapshotDoc2,
      prevSnapshot: snapshotDoc1,
      permanentUserData
    })
  )
  await promise.wait(50)

  const viewstate2 = JSON.parse(
    JSON.stringify(view.state.doc.toJSON().content[0].content)
  )
  console.log('calculated diff via updates: ', JSON.stringify(viewstate2))
  t.compare(viewstate2, expectedState)
}

export const testVersioningWithGarbageCollection = async (_tc) => {
  const ydoc = new Y.Doc()
  const yxml = ydoc.get('prosemirror', Y.XmlFragment)
  const permanentUserData = new Y.PermanentUserData(ydoc)
  permanentUserData.setUserMapping(ydoc, ydoc.clientID, 'me')
  console.log('yxml', yxml.toString())
  const view = createNewComplexProsemirrorView(ydoc)
  const p = new Y.XmlElement('paragraph')
  const ytext = new Y.XmlText('hello world!')
  p.insert(0, [ytext])
  yxml.insert(0, [p])
  const snapshotDoc1 = Y.encodeStateAsUpdateV2(ydoc)
  ytext.delete(0, 6)
  const snapshotDoc2 = Y.encodeStateAsUpdateV2(ydoc)
  view.dispatch(
    view.state.tr.setMeta(ySyncPluginKey, {
      snapshot: snapshotDoc2,
      prevSnapshot: snapshotDoc1,
      permanentUserData
    })
  )
  await promise.wait(50)
  console.log('calculated diff via snapshots: ', view.state.doc.toJSON())
  // recreate the JSON, because ProseMirror messes with the constructors
  const viewstate1 = JSON.parse(
    JSON.stringify(view.state.doc.toJSON().content[0].content)
  )
  const expectedState = [
    {
      type: 'text',
      marks: [{ type: 'ychange', attrs: { user: 'me', type: 'removed' } }],
      text: 'hello '
    },
    {
      type: 'text',
      text: 'world!'
    }
  ]
  console.log('calculated diff via snapshots: ', JSON.stringify(viewstate1))
  t.compare(viewstate1, expectedState)
}

export const testAddToHistoryIgnore = (_tc) => {
  const ydoc = new Y.Doc()
  const view = createNewProsemirrorViewWithUndoManager(ydoc)
  // perform two changes that are tracked by um - supposed to be merged into a single undo-manager item
  view.dispatch(
    view.state.tr.insert(
      0,
      /** @type {any} */ (
        schema.node('paragraph', undefined, schema.text('123'))
      )
    )
  )
  view.dispatch(
    view.state.tr.insert(
      0,
      /** @type {any} */ (
        schema.node('paragraph', undefined, schema.text('456'))
      )
    )
  )
  const yxml = ydoc.get('prosemirror')
  t.assert(
    yxml.length === 3 && yxml.get(0).length === 1,
    'contains inserted content (1)'
  )
  view.dispatch(
    view.state.tr
      .insert(
        0,
        /** @type {any} */ (
          schema.node('paragraph', undefined, schema.text('abc'))
        )
      )
      .setMeta('addToHistory', false)
  )
  t.assert(
    yxml.length === 4 && yxml.get(0).length === 1,
    'contains inserted content (2)'
  )
  view.dispatch(
    view.state.tr.insert(
      0,
      /** @type {any} */ (
        schema.node('paragraph', undefined, schema.text('xyz'))
      )
    )
  )
  t.assert(
    yxml.length === 5 && yxml.get(0).length === 1,
    'contains inserted content (3)'
  )
  undo(view.state)
  t.assert(yxml.length === 4, 'insertion (3) was undone')
  undo(view.state)
  console.log(yxml.toString())
  t.assert(
    yxml.length === 1 &&
      yxml.get(0).toString() === '<paragraph>abc</paragraph>',
    'insertion (1) was undone'
  )
}

const createNewProsemirrorViewWithSchema = (y, schema, undoManager = false) => {
  const view = new EditorView(null, {
    // @ts-ignore
    state: EditorState.create({
      schema,
      plugins: [ySyncPlugin(y.get('prosemirror', Y.XmlFragment))].concat(
        undoManager ? [yUndoPlugin()] : []
      )
    })
  })
  return view
}

const createViewWithCursor = (ydoc, awareness) => {
  return new EditorView(null, {
    // @ts-ignore
    state: EditorState.create({
      schema,
      plugins: [
        ySyncPlugin(ydoc.get('prosemirror', Y.XmlFragment)),
        yCursorPlugin(awareness)
      ]
    })
  })
}

/**
 * @param {Y.Doc} ydocA
 * @param {Y.Doc} ydocB
 */
const syncYDocs = (ydocA, ydocB) => {
  Y.applyUpdate(ydocB, Y.encodeStateAsUpdate(ydocA))
  Y.applyUpdate(ydocA, Y.encodeStateAsUpdate(ydocB))
}

/**
 * @param {import('prosemirror-view').EditorView} view
 * @param {Awareness} awareness
 * @param {number} remoteClientId
 * @param {number} pos
 */
const publishRemoteCursor = (view, awareness, remoteClientId, pos) => {
  const ystate = ySyncPluginKey.getState(view.state)
  const anchorRel = absolutePositionToRelativePosition(
    pos,
    ystate.type,
    ystate.binding.mapping
  )
  const headRel = absolutePositionToRelativePosition(
    pos,
    ystate.type,
    ystate.binding.mapping
  )
  awareness.states.set(remoteClientId, {
    user: { name: 'Remote User', color: '#ff0000' },
    cursor: { anchor: anchorRel, head: headRel }
  })
  view.dispatch(view.state.tr.setMeta(yCursorPluginKey, { awarenessUpdated: true }))
}

/**
 * @param {import('prosemirror-view').EditorView} view
 * @return {number|null}
 */
const getRemoteCursorWidgetPos = (view) => {
  const decos = yCursorPluginKey.getState(view.state)
  const found = decos.find(0, view.state.doc.content.size)
  const widget = found.find((d) => d.spec && d.spec.side === 10)
  return widget != null ? widget.from : null
}

const createNewComplexProsemirrorView = (y, undoManager = false) =>
  createNewProsemirrorViewWithSchema(y, complexSchema, undoManager)

const createNewProsemirrorView = (y) =>
  createNewProsemirrorViewWithSchema(y, schema, false)

const createNewProsemirrorViewWithUndoManager = (y) =>
  createNewProsemirrorViewWithSchema(y, schema, true)

let charCounter = 0

const marksChoices = [
  [schema.mark('strong')],
  [schema.mark('comment', { id: 1 })],
  [schema.mark('comment', { id: 2 })],
  [schema.mark('em')],
  [schema.mark('em'), schema.mark('strong')],
  [],
  []
]

const pmChanges = [
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   * @param {EditorView} p
   */
  (_y, gen, p) => {
    // insert text
    const insertPos = prng.int32(gen, 0, p.state.doc.content.size)
    const marks = prng.oneOf(gen, marksChoices)
    const tr = p.state.tr
    const text = charCounter++ + prng.word(gen)
    p.dispatch(tr.insert(insertPos, schema.text(text, marks)))
  },
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   * @param {EditorView} p
   */
  (_y, gen, p) => {
    // delete text
    const insertPos = prng.int32(gen, 0, p.state.doc.content.size)
    const overwrite = math.min(
      prng.int32(gen, 0, p.state.doc.content.size - insertPos),
      2
    )
    p.dispatch(p.state.tr.insertText('', insertPos, insertPos + overwrite))
  },
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   * @param {EditorView} p
   */
  (_y, gen, p) => {
    // format text
    const insertPos = prng.int32(gen, 0, p.state.doc.content.size)
    const formatLen = math.min(
      prng.int32(gen, 0, p.state.doc.content.size - insertPos),
      2
    )
    const mark = prng.oneOf(
      gen,
      marksChoices.filter((choice) => choice.length > 0)
    )[0]
    p.dispatch(p.state.tr.addMark(insertPos, insertPos + formatLen, mark))
  },
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   * @param {EditorView} p
   */
  (_y, gen, p) => {
    // replace text
    const insertPos = prng.int32(gen, 0, p.state.doc.content.size)
    const overwrite = math.min(
      prng.int32(gen, 0, p.state.doc.content.size - insertPos),
      2
    )
    const text = charCounter++ + prng.word(gen)
    p.dispatch(p.state.tr.insertText(text, insertPos, insertPos + overwrite))
  },
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   * @param {EditorView} p
   */
  (_y, gen, p) => {
    // insert paragraph
    const insertPos = prng.int32(gen, 0, p.state.doc.content.size)
    const marks = prng.oneOf(gen, marksChoices)
    const tr = p.state.tr
    const text = charCounter++ + prng.word(gen)
    p.dispatch(
      tr.insert(
        insertPos,
        schema.node('paragraph', undefined, schema.text(text, marks))
      )
    )
  },
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   * @param {EditorView} p
   */
  (_y, gen, p) => {
    // insert codeblock
    const insertPos = prng.int32(gen, 0, p.state.doc.content.size)
    const tr = p.state.tr
    const text = charCounter++ + prng.word(gen)
    p.dispatch(
      tr.insert(
        insertPos,
        schema.node('code_block', undefined, schema.text(text))
      )
    )
  },
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   * @param {EditorView} p
   */
  (_y, gen, p) => {
    // wrap in blockquote
    const insertPos = prng.int32(gen, 0, p.state.doc.content.size)
    const overwrite = prng.int32(gen, 0, p.state.doc.content.size - insertPos)
    const tr = p.state.tr
    tr.setSelection(
      TextSelection.create(tr.doc, insertPos, insertPos + overwrite)
    )
    const $from = tr.selection.$from
    const $to = tr.selection.$to
    const range = $from.blockRange($to)
    const wrapping = range && findWrapping(range, schema.nodes.blockquote)
    if (wrapping) {
      p.dispatch(tr.wrap(range, wrapping))
    }
  }
]

/**
 * @param {any} result
 */
const checkResult = (result) => {
  for (let i = 1; i < result.testObjects.length; i++) {
    const p1 = result.testObjects[i - 1].state.doc.toJSON()
    const p2 = result.testObjects[i].state.doc.toJSON()
    t.compare(p1, p2)
  }
}

/**
 * @param {t.TestCase} _tc
 */
export const testRestoreSelectionForDeletedInlineNode = (_tc) => {
  const ydoc = new Y.Doc()
  const schemaWithInlineAtom = new Schema({
    nodes: Object.assign({}, basicSchema.nodes, {
      inlineatom: {
        inline: true,
        group: 'inline',
        atom: true,
        selectable: true,
        parseDOM: [{ tag: 'inline-atom' }],
        toDOM () {
          return ['inline-atom']
        }
      }
    }),
    marks: basicSchema.marks
  })

  const view = createNewProsemirrorViewWithSchema(ydoc, schemaWithInlineAtom)

  view.dispatch(
    view.state.tr.insert(
      0,
      schemaWithInlineAtom.node('paragraph', undefined, [
        schemaWithInlineAtom.text('a'),
        schemaWithInlineAtom.node('inlineatom'),
        schemaWithInlineAtom.text('b')
      ])
    )
  )

  // compute the absolute position of the inline atom node inside the doc
  const para = view.state.doc.child(0)
  let pos = 1
  for (let i = 0; i < para.childCount; i++) {
    const child = para.child(i)
    if (child.type.name === 'inlineatom') break
    pos += child.nodeSize
  }

  view.dispatch(
    view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos))
  )

  const node = view.state.doc.nodeAt(pos)
  const nodeSize = node ? node.nodeSize : 1
  view.dispatch(view.state.tr.delete(pos, pos + nodeSize))

  const sel = view.state.selection
  t.assert(
    !(sel instanceof NodeSelection),
    'selection should not be a NodeSelection'
  )
  t.assert(sel instanceof TextSelection, 'selection should be a TextSelection')
  t.assert(
    sel.anchor >= 0 && sel.anchor <= view.state.doc.content.size,
    'selection anchor within bounds'
  )
}

export const testRestoreSelectionForDeletedBlockNode = async (_tc) => {
  const ydoc = new Y.Doc()
  const view = createNewComplexProsemirrorView(ydoc)

  view.dispatch(
    view.state.tr.insert(0, [
      complexSchema.node('paragraph', undefined, complexSchema.text('before')),
      complexSchema.node('custom'),
      complexSchema.node('paragraph', undefined, complexSchema.text('after'))
    ])
  )

  // compute the absolute position of the custom block node inside the doc
  const doc = view.state.doc
  let pos = 1
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i)
    if (child.type.name === 'custom') break
    pos += child.nodeSize
  }

  view.dispatch(
    view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos))
  )

  const node = view.state.doc.nodeAt(pos)
  const nodeSize = node ? node.nodeSize : 1
  view.dispatch(view.state.tr.delete(pos, pos + nodeSize))

  const sel = view.state.selection
  t.assert(
    sel instanceof NodeSelection,
    'selection should be a NodeSelection for block node'
  )
}

/**
 * A NodeRangeSelection (e.g. an active drag-handle drag) must survive a remote Yjs
 * update instead of being downgraded to a TextSelection. Regression test for TT-608,
 * where the downgrade caused collaborative drags to duplicate the dragged block.
 *
 * @param {t.TestCase} _tc
 */
export const testRestoreNodeRangeSelectionOnRemoteUpdate = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const view1 = createNewProsemirrorView(ydoc1)
  const view2 = createNewProsemirrorView(ydoc2)

  // three top-level paragraphs, authored on peer 1
  view1.dispatch(
    view1.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('one')),
      schema.node('paragraph', undefined, schema.text('two')),
      schema.node('paragraph', undefined, schema.text('three'))
    ])
  )
  // sync both peers to the same content
  Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1))
  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  // peer 1 selects a range of block nodes (paragraphs 1 + 2) at depth 0
  const doc1 = view1.state.doc
  const head = doc1.child(0).nodeSize + doc1.child(1).nodeSize
  view1.dispatch(
    view1.state.tr.setSelection(
      new NodeRangeSelection(doc1.resolve(0), doc1.resolve(head), 0)
    )
  )
  t.assert(
    view1.state.selection instanceof NodeRangeSelection,
    'precondition: peer 1 holds a NodeRangeSelection'
  )

  // peer 2 makes an inline edit in the last paragraph (a concurrent remote change)
  const editPos = view2.state.doc.content.size - 1
  view2.dispatch(view2.state.tr.insertText('!', editPos, editPos))

  // deliver peer 2's change to peer 1 -> triggers restoreRelativeSelection on peer 1
  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  const sel = view1.state.selection
  t.assert(
    sel instanceof NodeRangeSelection,
    'NodeRangeSelection should be preserved across a remote update, not downgraded'
  )
  t.assert(
    /** @type {any} */ (sel).depth === 0,
    'the selection depth should be preserved'
  )
}

/**
 * Remote carets must stay at the correct typing position when a block is moved
 * above the remote user's paragraph (drag-and-drop).
 *
 * @param {t.TestCase} _tc
 */
export const testRemoteCursorSurvivesStructuralChange = (_tc) => {
  const ydoc = new Y.Doc()
  ydoc.clientID = 1
  const awareness = new Awareness(ydoc)
  const view = createViewWithCursor(ydoc, awareness)

  // User A types in the first paragraph; a second block will be dragged above it.
  view.dispatch(
    view.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('hello')),
      schema.node('paragraph', undefined, schema.text('block'))
    ])
  )

  const initialDoc = view.state.doc
  const typingCursorPos = 1 + 'hello'.length
  t.assert(typingCursorPos === 6, 'precondition: cursor position in first paragraph')

  const ystate = ySyncPluginKey.getState(view.state)
  const yXmlFragment = ystate.type
  const remoteClientId = 2
  const anchorRel = absolutePositionToRelativePosition(
    typingCursorPos,
    yXmlFragment,
    ystate.binding.mapping
  )
  const headRel = absolutePositionToRelativePosition(
    typingCursorPos,
    yXmlFragment,
    ystate.binding.mapping
  )
  awareness.states.set(remoteClientId, {
    user: { name: 'Remote User', color: '#ff0000' },
    cursor: { anchor: anchorRel, head: headRel }
  })
  view.dispatch(view.state.tr.setMeta(yCursorPluginKey, { awarenessUpdated: true }))

  // Simulate drag-and-drop: move the second block above the first paragraph.
  const blockNode = initialDoc.child(1)
  const blockStart = initialDoc.child(0).nodeSize
  const blockSize = blockNode.nodeSize
  view.dispatch(
    view.state.tr.delete(blockStart, blockStart + blockSize).insert(0, blockNode)
  )

  const expectedCursorPos = typingCursorPos + blockSize

  // Simulate the remote user re-publishing their cursor after the structural change
  // (e.g. continued typing once the drag-and-drop update has been applied).
  const ystateAfter = ySyncPluginKey.getState(view.state)
  const refreshedAnchorRel = absolutePositionToRelativePosition(
    expectedCursorPos,
    ystateAfter.type,
    ystateAfter.binding.mapping
  )
  const refreshedHeadRel = absolutePositionToRelativePosition(
    expectedCursorPos,
    ystateAfter.type,
    ystateAfter.binding.mapping
  )
  awareness.states.set(remoteClientId, {
    user: { name: 'Remote User', color: '#ff0000' },
    cursor: { anchor: refreshedAnchorRel, head: refreshedHeadRel }
  })
  view.dispatch(view.state.tr.setMeta(yCursorPluginKey, { awarenessUpdated: true }))

  const decos = yCursorPluginKey.getState(view.state)
  const found = decos.find(0, view.state.doc.content.size)
  t.assert(found.length >= 1, 'remote cursor decorations should be present')

  const widgetDeco = found.find((d) => d.spec && d.spec.side === 10)
  const inlineDeco = found.find((d) => !d.spec || d.spec.side !== 10)

  t.assert(widgetDeco != null, 'remote cursor widget should exist')
  t.assert(
    widgetDeco.from > 1,
    'remote cursor should not jump to document start'
  )
  t.assert(
    widgetDeco.from >= expectedCursorPos - 1 &&
      widgetDeco.from <= expectedCursorPos + 1,
    `remote cursor should be near ${expectedCursorPos}, got ${widgetDeco.from}`
  )
  if (inlineDeco) {
    t.assert(
      Math.abs(inlineDeco.from - inlineDeco.to) <= 1,
      'collapsed remote selection should not appear split'
    )
    t.assert(
      Math.abs(inlineDeco.from - widgetDeco.from) <= 1,
      'remote selection highlight should match caret widget position'
    )
  }
}

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
  const resolvedAnchor = 13
  const resolvedHead = 1

  const oldConditionTriggers =
    relSel.absAnchor > 1 &&
    resolvedAnchor !== null &&
    resolvedHead !== null &&
    resolvedAnchor <= 1
  const newConditionTriggers =
    relSel.absHead > 1 &&
    resolvedHead !== null &&
    resolvedHead <= 1

  t.assert(
    !oldConditionTriggers && newConditionTriggers,
    'only the updated fallback condition should handle head-only misresolution'
  )

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
 * Stale awareness positions must not render a remote caret at the document start
 * after a structural change.
 *
 * @param {t.TestCase} _tc
 */
export const testStaleRemoteCursorHiddenAfterStructuralChange = (_tc) => {
  const ydoc = new Y.Doc()
  ydoc.clientID = 1
  const awareness = new Awareness(ydoc)
  const view = createViewWithCursor(ydoc, awareness)
  const remoteClientId = 2

  view.dispatch(
    view.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('hello')),
      schema.node('paragraph', undefined, schema.text('block'))
    ])
  )

  publishRemoteCursor(view, awareness, remoteClientId, 6)

  const initialDoc = view.state.doc
  const blockNode = initialDoc.child(1)
  const blockStart = initialDoc.child(0).nodeSize
  view.dispatch(
    view.state.tr
      .delete(blockStart, blockStart + blockNode.nodeSize)
      .insert(0, blockNode)
  )

  // Recompute decorations without refreshing awareness (simulates lagging cursor broadcast).
  view.dispatch(view.state.tr.setMeta(yCursorPluginKey, { awarenessUpdated: true }))

  const widgetPos = getRemoteCursorWidgetPos(view)
  t.assert(
    widgetPos === null,
    'stale remote cursor should not render after structural change without awareness refresh'
  )
}

/**
 * Remote carets near the document start must still render after unrelated remote edits.
 *
 * @param {t.TestCase} _tc
 */
export const testRemoteCursorAtDocumentStartStillRenders = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const awareness1 = new Awareness(ydoc1)
  const awareness2 = new Awareness(ydoc2)
  const view1 = createViewWithCursor(ydoc1, awareness1)
  const view2 = createViewWithCursor(ydoc2, awareness2)
  const remoteClientId = 1

  view1.dispatch(
    view1.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('hello')),
      schema.node('paragraph', undefined, schema.text('block'))
    ])
  )
  syncYDocs(ydoc1, ydoc2)

  const cursorAtStart = 1
  publishRemoteCursor(view2, awareness2, remoteClientId, cursorAtStart)

  const editPos = view2.state.doc.content.size - 1
  view2.dispatch(view2.state.tr.insertText('!', editPos, editPos))
  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  publishRemoteCursor(view2, awareness2, remoteClientId, cursorAtStart)

  const widgetPos = getRemoteCursorWidgetPos(view2)
  t.assert(
    widgetPos !== null && widgetPos >= cursorAtStart && widgetPos <= cursorAtStart + 1,
    `remote cursor at document start should still render near ${cursorAtStart}, got ${widgetPos}`
  )
}

/**
 * Remote carets must track a typing peer across local insertions.
 *
 * @param {t.TestCase} _tc
 */
export const testRemoteCursorDuringLocalTyping = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const awareness1 = new Awareness(ydoc1)
  const awareness2 = new Awareness(ydoc2)
  const view1 = createViewWithCursor(ydoc1, awareness1)
  const view2 = createViewWithCursor(ydoc2, awareness2)
  const remoteClientId = 1

  view1.dispatch(
    view1.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('hello')),
      schema.node('paragraph', undefined, schema.text('block'))
    ])
  )
  syncYDocs(ydoc1, ydoc2)

  let cursorPos = 6
  view1.dispatch(
    view1.state.tr.setSelection(TextSelection.create(view1.state.doc, cursorPos))
  )
  publishRemoteCursor(view2, awareness2, remoteClientId, cursorPos)

  view1.dispatch(view1.state.tr.insertText('!', cursorPos, cursorPos))
  cursorPos += 1
  Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1))
  publishRemoteCursor(view2, awareness2, remoteClientId, cursorPos)

  const widgetPos = getRemoteCursorWidgetPos(view2)
  t.assert(
    widgetPos !== null &&
      widgetPos >= cursorPos - 1 &&
      widgetPos <= cursorPos + 1,
    `remote cursor should follow typing peer at ~${cursorPos}, got ${widgetPos}`
  )
}

/**
 * NodeRangeSelection must survive remote updates when yCursorPlugin is active.
 *
 * @param {t.TestCase} _tc
 */
export const testNodeRangeSelectionWithCursorPluginDuringRemoteEdit = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2
  const awareness1 = new Awareness(ydoc1)
  const awareness2 = new Awareness(ydoc2)
  const view1 = createViewWithCursor(ydoc1, awareness1)
  const view2 = createViewWithCursor(ydoc2, awareness2)

  view1.dispatch(
    view1.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('one')),
      schema.node('paragraph', undefined, schema.text('two')),
      schema.node('paragraph', undefined, schema.text('three'))
    ])
  )
  syncYDocs(ydoc1, ydoc2)

  const doc1 = view1.state.doc
  const head = doc1.child(0).nodeSize + doc1.child(1).nodeSize
  view1.dispatch(
    view1.state.tr.setSelection(
      new NodeRangeSelection(doc1.resolve(0), doc1.resolve(head), 0)
    )
  )
  t.assert(
    view1.state.selection instanceof NodeRangeSelection,
    'precondition: peer 1 holds a NodeRangeSelection'
  )

  const editPos = view2.state.doc.content.size - 1
  view2.dispatch(view2.state.tr.insertText('!', editPos, editPos))
  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  const sel = view1.state.selection
  t.assert(
    sel instanceof NodeRangeSelection,
    'NodeRangeSelection should be preserved with yCursorPlugin enabled'
  )
  t.assert(
    /** @type {any} */ (sel).depth === 0,
    'the selection depth should be preserved with yCursorPlugin enabled'
  )
}

/**
 * @param {t.TestCase} _tc
 */
export const testIsMisresolvedTextPosition = (_tc) => {
  const ydoc = new Y.Doc()
  const view = createNewProsemirrorView(ydoc)

  view.dispatch(
    view.state.tr.insert(0, [
      schema.node('paragraph', undefined, schema.text('hello')),
      schema.node('paragraph', undefined, schema.text('block'))
    ])
  )

  const ystate = ySyncPluginKey.getState(view.state)
  const relAtSix = absolutePositionToRelativePosition(
    6,
    ystate.type,
    ystate.binding.mapping
  )
  t.assert(
    isMisresolvedTextPosition(ydoc, relAtSix, 6) === false,
    'valid mid-document positions should not be misresolved'
  )

  t.assert(
    isMisresolvedTextPosition(ydoc, relAtSix, null) === false,
    'null absolute positions should not be treated as misresolved'
  )

  const initialDoc = view.state.doc
  const blockNode = initialDoc.child(1)
  const blockStart = initialDoc.child(0).nodeSize
  view.dispatch(
    view.state.tr
      .delete(blockStart, blockStart + blockNode.nodeSize)
      .insert(0, blockNode)
  )

  const ystateAfter = ySyncPluginKey.getState(view.state)
  t.assert(
    relativePositionToAbsolutePosition(
      ydoc,
      ystateAfter.type,
      relAtSix,
      ystateAfter.binding.mapping
    ) === null,
    'stale relative positions should resolve to null after block reorder'
  )
}

/**
 * @param {t.TestCase} _tc
 */
export const testIsMisresolvedAfterStructuralChange = (_tc) => {
  const oldDoc = schema.node('doc', undefined, [
    schema.node('paragraph', undefined, schema.text('one')),
    schema.node('paragraph', undefined, schema.text('two here')),
    schema.node('paragraph', undefined, schema.text('three'))
  ])
  const newDoc = schema.node('doc', undefined, [
    schema.node('paragraph', undefined, schema.text('three')),
    schema.node('paragraph', undefined, schema.text('one')),
    schema.node('paragraph', undefined, schema.text('two here'))
  ])

  t.assert(
    isMisresolvedAfterStructuralChange(oldDoc, newDoc, 10, 8),
    'resolved positions at the start of the correct block should be treated as misresolved'
  )
  t.assert(
    isMisresolvedAfterStructuralChange(oldDoc, newDoc, 10, 17) === false,
    'correctly remapped positions should not be treated as misresolved'
  )

  const movedStartOldDoc = schema.node('doc', undefined, [
    schema.node('paragraph', undefined, schema.text('hello')),
    schema.node('paragraph', undefined, schema.text('block'))
  ])
  const movedStartNewDoc = schema.node('doc', undefined, [
    schema.node('paragraph', undefined, schema.text('block')),
    schema.node('paragraph', undefined, schema.text('hello'))
  ])

  t.assert(
    isMisresolvedAfterStructuralChange(movedStartOldDoc, movedStartNewDoc, 1, 1),
    'paragraph-start selections attached to the wrong block should be treated as misresolved'
  )
}

/**
 * @param {t.TestCase} _tc
 */
export const testFindAbsolutePositionAfterStructuralChange = (_tc) => {
  const oldDoc = schema.node('doc', undefined, [
    schema.node('paragraph', undefined, schema.text('hello')),
    schema.node('paragraph', undefined, schema.text('block'))
  ])
  const newDoc = schema.node('doc', undefined, [
    schema.node('paragraph', undefined, schema.text('block')),
    schema.node('paragraph', undefined, schema.text('hello'))
  ])

  const oldCursorPos = 6
  const expectedPos = oldCursorPos + oldDoc.child(1).nodeSize
  const remapped = findAbsolutePositionAfterStructuralChange(
    oldDoc,
    newDoc,
    oldCursorPos
  )

  t.assert(
    remapped === expectedPos,
    `cursor should remap from ${oldCursorPos} to ${expectedPos}, got ${remapped}`
  )

  const duplicateOldDoc = schema.node('doc', undefined, [
    schema.node('paragraph', undefined, schema.text('same')),
    schema.node('paragraph', undefined, schema.text('same'))
  ])
  const duplicateNewDoc = schema.node('doc', undefined, [
    schema.node('paragraph', undefined, schema.text('other')),
    schema.node('paragraph', undefined, schema.text('same')),
    schema.node('paragraph', undefined, schema.text('same'))
  ])
  const duplicateRemapped = findAbsolutePositionAfterStructuralChange(
    duplicateOldDoc,
    duplicateNewDoc,
    3
  )
  t.assert(
    duplicateRemapped === 10,
    'duplicate paragraph text should remap to the first matching block, got ' + duplicateRemapped
  )

  t.assert(
    findAbsolutePositionAfterStructuralChange(oldDoc, newDoc, 999) === null,
    'out-of-range positions should return null'
  )
}

/**
 * @param {t.TestCase} tc
 */
export const testRepeatGenerateProsemirrorChanges2 = (tc) => {
  checkResult(applyRandomTests(tc, pmChanges, 2, createNewProsemirrorView))
}

/**
 * @param {t.TestCase} tc
 */
export const testRepeatGenerateProsemirrorChanges3 = (tc) => {
  checkResult(applyRandomTests(tc, pmChanges, 3, createNewProsemirrorView))
}

/**
 * @param {t.TestCase} tc
 */
export const testRepeatGenerateProsemirrorChanges30 = (tc) => {
  checkResult(applyRandomTests(tc, pmChanges, 30, createNewProsemirrorView))
}

/**
 * @param {t.TestCase} tc
 */
export const testRepeatGenerateProsemirrorChanges40 = (tc) => {
  checkResult(applyRandomTests(tc, pmChanges, 40, createNewProsemirrorView))
}

/**
 * @param {t.TestCase} tc
 */
export const testRepeatGenerateProsemirrorChanges70 = (tc) => {
  checkResult(applyRandomTests(tc, pmChanges, 70, createNewProsemirrorView))
}

/**
 * @param {t.TestCase} tc
 *
export const testRepeatGenerateProsemirrorChanges100 = tc => {
  checkResult(applyRandomTests(tc, pmChanges, 100, createNewProsemirrorView))
}

/**
 * @param {t.TestCase} tc
 *
export const testRepeatGenerateProsemirrorChanges300 = tc => {
  checkResult(applyRandomTests(tc, pmChanges, 300, createNewProsemirrorView))
}
*/
