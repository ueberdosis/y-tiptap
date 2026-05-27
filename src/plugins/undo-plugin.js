import { Plugin } from 'prosemirror-state' // eslint-disable-line

import { getRelativeSelection } from './sync-plugin.js'
import { UndoManager, Item, ContentType, XmlElement, Text } from 'yjs'
import { yUndoPluginKey, ySyncPluginKey } from './keys.js'

export const undo = state => {
  const undoManager = yUndoPluginKey.getState(state).undoManager
  if (undoManager != null) {
    undoManager.undo()
    return true
  }
}

export const redo = state => {
  const undoManager = yUndoPluginKey.getState(state).undoManager
  if (undoManager != null) {
    undoManager.redo()
    return true
  }
}

export const defaultProtectedNodes = new Set(['paragraph'])

export const defaultDeleteFilter = (item, protectedNodes) => !(item instanceof Item) ||
!(item.content instanceof ContentType) ||
!(item.content.type instanceof Text ||
  (item.content.type instanceof XmlElement && protectedNodes.has(item.content.type.nodeName))) ||
item.content.type._length === 0

export const yUndoPlugin = ({ protectedNodes = defaultProtectedNodes, trackedOrigins = [], undoManager = null } = {}) => new Plugin({
  key: yUndoPluginKey,
  state: {
    init: (initargs, state) => {
      // TODO: check if plugin order matches and fix
      const ystate = ySyncPluginKey.getState(state)
      let _undoManager = undoManager
      if (!_undoManager) {
        // Y.UndoManager registers a `doc.on('destroy', …)` listener in its
        // constructor that UndoManager.destroy() never removes. When the doc
        // outlives the editor (e.g. several editors sharing one provider), that
        // listener keeps the UndoManager — and everything it references —
        // reachable from the doc, leaking memory on every editor destroy.
        // We only own the lifecycle of a manager we create here, so capture the
        // listener(s) it adds and remove them when the plugin view is destroyed.
        const doc = ystate.doc
        const destroyListenersBefore = new Set(doc ? doc._observers.get('destroy') : [])
        _undoManager = new UndoManager(ystate.type, {
          trackedOrigins: new Set([ySyncPluginKey].concat(trackedOrigins)),
          deleteFilter: (item) => defaultDeleteFilter(item, protectedNodes),
          captureTransaction: tr => tr.meta.get('addToHistory') !== false
        })
        const destroyListenersAfter = doc ? doc._observers.get('destroy') : new Set()
        _undoManager._yTiptapDocDestroyListeners = Array.from(destroyListenersAfter || [])
          .filter(listener => !destroyListenersBefore.has(listener))
      }
      return {
        undoManager: _undoManager,
        prevSel: null,
        hasUndoOps: _undoManager.undoStack.length > 0,
        hasRedoOps: _undoManager.redoStack.length > 0
      }
    },
    /**
     * @returns {any}
     */
    apply: (tr, val, oldState, state) => {
      const binding = ySyncPluginKey.getState(state).binding
      const undoManager = val.undoManager
      const hasUndoOps = undoManager.undoStack.length > 0
      const hasRedoOps = undoManager.redoStack.length > 0
      if (binding) {
        return {
          undoManager,
          prevSel: getRelativeSelection(binding, oldState),
          hasUndoOps,
          hasRedoOps
        }
      } else {
        if (hasUndoOps !== val.hasUndoOps || hasRedoOps !== val.hasRedoOps) {
          return Object.assign({}, val, {
            hasUndoOps: undoManager.undoStack.length > 0,
            hasRedoOps: undoManager.redoStack.length > 0
          })
        } else { // nothing changed
          return val
        }
      }
    }
  },
  view: view => {
    const ystate = ySyncPluginKey.getState(view.state)
    const undoManager = yUndoPluginKey.getState(view.state).undoManager
    undoManager.on('stack-item-added', ({ stackItem }) => {
      const binding = ystate.binding
      if (binding) {
        stackItem.meta.set(binding, yUndoPluginKey.getState(view.state).prevSel)
      }
    })
    undoManager.on('stack-item-popped', ({ stackItem }) => {
      const binding = ystate.binding
      if (binding) {
        binding.beforeTransactionSelection = stackItem.meta.get(binding) || binding.beforeTransactionSelection
      }
    })
    return {
      destroy: () => {
        undoManager.destroy()
        // Remove the doc 'destroy' listener Y.UndoManager fails to clean up
        // (only for managers we created — see state.init above).
        const leakedDestroyListeners = undoManager._yTiptapDocDestroyListeners
        if (leakedDestroyListeners && undoManager.doc) {
          leakedDestroyListeners.forEach(listener => undoManager.doc.off('destroy', listener))
          undoManager._yTiptapDocDestroyListeners = null
        }
      }
    }
  }
})
