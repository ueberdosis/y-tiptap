import { updateYFragment, createNodeFromYElement, yattr2markname, createEmptyMeta } from './plugins/sync-plugin.js' // eslint-disable-line
import { ySyncPluginKey } from './plugins/keys.js'
import * as Y from 'yjs'
import { EditorView } from 'prosemirror-view' // eslint-disable-line
import { Node, Schema, Fragment } from 'prosemirror-model' // eslint-disable-line
import * as error from 'lib0/error'
import { ReplaceStep } from 'prosemirror-transform'
import * as map from 'lib0/map'
import * as eventloop from 'lib0/eventloop'

/**
 * Either a node if type is YXmlElement or an Array of text nodes if YXmlText
 * @typedef {Map<Y.AbstractType, Node | Array<Node>>} ProsemirrorMapping
 */

/**
 * Is null if no timeout is in progress.
 * Is defined if a timeout is in progress.
 * Maps from view
 * @type {Map<EditorView, Map<any, any>>|null}
 */
let viewsToUpdate = null

class MetaEntry {
  /**
   * @param {EditorView} view
   * @param {any} key
   * @param {any} value
   */
  constructor (view, key, value) {
    this.view = view
    this.key = key
    this.value = value
  }

  apply () {
    const syncState = ySyncPluginKey.getState(this.view.state)
    if (syncState && syncState.binding && !syncState.binding.isDestroyed) {
      const tr = this.view.state.tr
      tr.setMeta(this.key, this.value)
      this.view.dispatch(tr)
    }
  }
}

class MetaEntriesQueue {
  /**
   * @param {Array<MetaEntry>} [entries=[]]
   */
  constructor (entries = []) {
    this.entries = entries
  }

  /**
   * @return {MetaEntry|undefined}
   */
  getFirst () {
    return this.entries[0]
  }

  /**
   * @return {MetaEntry|undefined}
   */
  dequeueFirst () {
    return this.entries.shift()
  }

  /**
   * @return {boolean}
   */
  isEmpty () {
    return this.entries.length === 0
  }

  static fromViewsToUpdate () {
    const ups = /** @type {Map<EditorView, Map<any, any>>} */ (viewsToUpdate)
    viewsToUpdate = null
    const entries = []
    ups.forEach((metas, view) => {
      metas.forEach((value, key) => {
        entries.push(new MetaEntry(view, key, value))
      })
    })
    return new MetaEntriesQueue(entries)
  }
}

/**
 * Dispatch queued plugin metadata in order, retrying only the remaining
 * entries if a transaction becomes stale while the async queue is flushing.
 *
 * Cursor awareness updates are decoration-only refreshes. If a real document
 * transaction lands before one of these queued meta transactions is applied,
 * ProseMirror can reject it with a RangeError. In that case we reschedule the
 * remaining entries on the next tick. If the first remaining entry fails again
 * on retry, we drop that entry and continue with the rest of the queue instead
 * of retrying forever or crashing the editor.
 *
 * @param {MetaEntriesQueue} [metaEntries=MetaEntriesQueue.fromViewsToUpdate()]
 * @param {boolean} [isRetry=false]
 */
const updateMetas = (metaEntries = MetaEntriesQueue.fromViewsToUpdate(), isRetry = false) => {
  let isFirst = true
  while (!metaEntries.isEmpty()) {
    const metaEntry = metaEntries.getFirst()
    try {
      metaEntry.apply()
    } catch (err) {
      // ProseMirror throws a RangeError when this transaction was created from
      // an older state and another transaction changed the document before this
      // meta-only dispatch was applied ("Applying a mismatched transaction").
      if (err instanceof RangeError) {
        if (isRetry && isFirst) {
          // Drop the repeatedly stale entry so the queue can continue flushing.
          metaEntries.dequeueFirst()
        }
        if (!metaEntries.isEmpty()) {
          eventloop.timeout(0, () => updateMetas(metaEntries, true))
        }
        return
      }
      throw err
    }
    isFirst = false
    metaEntries.dequeueFirst()
  }
}

