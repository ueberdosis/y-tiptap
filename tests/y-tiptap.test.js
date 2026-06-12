import * as t from 'lib0/testing'
import * as prng from 'lib0/prng'
import * as math from 'lib0/math'
import * as Y from 'yjs'
// @ts-ignore
import { applyRandomTests } from 'yjs/testHelper'

import {
  createDecorations,
  prosemirrorJSONToYDoc,
  prosemirrorJSONToYXmlFragment,
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

// --- Tests for marks on inline atom nodes (TT-634) ---

const schemaWithInlineAtomMarks = new Schema({
  nodes: Object.assign({}, basicSchema.nodes, {
    inlineatom: {
      inline: true,
      group: 'inline',
      atom: true,
      marks: '_',
      parseDOM: [{ tag: 'inline-atom' }],
      toDOM () {
        return ['inline-atom']
      }
    },
    // An inline atom that carries its own attribute, used to prove that node
    // attributes and node marks round-trip independently without colliding.
    labeledatom: {
      inline: true,
      group: 'inline',
      atom: true,
      marks: '_',
      attrs: { label: { default: null } },
      parseDOM: [{ tag: 'labeled-atom' }],
      toDOM (node) {
        return ['labeled-atom', { label: node.attrs.label }]
      }
    }
  }),
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
 * @param {t.TestCase} _tc
 */
export const testMarksOnInlineAtomRoundTrip = (_tc) => {
  const view = new EditorView(null, {
    state: EditorState.create({
      schema: schemaWithInlineAtomMarks,
      plugins: []
    })
  })

  view.dispatch(
    view.state.tr.insert(
      0,
      schemaWithInlineAtomMarks.node('paragraph', undefined, [
        schemaWithInlineAtomMarks.node('inlineatom', undefined, undefined, [
          schemaWithInlineAtomMarks.mark('strong')
        ])
      ])
    )
  )

  const stateJSON = JSON.parse(JSON.stringify(view.state.doc.toJSON()))
  const ydoc = prosemirrorJSONToYDoc(/** @type {any} */ (schemaWithInlineAtomMarks), stateJSON)
  const backandforth = yDocToProsemirrorJSON(ydoc)
  t.compare(stateJSON, backandforth)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMarksOnInlineAtomOverlapping = (_tc) => {
  const view = new EditorView(null, {
    state: EditorState.create({
      schema: schemaWithInlineAtomMarks,
      plugins: []
    })
  })

  view.dispatch(
    view.state.tr.insert(
      0,
      schemaWithInlineAtomMarks.node('paragraph', undefined, [
        schemaWithInlineAtomMarks.node('inlineatom', undefined, undefined, [
          schemaWithInlineAtomMarks.mark('comment', { id: 1 }),
          schemaWithInlineAtomMarks.mark('comment', { id: 2 })
        ])
      ])
    )
  )

  const stateJSON = JSON.parse(JSON.stringify(view.state.doc.toJSON()))
  const ydoc = prosemirrorJSONToYDoc(/** @type {any} */ (schemaWithInlineAtomMarks), stateJSON)
  const backandforth = yDocToProsemirrorJSON(ydoc)
  t.compare(stateJSON, backandforth)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMarksOnInlineAtomMultipleMarks = (_tc) => {
  const view = new EditorView(null, {
    state: EditorState.create({
      schema: schemaWithInlineAtomMarks,
      plugins: []
    })
  })

  view.dispatch(
    view.state.tr.insert(
      0,
      schemaWithInlineAtomMarks.node('paragraph', undefined, [
        schemaWithInlineAtomMarks.node('inlineatom', undefined, undefined, [
          schemaWithInlineAtomMarks.mark('strong'),
          schemaWithInlineAtomMarks.mark('em')
        ])
      ])
    )
  )

  const stateJSON = JSON.parse(JSON.stringify(view.state.doc.toJSON()))
  const ydoc = prosemirrorJSONToYDoc(/** @type {any} */ (schemaWithInlineAtomMarks), stateJSON)
  const backandforth = yDocToProsemirrorJSON(ydoc)
  t.compare(stateJSON, backandforth)
}

/**
 * @param {t.TestCase} _tc
 */
export const testMarksOnInlineAtomSync = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2

  const view1 = createNewProsemirrorViewWithSchema(ydoc1, schemaWithInlineAtomMarks)
  const view2 = createNewProsemirrorViewWithSchema(ydoc2, schemaWithInlineAtomMarks)

  // Insert inline atom with bold mark on peer 1
  view1.dispatch(
    view1.state.tr.insert(
      0,
      schemaWithInlineAtomMarks.node('paragraph', undefined, [
        schemaWithInlineAtomMarks.node('inlineatom', undefined, undefined, [
          schemaWithInlineAtomMarks.mark('strong')
        ])
      ])
    )
  )

  // Sync to peer 2
  Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1))
  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  // Verify peer 2 has the mark
  const para = view2.state.doc.child(0)
  let pos = 1
  for (let i = 0; i < para.childCount; i++) {
    const child = para.child(i)
    if (child.type.name === 'inlineatom') break
    pos += child.nodeSize
  }
  const node = view2.state.doc.nodeAt(pos)
  t.assert(node !== null, 'inline atom node exists')
  t.assert(
    node.marks.some(m => m.type.name === 'strong'),
    'peer 2 should have strong mark on inline atom'
  )
}

/**
 * @param {t.TestCase} _tc
 */
export const testMarksOnInlineAtomRemoval = (_tc) => {
  const ydoc = new Y.Doc()
  const view = createNewProsemirrorViewWithSchema(ydoc, schemaWithInlineAtomMarks)

  // Insert inline atom with bold mark
  view.dispatch(
    view.state.tr.insert(
      0,
      schemaWithInlineAtomMarks.node('paragraph', undefined, [
        schemaWithInlineAtomMarks.node('inlineatom', undefined, undefined, [
          schemaWithInlineAtomMarks.mark('strong')
        ])
      ])
    )
  )

  // Verify Yjs has the mark
  const yxml = ydoc.get('prosemirror')
  const inlineAtomY = yxml.get(0).get(0)
  t.assert(inlineAtomY.getAttributes().__mark_strong !== undefined, 'Yjs should have __mark_strong attr')

  // Remove the mark
  const $pos = view.state.doc.resolve(1)
  const node = $pos.nodeAfter
  const newNode = node.type.create(
    node.attrs,
    node.content,
    node.marks.filter(m => m.type.name !== 'strong')
  )
  view.dispatch(view.state.tr.replaceWith(1, 1 + node.nodeSize, newNode))

  // Verify Yjs no longer has __mark_strong
  const attrs = inlineAtomY.getAttributes()
  t.assert(attrs.__mark_strong === undefined, 'Yjs should not have __mark_strong after removal')
}

/**
 * @param {t.TestCase} _tc
 */
export const testMarksOnInlineAtomNoMarks = (_tc) => {
  const view = new EditorView(null, {
    state: EditorState.create({
      schema: schemaWithInlineAtomMarks,
      plugins: []
    })
  })

  view.dispatch(
    view.state.tr.insert(
      0,
      schemaWithInlineAtomMarks.node('paragraph', undefined, [
        schemaWithInlineAtomMarks.node('inlineatom')
      ])
    )
  )

  const stateJSON = JSON.parse(JSON.stringify(view.state.doc.toJSON()))
  const ydoc = prosemirrorJSONToYDoc(/** @type {any} */ (schemaWithInlineAtomMarks), stateJSON)
  const backandforth = yDocToProsemirrorJSON(ydoc)
  t.compare(stateJSON, backandforth)

  // Verify no __mark_ attrs in Yjs
  const yxml = ydoc.get('prosemirror')
  const inlineAtomY = yxml.get(0).get(0)
  const attrs = inlineAtomY.getAttributes()
  const hasMarkAttrs = Object.keys(attrs).some(k => k.startsWith('__mark_'))
  t.assert(!hasMarkAttrs, 'no __mark_ attrs should be present when node has no marks')
}

/**
 * Marks on an unrelated, untouched node must survive when a different part of
 * the document is edited. Guards against incremental diffing dropping or
 * recreating marked nodes during everyday editing.
 *
 * @param {t.TestCase} _tc
 */
export const testMarksOnInlineAtomPreservedAcrossUnrelatedEdit = (_tc) => {
  const ydoc = new Y.Doc()
  const view = createNewProsemirrorViewWithSchema(ydoc, schemaWithInlineAtomMarks)

  // First paragraph holds the marked inline atom, second holds plain text.
  view.dispatch(
    view.state.tr.insert(
      0,
      [
        schemaWithInlineAtomMarks.node('paragraph', undefined, [
          schemaWithInlineAtomMarks.node('inlineatom', undefined, undefined, [
            schemaWithInlineAtomMarks.mark('strong')
          ])
        ]),
        schemaWithInlineAtomMarks.node('paragraph', undefined, [
          schemaWithInlineAtomMarks.text('world')
        ])
      ]
    )
  )

  const yxml = ydoc.get('prosemirror')
  t.assert(
    yxml.get(0).get(0).getAttributes().__mark_strong !== undefined,
    'Yjs should have __mark_strong attr before the edit'
  )

  // Edit only the second paragraph — append "!" to "world".
  view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size - 1))

  t.assert(
    yxml.get(0).get(0).getAttributes().__mark_strong !== undefined,
    'Yjs should still have __mark_strong attr after the unrelated edit'
  )
  const node = view.state.doc.child(0).child(0)
  t.assert(
    node.type.name === 'inlineatom' && node.marks.some(m => m.type.name === 'strong'),
    'inline atom should still carry the strong mark after the unrelated edit'
  )
}