export const setMeta = (view, key, value) => {
  if (!viewsToUpdate) {
    viewsToUpdate = new Map()
    // Awareness listeners can fire in bursts, so batch them into one tick.
    eventloop.timeout(0, updateMetas)
  }
  map.setIfUndefined(viewsToUpdate, view, map.create).set(key, value)
}

/**
 * Transforms a Prosemirror based absolute position to a Yjs Cursor (relative position in the Yjs model).
 *
 * @param {number} pos
 * @param {Y.XmlFragment} type
 * @param {ProsemirrorMapping} mapping
 * @return {any} relative position
 */
export const absolutePositionToRelativePosition = (pos, type, mapping) => {
  if (pos === 0) {
    return Y.createRelativePositionFromTypeIndex(type, 0, -1)
  }
  /**
   * @type {any}
   */
  let n = type._first === null ? null : /** @type {Y.ContentType} */ (type._first.content).type
  while (n !== null && type !== n) {
    if (n instanceof Y.XmlText) {
      if (n._length >= pos) {
        return Y.createRelativePositionFromTypeIndex(n, pos, -1)
      } else {
        pos -= n._length
      }
      if (n._item !== null && n._item.next !== null) {
        n = /** @type {Y.ContentType} */ (n._item.next.content).type
      } else {
        do {
          n = n._item === null ? null : n._item.parent
          pos--
        } while (n !== type && n !== null && n._item !== null && n._item.next === null)
        if (n !== null && n !== type) {
          // @ts-gnore we know that n.next !== null because of above loop conditition
          n = n._item === null ? null : /** @type {Y.ContentType} */ (/** @type Y.Item */ (n._item.next).content).type
        }
      }
    } else {
      const pNodeSize = /** @type {any} */ (mapping.get(n) || { nodeSize: 0 }).nodeSize
      if (n._first !== null && pos < pNodeSize) {
        n = /** @type {Y.ContentType} */ (n._first.content).type
        pos--
      } else {
        if (pos === 1 && n._length === 0 && pNodeSize > 1) {
          // edge case, should end in this paragraph
          return new Y.RelativePosition(n._item === null ? null : n._item.id, n._item === null ? Y.findRootTypeKey(n) : null, null)
        }
        pos -= pNodeSize
        if (n._item !== null && n._item.next !== null) {
          n = /** @type {Y.ContentType} */ (n._item.next.content).type
        } else {
          if (pos === 0) {
            // set to end of n.parent
            n = n._item === null ? n : n._item.parent
            return new Y.RelativePosition(n._item === null ? null : n._item.id, n._item === null ? Y.findRootTypeKey(n) : null, null)
          }
          do {
            n = /** @type {Y.Item} */ (n._item).parent
            pos--
          } while (n !== type && /** @type {Y.Item} */ (n._item).next === null)
          // if n is null at this point, we have an unexpected case
          if (n !== type) {
            // We know that n._item.next is defined because of above loop condition
            n = /** @type {Y.ContentType} */ (/** @type {Y.Item} */ (/** @type {Y.Item} */ (n._item).next).content).type
          }
        }
      }
    }
    if (n === null) {
      throw error.unexpectedCase()
    }
    if (pos === 0 && n.constructor !== Y.XmlText && n !== type) { // TODO: set to <= 0
      return createRelativePosition(n._item.parent, n._item)
    }
  }
  return Y.createRelativePositionFromTypeIndex(type, type._length, -1)
}

/**
 * Item-id based relative positions can misresolve to the document start after
 * block reorder during collaborative drag-and-drop.
 *
 * @param {Y.Doc} y
 * @param {Y.RelativePosition} relPos
 * @param {number|null} absPos
 * @return {boolean}
 */
export const isMisresolvedTextPosition = (y, relPos, absPos) => {
  if (absPos === null) {
    return false
  }
  const decoded = Y.createAbsolutePositionFromRelativePosition(relPos, y)
  return decoded !== null &&
    decoded.type instanceof Y.XmlText &&
    relPos.item !== null &&
    absPos <= 1
}