/**
 * The mark's *attribute values* — not just its presence — must round-trip
 * through the real collaboration binding (createNodeFromYElement), not only the
 * JSON conversion helpers.
 *
 * @param {t.TestCase} _tc
 */
export const testMarkWithAttrsThroughSync = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2

  const view1 = createNewProsemirrorViewWithSchema(ydoc1, schemaWithInlineAtomMarks)
  const view2 = createNewProsemirrorViewWithSchema(ydoc2, schemaWithInlineAtomMarks)

  view1.dispatch(
    view1.state.tr.insert(
      0,
      schemaWithInlineAtomMarks.node('paragraph', undefined, [
        schemaWithInlineAtomMarks.node('inlineatom', undefined, undefined, [
          schemaWithInlineAtomMarks.mark('comment', { id: 42 })
        ])
      ])
    )
  )

  Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1))
  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  const node = view2.state.doc.child(0).child(0)
  t.assert(node.type.name === 'inlineatom', 'peer 2 has the inline atom')
  const comment = node.marks.find(m => m.type.name === 'comment')
  t.assert(comment !== undefined, 'peer 2 has the comment mark')
  t.assert(comment.attrs.id === 42, 'peer 2 preserves the comment mark attrs')
}

/**
 * Overlapping marks (those that do not exclude themselves) must each survive a
 * round trip through the binding with their distinct attribute values, using
 * the hashed `__mark_name--HASH` attribute keys.
 *
 * @param {t.TestCase} _tc
 */