const createRelativePosition = (type, item) => {
  let typeid = null
  let tname = null
  if (type._item === null) {
    tname = Y.findRootTypeKey(type)
  } else {
    typeid = Y.createID(type._item.id.client, type._item.id.clock)
  }
  return new Y.RelativePosition(typeid, tname, item.id)
}

/**
 * @param {Y.Doc} y
 * @param {Y.XmlFragment} documentType Top level type that is bound to pView
 * @param {any} relPos Encoded Yjs based relative position
 * @param {ProsemirrorMapping} mapping
 * @return {null|number}
 */
export const relativePositionToAbsolutePosition = (y, documentType, relPos, mapping) => {
  const decodedPos = Y.createAbsolutePositionFromRelativePosition(relPos, y)
  if (decodedPos === null || (decodedPos.type !== documentType && !Y.isParentOf(documentType, decodedPos.type._item))) {
    return null
  }
  let type = decodedPos.type
  let pos = 0
  if (type.constructor === Y.XmlText) {
    pos = decodedPos.index
  } else if (type._item === null || !type._item.deleted) {
    let n = type._first
    let i = 0
    while (i < type._length && i < decodedPos.index && n !== null) {
      if (!n.deleted) {
        const t = /** @type {Y.ContentType} */ (n.content).type
        i++
        if (t instanceof Y.XmlText) {
          pos += t._length
        } else {
          const mapped = mapping.get(t)
          if (mapped == null) {
            return null
          }
          pos += /** @type {any} */ (mapped).nodeSize
        }
      }
      n = /** @type {Y.Item} */ (n.right)
    }
    pos += 1 // increase because we go out of n
  }
  while (type !== documentType && type._item !== null) {
    // @ts-ignore
    const parent = type._item.parent
    // @ts-ignore
    if (parent._item === null || !parent._item.deleted) {
      pos += 1 // the start tag
      let n = /** @type {Y.AbstractType} */ (parent)._first
      // now iterate until we found type
      while (n !== null) {
        const contentType = /** @type {Y.ContentType} */ (n.content).type
        if (contentType === type) {
          break
        }
        if (!n.deleted) {
          if (contentType instanceof Y.XmlText) {
            pos += contentType._length
          } else {
            const mapped = mapping.get(contentType)
            if (mapped == null) {
              return null
            }
            pos += /** @type {any} */ (mapped).nodeSize
          }
        }
        n = n.right
      }
    }
    type = /** @type {Y.AbstractType} */ (parent)
  }
  const absPos = pos - 1 // we don't count the most outer tag, because it is a fragment
  if (isMisresolvedTextPosition(y, relPos, absPos)) {
    return null
  }
  return absPos
}

/**
 * Shallow attrs comparison. Attr values are primitives in most schemas;
 * non-primitive values fail the check and callers fall back to text matching.
 *
 * @param {Object<string, any>} a
 * @param {Object<string, any>} b
 * @return {boolean}
 */
const attrsEqual = (a, b) => {
  if (a === b) {
    return true
  }
  const aKeys = Object.keys(a)
  return aKeys.length === Object.keys(b).length && aKeys.every((k) => a[k] === b[k])
}

/**
 * Returns true when any attr deviates from its spec default or has none.
 * Default-only attrs cannot tell same-type siblings apart.
 *
 * @param {import('prosemirror-model').Node} node
 * @return {boolean}
 */
const hasDistinctiveAttrs = (node) => {
  const specAttrs = node.type.spec.attrs || {}
  return Object.keys(node.attrs).some((key) => {
    const spec = specAttrs[key]
    return spec == null ||
      !Object.prototype.hasOwnProperty.call(spec, 'default') ||
      spec.default !== node.attrs[key]
  })
}