export const testOverlappingMarksThroughSync = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2

  const view1 = createNewProsemirrorViewWithSchema(ydoc1, schemaWithInlineAtomMarks)
  const view2 = createNewProsemirrorViewWithSchema(ydoc2, schemaWithInlineAtomMarks)

  view1.dispatch(
    view1.state.tr.insert(
      0,
      schemaWithInlineAtomMarks.node('paragraph', undefined, [
        schemaWithInlineAtomMarks.node('inlineatom', undefined, undefined, [
          schemaWithInlineAtomMarks.mark('comment', { id: 1 }),
          schemaWithInlineAtomMarks.mark('comment', { id: 2 })
        ])
      ])
    )
  )

  // Two distinct hashed mark attributes should be stored on peer 1.
  const markKeys1 = Object.keys(ydoc1.get('prosemirror').get(0).get(0).getAttributes())
    .filter(k => k.startsWith('__mark_'))
  t.assert(markKeys1.length === 2, 'two distinct hashed mark attrs are stored')

  Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1))
  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  const node = view2.state.doc.child(0).child(0)
  const ids = node.marks.filter(m => m.type.name === 'comment').map(m => m.attrs.id).sort()
  t.compare(ids, [1, 2])
}

/**
 * Changing a mark's attributes on an existing node must update the Yjs document
 * in place: the stale hashed attribute is removed and the new one added, with no
 * orphaned `__mark_` attributes left behind. Exercises the mark add/remove loops
 * in `updateYFragment` and the mark-aware equality check in `equalYTypePNode`.
 *
 * @param {t.TestCase} _tc
 */
export const testMarkAttrChangePropagates = (_tc) => {
  const ydoc = new Y.Doc()
  const view = createNewProsemirrorViewWithSchema(ydoc, schemaWithInlineAtomMarks)

  view.dispatch(
    view.state.tr.insert(
      0,
      schemaWithInlineAtomMarks.node('paragraph', undefined, [
        schemaWithInlineAtomMarks.node('inlineatom', undefined, undefined, [
          schemaWithInlineAtomMarks.mark('comment', { id: 1 })
        ])
      ])
    )
  )

  const yxml = ydoc.get('prosemirror')
  const keyBefore = Object.keys(yxml.get(0).get(0).getAttributes())
    .find(k => k.startsWith('__mark_comment'))
  t.assert(keyBefore !== undefined, 'a hashed comment mark attr exists before the change')

  // Replace the inline atom, swapping the comment id from 1 to 2.
  const node = view.state.doc.nodeAt(1)
  const newNode = node.type.create(
    node.attrs,
    node.content,
    [schemaWithInlineAtomMarks.mark('comment', { id: 2 })]
  )
  view.dispatch(view.state.tr.replaceWith(1, 1 + node.nodeSize, newNode))

  const attrsAfter = yxml.get(0).get(0).getAttributes()
  const markKeysAfter = Object.keys(attrsAfter).filter(k => k.startsWith('__mark_'))
  t.assert(markKeysAfter.length === 1, 'exactly one mark attr remains after the change')
  t.assert(attrsAfter[keyBefore] === undefined, 'the stale hashed mark attr was removed')
  t.assert(markKeysAfter[0] !== keyBefore, 'the remaining mark attr is the new (rehashed) one')

  // The change survives a full round trip back to ProseMirror.
  const roundTripped = yDocToProsemirrorJSON(ydoc)
  const recoveredMarks = roundTripped.content[0].content[0].marks
  t.compare(recoveredMarks, [{ type: 'comment', attrs: { id: 2 } }])
}

/**
 * Node attributes and node marks must round-trip independently: a plain
 * attribute is stored unprefixed, the mark is stored under `__mark_`, and
 * neither leaks into the other on the way back to ProseMirror.
 *
 * @param {t.TestCase} _tc
 */
export const testMarkAndAttrCoexist = (_tc) => {
  const view = new EditorView(null, {
    state: EditorState.create({
      schema: schemaWithInlineAtomMarks,
      plugins: []
    })
  })

  view.dispatch(
    view.state.tr.insert(
      0,
      schemaWithInlineAtomMarks.node('paragraph', undefined, [
        schemaWithInlineAtomMarks.node('labeledatom', { label: 'hello' }, undefined, [
          schemaWithInlineAtomMarks.mark('strong')
        ])
      ])
    )
  )

  const stateJSON = JSON.parse(JSON.stringify(view.state.doc.toJSON()))
  const ydoc = prosemirrorJSONToYDoc(/** @type {any} */ (schemaWithInlineAtomMarks), stateJSON)

  // In Yjs the attribute is plain; the mark is prefixed; neither contaminates the other.
  const attrs = ydoc.get('prosemirror').get(0).get(0).getAttributes()
  t.assert(attrs.label === 'hello', 'plain attribute is stored unprefixed')
  t.assert(attrs.__mark_strong !== undefined, 'mark is stored under the __mark_ prefix')
  t.assert(attrs.__mark_label === undefined, 'the plain attribute was not stored as a mark')
  t.assert(attrs.strong === undefined, 'the mark was not stored as a plain attribute')

  // The full structure round-trips back to ProseMirror unchanged.
  const backandforth = yDocToProsemirrorJSON(ydoc)
  t.compare(stateJSON, backandforth)
  const recovered = backandforth.content[0].content[0]
  t.assert(recovered.attrs.label === 'hello', 'recovered node keeps its attribute')
  t.compare(recovered.marks, [{ type: 'strong' }])
}

/**
 * Removing a mark on one peer must propagate the removal to the other peer,
 * clearing the `__mark_` attribute everywhere — not just locally.
 *
 * @param {t.TestCase} _tc
 */
export const testMarkRemovalPropagatesAcrossSync = (_tc) => {
  const ydoc1 = new Y.Doc()
  ydoc1.clientID = 1
  const ydoc2 = new Y.Doc()
  ydoc2.clientID = 2

  const view1 = createNewProsemirrorViewWithSchema(ydoc1, schemaWithInlineAtomMarks)
  const view2 = createNewProsemirrorViewWithSchema(ydoc2, schemaWithInlineAtomMarks)

  view1.dispatch(
    view1.state.tr.insert(
      0,
      schemaWithInlineAtomMarks.node('paragraph', undefined, [
        schemaWithInlineAtomMarks.node('inlineatom', undefined, undefined, [
          schemaWithInlineAtomMarks.mark('strong')
        ])
      ])
    )
  )

  Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1))
  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))
  t.assert(
    view2.state.doc.child(0).child(0).marks.some(m => m.type.name === 'strong'),
    'peer 2 receives the mark initially'
  )

  // Remove the mark on peer 1.
  const node = view1.state.doc.nodeAt(1)
  const newNode = node.type.create(node.attrs, node.content, [])
  view1.dispatch(view1.state.tr.replaceWith(1, 1 + node.nodeSize, newNode))

  Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1))
  Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2))

  t.assert(
    !view2.state.doc.child(0).child(0).marks.some(m => m.type.name === 'strong'),
    'peer 2 no longer has the mark after removal'
  )
  const attrs = ydoc2.get('prosemirror').get(0).get(0).getAttributes()
  t.assert(attrs.__mark_strong === undefined, 'peer 2 Yjs no longer has the __mark_strong attr')
}