/**
 * Remaps a position into a matched block by walking the same child-index path
 * it had in the old block. A raw byte offset would overshoot into a sibling
 * inner textblock when the old block contains local keystrokes that are not
 * yet part of the rebuilt document.
 *
 * @param {import('prosemirror-model').ResolvedPos} $oldPos
 * @param {number} newBlockStart
 * @param {import('prosemirror-model').Node} newBlock
 * @return {number|null}
 */
const remapIntoBlock = ($oldPos, newBlockStart, newBlock) => {
  let pos = newBlockStart + 1
  let node = newBlock
  for (let depth = 1; depth < $oldPos.depth; depth++) {
    const idx = $oldPos.index(depth)
    if (idx >= node.childCount) {
      return null
    }
    for (let i = 0; i < idx; i++) {
      pos += node.child(i).nodeSize
    }
    pos += 1
    node = node.child(idx)
    if (node.type !== $oldPos.node(depth + 1).type) {
      return null
    }
  }
  if (!node.isTextblock) {
    return null
  }
  return pos + Math.min($oldPos.parentOffset, node.content.size)
}

/**
 * @param {import('prosemirror-model').Node} oldDoc
 * @param {import('prosemirror-model').Node} newDoc
 * @param {number} absPos
 * @return {number|null}
 */
export const findAbsolutePositionAfterStructuralChange = (oldDoc, newDoc, absPos) => {
  let pos = 0
  let targetIdx = 0
  for (; targetIdx < oldDoc.childCount; targetIdx++) {
    const child = oldDoc.child(targetIdx)
    if (pos + child.nodeSize > absPos) {
      break
    }
    pos += child.nodeSize
  }
  if (targetIdx >= oldDoc.childCount) {
    return null
  }
  const targetChild = oldDoc.child(targetIdx)
  const $oldPos = oldDoc.resolve(absPos)

  /**
   * @param {number} newBlockStart
   * @param {import('prosemirror-model').Node} newBlock
   * @return {number|null}
   */
  const place = (newBlockStart, newBlock) => {
    // Positions between top-level blocks carry no inner path; clamp them just
    // inside the matched block like the previous raw-offset remap did.
    if ($oldPos.depth === 0) {
      const remapped = newBlockStart + (absPos - pos)
      const contentStart = newBlockStart + 1
      const contentEnd = newBlockStart + newBlock.nodeSize - 1
      return Math.max(contentStart, Math.min(remapped, contentEnd))
    }
    return remapIntoBlock($oldPos, newBlockStart, newBlock)
  }

  /**
   * Finds the Nth block in newDoc matching `pred`, where N is the number of
   * matching blocks in oldDoc up to and including the target block.
   *
   * @param {function(import('prosemirror-model').Node): boolean} pred
   * @param {boolean} requireUnique
   * @return {number|null}
   */
  const findByPredicate = (pred, requireUnique = false) => {
    let occurrence = 0
    for (let i = 0; i <= targetIdx; i++) {
      if (pred(oldDoc.child(i))) {
        occurrence++
      }
    }
    let matchCount = 0
    let matchStart = -1
    let matchBlock = null
    let newPos = 0
    for (let i = 0; i < newDoc.childCount; i++) {
      const child = newDoc.child(i)
      if (pred(child)) {
        matchCount++
        if (matchCount === occurrence) {
          matchStart = newPos
          matchBlock = child
        }
      }
      newPos += child.nodeSize
    }
    if (matchBlock === null || (requireUnique && (occurrence !== 1 || matchCount !== 1))) {
      return null
    }
    return place(matchStart, matchBlock)
  }

  /**
   * @param {import('prosemirror-model').Node} child
   * @return {boolean}
   */
  const sameTypeAndAttrs = (child) =>
    child.type === targetChild.type && attrsEqual(child.attrs, targetChild.attrs)
  const oldText = targetChild.textContent

  const byAll = findByPredicate((child) => sameTypeAndAttrs(child) && child.textContent === oldText)
  if (byAll !== null) {
    return byAll
  }

  // Text must be matched before attrs: after a remote attr-only edit, the
  // attrs pass would steer the cursor into a sibling that kept the old attrs.
  const byText = findByPredicate(
    (child) => child.type === targetChild.type && child.textContent === oldText
  )
  if (byText !== null) {
    return byText
  }

  // In-flight local typing diverges the text between both docs. Distinctive
  // attrs still identify the block; default-only attrs match every sibling.
  if (hasDistinctiveAttrs(targetChild)) {
    const byAttrs = findByPredicate(sameTypeAndAttrs, true)
    if (byAttrs !== null) {
      return byAttrs
    }
  }

  // Trailing in-flight keystrokes leave a prefix relation between old and new
  // text. Empty text is a prefix of everything and must never match.
  return findByPredicate(
    (child) => sameTypeAndAttrs(child) &&
      oldText !== '' && child.textContent !== '' &&
      (oldText.startsWith(child.textContent) || child.textContent.startsWith(oldText)),
    true
  )
}

/**
 * Returns true when a transaction changes block structure rather than only
 * editing inline content inside existing blocks.
 *
 * @param {import('prosemirror-state').Transaction} tr
 * @param {import('prosemirror-model').Node} oldDoc
 * @return {boolean}
 */
export const isStructuralTransaction = (tr, oldDoc) => {
  if (!tr.docChanged) {
    return false
  }
  if (tr.doc.childCount !== oldDoc.childCount) {
    return true
  }
  for (const step of tr.steps) {
    if (step instanceof ReplaceStep) {
      if (step.from === 0 && step.to === oldDoc.content.size) {
        return true
      }
      if (step.slice.content.size > 0) {
        let hasBlock = false
        step.slice.content.forEach((node) => {
          if (node.isBlock) {
            hasBlock = true
          }
        })
        if (hasBlock) {
          return true
        }
      } else if (step.to > step.from) {
        const $from = oldDoc.resolve(step.from)
        const $to = oldDoc.resolve(step.to)
        if ($from.depth === 0 && $to.depth === 0 && $from.index() !== $to.index()) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Detect stale relative positions after structural changes that resolve to the
 * wrong text block or to the start of the correct block.
 *
 * @param {import('prosemirror-model').Node} oldDoc
 * @param {import('prosemirror-model').Node} newDoc
 * @param {number} oldAbs
 * @param {number|null} resolvedAbs
 * @return {boolean}
 */
export const isMisresolvedAfterStructuralChange = (oldDoc, newDoc, oldAbs, resolvedAbs) => {
  if (resolvedAbs === null) {
    return false
  }
  const $old = oldDoc.resolve(oldAbs)
  const $new = newDoc.resolve(resolvedAbs)
  if (!$old.parent.isTextblock) {
    return false
  }
  // A textblock cursor cannot legitimately resolve into a non-textblock;
  // a structural reorder replaced the block via delete + insert.
  if (!$new.parent.isTextblock) {
    return true
  }
  if ($old.parent.textContent !== $new.parent.textContent) {
    return true
  }
  if ($old.parentOffset !== 0 && $new.parentOffset === 0) {
    return true
  }
  const bothAtStart = $old.parentOffset === 0 && $new.parentOffset === 0
  // A changed offset, type or attrs hints at a same-text sibling. When all
  // of them agree there is no signal left and the Yjs resolution must win.
  const suspicious = $old.parentOffset !== $new.parentOffset ||
    $old.parent.type !== $new.parent.type ||
    !attrsEqual($old.parent.attrs, $new.parent.attrs)
  if (bothAtStart || suspicious) {
    const expected = findAbsolutePositionAfterStructuralChange(oldDoc, newDoc, oldAbs)
    return expected !== null && expected !== resolvedAbs
  }
  return false
}

/**
 * Utility function for converting an Y.Fragment to a ProseMirror fragment.
 *
 * @param {Y.XmlFragment} yXmlFragment
 * @param {Schema} schema
 */
export const yXmlFragmentToProseMirrorFragment = (yXmlFragment, schema) => {
  const fragmentContent = yXmlFragment.toArray().map((t) =>
    createNodeFromYElement(
      /** @type {Y.XmlElement} */ (t),
      schema,
      createEmptyMeta()
    )
  ).filter((n) => n !== null)
  return Fragment.fromArray(fragmentContent)
}

/**
 * Utility function for converting an Y.Fragment to a ProseMirror node.
 *
 * @param {Y.XmlFragment} yXmlFragment
 * @param {Schema} schema
 */
export const yXmlFragmentToProseMirrorRootNode = (yXmlFragment, schema) =>
  schema.topNodeType.create(null, yXmlFragmentToProseMirrorFragment(yXmlFragment, schema))

/**
 * The initial ProseMirror content should be supplied by Yjs. This function transforms a Y.Fragment
 * to a ProseMirror Doc node and creates a mapping that is used by the sync plugin.
 *
 * @param {Y.XmlFragment} yXmlFragment
 * @param {Schema} schema
 *
 * @todo deprecate mapping property
 */
export const initProseMirrorDoc = (yXmlFragment, schema) => {
  const meta = createEmptyMeta()
  const fragmentContent = yXmlFragment.toArray().map((t) =>
    createNodeFromYElement(
      /** @type {Y.XmlElement} */ (t),
      schema,
      meta
    )
  ).filter((n) => n !== null)
  const doc = schema.topNodeType.create(null, Fragment.fromArray(fragmentContent))
  return { doc, meta, mapping: meta.mapping }
}

/**
 * Utility method to convert a Prosemirror Doc Node into a Y.Doc.
 *
 * This can be used when importing existing content to Y.Doc for the first time,
 * note that this should not be used to rehydrate a Y.Doc from a database once
 * collaboration has begun as all history will be lost
 *
 * @param {Node} doc
 * @param {string} xmlFragment
 * @return {Y.Doc}
 */
export function prosemirrorToYDoc (doc, xmlFragment = 'prosemirror') {
  const ydoc = new Y.Doc()
  const type = /** @type {Y.XmlFragment} */ (ydoc.get(xmlFragment, Y.XmlFragment))
  if (!type.doc) {
    return ydoc
  }

  prosemirrorToYXmlFragment(doc, type)
  return type.doc
}

/**
 * Utility method to update an empty Y.XmlFragment with content from a Prosemirror Doc Node.
 *
 * This can be used when importing existing content to Y.Doc for the first time,
 * note that this should not be used to rehydrate a Y.Doc from a database once
 * collaboration has begun as all history will be lost
 *
 * Note: The Y.XmlFragment does not need to be part of a Y.Doc document at the time that this
 * method is called, but it must be added before any other operations are performed on it.
 *
 * @param {Node} doc prosemirror document.
 * @param {Y.XmlFragment} [xmlFragment] If supplied, an xml fragment to be
 *   populated from the prosemirror state; otherwise a new XmlFragment will be created.
 * @return {Y.XmlFragment}
 */
export function prosemirrorToYXmlFragment (doc, xmlFragment) {
  const type = xmlFragment || new Y.XmlFragment()
  const ydoc = type.doc ? type.doc : { transact: (transaction) => transaction(undefined) }
  updateYFragment(ydoc, type, doc, { mapping: new Map(), isOMark: new Map() })
  return type
}

/**
 * Utility method to convert Prosemirror compatible JSON into a Y.Doc.
 *
 * This can be used when importing existing content to Y.Doc for the first time,
 * note that this should not be used to rehydrate a Y.Doc from a database once
 * collaboration has begun as all history will be lost
 *
 * @param {Schema} schema
 * @param {any} state
 * @param {string} xmlFragment
 * @return {Y.Doc}
 */
export function prosemirrorJSONToYDoc (schema, state, xmlFragment = 'prosemirror') {
  const doc = Node.fromJSON(schema, state)
  return prosemirrorToYDoc(doc, xmlFragment)
}

/**
 * Utility method to convert Prosemirror compatible JSON to a Y.XmlFragment
 *
 * This can be used when importing existing content to Y.Doc for the first time,
 * note that this should not be used to rehydrate a Y.Doc from a database once
 * collaboration has begun as all history will be lost
 *
 * @param {Schema} schema
 * @param {any} state
 * @param {Y.XmlFragment} [xmlFragment] If supplied, an xml fragment to be
 *   populated from the prosemirror state; otherwise a new XmlFragment will be created.
 * @return {Y.XmlFragment}
 */
export function prosemirrorJSONToYXmlFragment (schema, state, xmlFragment) {
  const doc = Node.fromJSON(schema, state)
  return prosemirrorToYXmlFragment(doc, xmlFragment)
}

/**
 * @deprecated Use `yXmlFragmentToProseMirrorRootNode` instead
 *
 * Utility method to convert a Y.Doc to a Prosemirror Doc node.
 *
 * @param {Schema} schema
 * @param {Y.Doc} ydoc
 * @return {Node}
 */
export function yDocToProsemirror (schema, ydoc) {
  const state = yDocToProsemirrorJSON(ydoc)
  return Node.fromJSON(schema, state)
}

/**
 *
 * @deprecated Use `yXmlFragmentToProseMirrorRootNode` instead
 *
 * Utility method to convert a Y.XmlFragment to a Prosemirror Doc node.
 *
 * @param {Schema} schema
 * @param {Y.XmlFragment} xmlFragment
 * @return {Node}
 */
export function yXmlFragmentToProsemirror (schema, xmlFragment) {
  const state = yXmlFragmentToProsemirrorJSON(xmlFragment)
  return Node.fromJSON(schema, state)
}

/**
 *
 * @deprecated Use `yXmlFragmentToProseMirrorRootNode` instead
 *
 * Utility method to convert a Y.Doc to Prosemirror compatible JSON.
 *
 * @param {Y.Doc} ydoc
 * @param {string} xmlFragment
 * @return {Record<string, any>}
 */
export function yDocToProsemirrorJSON (
  ydoc,
  xmlFragment = 'prosemirror'
) {
  return yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(xmlFragment))
}

/**
 * @deprecated Use `yXmlFragmentToProseMirrorRootNode` instead
 *
 * Utility method to convert a Y.Doc to Prosemirror compatible JSON.
 *
 * @param {Y.XmlFragment} xmlFragment The fragment, which must be part of a Y.Doc.
 * @return {Record<string, any>}
 */
export function yXmlFragmentToProsemirrorJSON (xmlFragment) {
  const items = xmlFragment.toArray()

  /**
   * @param {Y.AbstractType} item
   */
  const serialize = item => {
    /**
     * @type {Object} NodeObject
     * @property {string} NodeObject.type
     * @property {Record<string, string>=} NodeObject.attrs
     * @property {Array<NodeObject>=} NodeObject.content
     */
    let response

    // TODO: Must be a better way to detect text nodes than this
    if (item instanceof Y.XmlText) {
      const delta = item.toDelta()
      response = delta.map(/** @param {any} d */ (d) => {
        const text = {
          type: 'text',
          text: d.insert
        }
        if (d.attributes) {
          text.marks = Object.keys(d.attributes).map((type_) => {
            const attrs = d.attributes[type_]
            const type = yattr2markname(type_)
            const mark = {
              type
            }
            if (Object.keys(attrs).length) {
              mark.attrs = attrs
            }
            return mark
          })
        }
        return text
      })
    } else if (item instanceof Y.XmlElement) {
      response = {
        type: item.nodeName
      }

      const attrs = item.getAttributes()
      if (Object.keys(attrs).length) {
        response.attrs = attrs
      }

      const children = item.toArray()
      if (children.length) {
        response.content = children.map(serialize).flat()
      }
    } else {
      // expected either Y.XmlElement or Y.XmlText
      error.unexpectedCase()
    }

    return response
  }

  return {
    type: 'doc',
    content: items.map(serialize)
  }
}
