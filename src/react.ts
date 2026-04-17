import {
  useCallback,
  useDebugValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import { affectedToPathList } from 'proxy-compare'
import {
  allKeysSymbol,
  getProxyBySnapshot,
  snapshot,
  subscribe,
  subscribeKey,
} from './vanilla'
import type { Snapshot } from './vanilla'

/**
 * React hook to display affected paths in React DevTools for debugging
 *
 * This internal hook collects the paths that were accessed during render
 * and displays them in React DevTools to help with debugging render optimizations.
 *
 * @param {object} state - The state object being tracked
 * @param {WeakMap<object, unknown>} affected - WeakMap of accessed properties
 * @private
 */
const useAffectedDebugValue = (
  state: object,
  affected: WeakMap<object, unknown>,
) => {
  const pathList = useRef<(string | number | symbol)[][]>(undefined)
  useEffect(() => {
    pathList.current = affectedToPathList(state, affected, true)
  })
  useDebugValue(pathList.current)
}
const condUseAffectedDebugValue = useAffectedDebugValue

type Options = {
  sync?: boolean
  initEntireSubscribe?: boolean
}

// function to create a new bare proxy
const newProxy = <T extends object>(target: T, handler: ProxyHandler<T>) =>
  new Proxy(target, handler)

// get object prototype
const getProto = Object.getPrototypeOf

const objectsToTrack = new WeakMap<object, boolean>()
export const markToTrack = (obj: object, mark = true): void => {
  objectsToTrack.set(obj, mark)
}

// check if obj is a plain object or an array
const isObjectToTrack = <T>(obj: T): obj is T extends object ? T : never =>
  obj &&
  (objectsToTrack.has(obj as unknown as object)
    ? (objectsToTrack.get(obj as unknown as object) as boolean)
    : getProto(obj) === Object.prototype || getProto(obj) === Array.prototype)

const getPropertyDescriptor = (obj: object, key: string | symbol) => {
  while (obj) {
    const desc = Reflect.getOwnPropertyDescriptor(obj, key)
    if (desc) {
      return desc
    }
    obj = getProto(obj)
  }
  return undefined
}

const noop = () => {}

const HAS_KEY_PROPERTY = 'h'
const ALL_OWN_KEYS_PROPERTY = 'w'
const HAS_OWN_KEY_PROPERTY = 'o'
const KEYS_PROPERTY = 'k'
const NO_ACCESS_PROPERTY = 'n'

type Unsubscribe = () => void

type UsedKeyMap = Map<string | symbol, Unsubscribe>
type HasKeyMap = UsedKeyMap
type HasOwnKeyMap = UsedKeyMap
type KeysMap = UsedKeyMap
type Used = {
  [HAS_KEY_PROPERTY]?: HasKeyMap
  [ALL_OWN_KEYS_PROPERTY]?: Unsubscribe
  [HAS_OWN_KEY_PROPERTY]?: HasOwnKeyMap
  [KEYS_PROPERTY]?: KeysMap
  [NO_ACCESS_PROPERTY]?: Unsubscribe
}
// Use WeakMap to prevent memory leaks - proxy objects can be garbage collected
// even if the observer is still alive
type Affected = WeakMap<object, Used>

const recordUsage = (
  proxyObject: object,
  observer: SnapshotObserver,
  type:
    | typeof HAS_KEY_PROPERTY
    | typeof ALL_OWN_KEYS_PROPERTY
    | typeof HAS_OWN_KEY_PROPERTY
    | typeof KEYS_PROPERTY
    | typeof NO_ACCESS_PROPERTY,
  key?: string | symbol,
) => {
  const affected = observer.affected
  let used = affected.get(proxyObject as object)
  if (!used) {
    used = {}
    affected.set(proxyObject as object, used)
    // Store WeakRef to allow iteration over affected keys without preventing GC
    const weakRef = new WeakRef(proxyObject)
    observer.affectedKeys.add(weakRef)
    observer.proxyToWeakRef.set(proxyObject, weakRef)
  }

  if (type === NO_ACCESS_PROPERTY) {
    used[NO_ACCESS_PROPERTY] ??= observer.observe(proxyObject)
    return
  } else {
    used[NO_ACCESS_PROPERTY]?.()
    delete used[NO_ACCESS_PROPERTY]
  }

  if (type === ALL_OWN_KEYS_PROPERTY) {
    used[ALL_OWN_KEYS_PROPERTY] ??= observer.observe(proxyObject, allKeysSymbol)
  } else if (!used[ALL_OWN_KEYS_PROPERTY]) {
    // no need to record other if all keys are observed
    let map = used[type]
    if (!map) {
      map = new Map()
      used[type] = map
    }
    if (!map.has(key!)) {
      const unsub = observer.observe(proxyObject as any, key!)
      map.set(key!, unsub)
    }
  }
}

const createSnapshotProxy = <T>(
  snapshot: Snapshot<T>,
  observer: SnapshotObserver,
): Snapshot<T> => {
  if (!isObjectToTrack(snapshot)) return snapshot

  const { proxyCache, initEntireSubscribe } = observer
  if (proxyCache.get(snapshot)) return proxyCache.get(snapshot)!

  const proxyTarget = getProxyBySnapshot(snapshot)
  const proxyObjectRef = proxyTarget ? new WeakRef(proxyTarget) : null
  const proxySnapshot = newProxy(snapshot, {
    get(target, prop) {
      const desc = getPropertyDescriptor(target, prop)
      if (desc?.get) {
        return Reflect.get(target, prop, proxySnapshot)
      }

      const proxyObject = proxyObjectRef?.deref()
      if (!proxyObject) {
        return createSnapshotProxy(
          Reflect.get(target, prop) as Snapshot<T>,
          observer,
        )
      }
      recordUsage(proxyObject, observer, KEYS_PROPERTY, prop)
      const childSnap = Reflect.get(target, prop) as Snapshot<T>
      if (isObjectToTrack(childSnap)) {
        const childProxy = getProxyBySnapshot(childSnap)
        if (childProxy) {
          let children = observer.childProxies.get(proxyObject)
          if (!children) {
            children = new Map()
            observer.childProxies.set(proxyObject, children)
          }
          const oldChildRef = children.get(prop)
          const oldChild = oldChildRef?.deref()
          if (oldChild !== childProxy) {
            if (oldChild) {
              // Decrement refcount for the child being replaced
              const oldCount = (observer.childRefCount.get(oldChild) ?? 1) - 1
              if (oldCount <= 0) observer.childRefCount.delete(oldChild)
              else observer.childRefCount.set(oldChild, oldCount)
            }
            children.set(prop, new WeakRef(childProxy))
            observer.childRefCount.set(
              childProxy,
              (observer.childRefCount.get(childProxy) ?? 0) + 1,
            )
          }
        }
      }
      return createSnapshotProxy(childSnap, observer)
    },
    has(target, key) {
      const proxyObject = proxyObjectRef?.deref()
      if (proxyObject) {
        recordUsage(proxyObject, observer, HAS_KEY_PROPERTY, key)
      }
      return Reflect.has(target, key)
    },
    getOwnPropertyDescriptor(target, key) {
      const proxyObject = proxyObjectRef?.deref()
      if (proxyObject) {
        recordUsage(proxyObject, observer, HAS_OWN_KEY_PROPERTY, key)
      }
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
    ownKeys(target) {
      const proxyObject = proxyObjectRef?.deref()
      if (proxyObject) {
        recordUsage(proxyObject, observer, ALL_OWN_KEYS_PROPERTY)
      }
      return Reflect.ownKeys(target)
    },
  })
  proxyCache.set(snapshot, proxySnapshot)

  if (initEntireSubscribe) {
    const proxyObject = proxyObjectRef?.deref()
    if (proxyObject) {
      recordUsage(proxyObject, observer, NO_ACCESS_PROPERTY)
    }
  }
  return proxySnapshot
}

/**
 * useSnapshot
 *
 * Create a local snapshot that catches changes. This hook actually returns a wrapped snapshot in a proxy for
 * render optimization instead of a plain object compared to `snapshot()` method.
 * Rule of thumb: read from snapshots, mutate the source.
 * The component will only re-render when the parts of the state you access have changed, it is render-optimized.
 *
 * @example A
 * function Counter() {
 *   const snap = useSnapshot(state)
 *   return (
 *     <div>
 *       {snap.count}
 *       <button onClick={() => ++state.count}>+1</button>
 *     </div>
 *   )
 * }
 *
 * [Notes]
 * Every object inside your proxy also becomes a proxy (if you don't use "ref"), so you can also use them to create
 * the local snapshot as seen on example B.
 *
 * @example B
 * function ProfileName() {
 *   const snap = useSnapshot(state.profile)
 *   return (
 *     <div>
 *       {snap.name}
 *     </div>
 *   )
 * }
 *
 * When you replace a child proxy (e.g. `state.profile = { name: "new name" }`), the observer automatically
 * prunes subscriptions to the old child and picks up the new one. You don't need to worry about stale
 * references — the component will re-render correctly with the new child's data.
 *
 * All examples below are render-optimized.
 *
 * @example C
 * const snap = useSnapshot(state)
 * return (
 *   <div>
 *     {snap.profile.name}
 *   </div>
 * )
 *
 * @example D
 * const { profile } = useSnapshot(state)
 * return (
 *   <div>
 *     {profile.name}
 *   </div>
 * )
 */
export function useSnapshot<T extends object>(
  proxyObject: T,
  options?: Options & {
    testOnlyObserver?: SnapshotObserver
  },
): Snapshot<T> {
  // per-hook observer, it's not ideal but memo compatible
  const observer = useMemo(
    () => options?.testOnlyObserver ?? new SnapshotObserver(options),
    // eslint-disable-next-line react-hooks/react-compiler
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const lastSnapshot = useRef<Snapshot<T>>(undefined)
  const currSnapshot = useSyncExternalStore(
    useCallback((callback) => observer.subscribe(callback), [observer]),
    () => observer.getSnapshot(proxyObject),
    () => observer.getSnapshot(proxyObject),
  )

  useLayoutEffect(() => {
    observer.enable()
    return () => {
      observer.disable()
    }
  }, [observer, currSnapshot])

  // StrictMode-safe unmount clear: use microtask to distinguish
  // simulated unmount (StrictMode) from real unmount
  const mountedRef = useRef(false)
  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      queueMicrotask(() => {
        if (!mountedRef.current) {
          observer.clear()
        }
      })
    }
  }, [observer])

  if (lastSnapshot.current !== currSnapshot) {
    if (observer.initEntireSubscribe) {
      recordUsage(proxyObject, observer, NO_ACCESS_PROPERTY)
    }
    lastSnapshot.current = currSnapshot
  }
  if (import.meta.env?.MODE !== 'production') {
    condUseAffectedDebugValue(proxyObject, observer.affected)
  }
  return currSnapshot
}

/**
 * SnapshotObserver
 *
 * A class that gets snapshots of a proxy object and auto observes changes.
 * Notify subscribers only when the snapshots accessed properties change.
 * Just like useSnapshot, but can use outside of React components.
 */
export class SnapshotObserver {
  static counter = 0
  uid: number = SnapshotObserver.counter++
  // WeakMap allows proxy objects to be garbage collected when no longer referenced elsewhere
  affected: Affected = new WeakMap()
  // WeakRef set enables iteration over affected keys without preventing GC
  // (WeakMap doesn't support iteration, so we need this auxiliary structure)
  affectedKeys: Set<WeakRef<object>> = new Set()
  // Reverse map: proxy object → its WeakRef in affectedKeys, for O(1) removal during prune
  proxyToWeakRef: WeakMap<object, WeakRef<object>> = new WeakMap()
  // Track parent→child proxy edges for auto-pruning when child proxy is replaced
  childProxies: WeakMap<object, Map<string | symbol, WeakRef<object>>> =
    new WeakMap()
  // Reference count for each child proxy across all childProxies entries.
  // A child is only pruned when its count drops to zero (no parent references it).
  childRefCount: WeakMap<object, number> = new WeakMap()
  proxyCache: WeakMap<any, any> = new WeakMap()
  notifyInSync: boolean
  initEntireSubscribe: boolean
  listeners: Set<() => void> = new Set()
  enabled: boolean

  constructor(options?: Options & { enabled?: boolean }) {
    this.notifyInSync = options?.sync ?? false
    this.initEntireSubscribe = options?.initEntireSubscribe ?? true
    this.enabled = options?.enabled ?? false
  }

  getSnapshot<T extends object>(proxyObject: T): Snapshot<T> {
    const snap = snapshot(proxyObject)
    const snapProxy = createSnapshotProxy(snap, this)
    return snapProxy
  }

  observe(proxyObject: object, key?: string | symbol): Unsubscribe {
    if (!this.enabled) return noop
    if (key === undefined) {
      return subscribe(proxyObject, this.broadcast, this.notifyInSync)
    } else if (key === allKeysSymbol) {
      return subscribeKey(
        proxyObject as any,
        key,
        this.broadcast,
        this.notifyInSync,
      )
    } else {
      // SET-time prune: when a key changes, check if its child proxy was replaced
      return subscribeKey(
        proxyObject as any,
        key,
        () => {
          this.handleKeyChange(proxyObject, key)
          this.broadcast()
        },
        this.notifyInSync,
      )
    }
  }

  /**
   * SET-time prune: called from subscribeKey callback when a property changes.
   * Detects child proxy replacement (including object→primitive) and immediately
   * prunes the old child's subscriptions before the next render.
   */
  private handleKeyChange(parent: object, key: string | symbol): void {
    const children = this.childProxies.get(parent)
    if (!children) return
    const oldChild = children.get(key)?.deref()
    // If oldChild was already GC'd, just clean up the stale entry
    if (!oldChild) {
      children.delete(key)
      return
    }
    // Self-reference: don't prune the parent itself (it's still in use)
    if (oldChild === parent) return

    const newValue = (parent as any)[key]
    if (oldChild === newValue) return // same proxy, no change

    // Remove this reference and decrement refcount
    children.delete(key)
    const oldCount = (this.childRefCount.get(oldChild) ?? 1) - 1
    if (oldCount <= 0) {
      // No more references to oldChild — safe to prune
      this.childRefCount.delete(oldChild)
      this.pruneProxy(oldChild)
    } else {
      // Still referenced by another parent key — don't prune
      this.childRefCount.set(oldChild, oldCount)
    }

    // Cancel this parent's key-level subscription immediately.
    // The old child proxy is no longer reachable via this parent key, so
    // there is no point keeping the subscription alive. If the key is
    // accessed again in a future render, recordUsage will re-establish it.
    const parentUsed = this.affected.get(parent)
    if (parentUsed) {
      const keyMap = parentUsed[KEYS_PROPERTY]
      if (keyMap?.has(key)) {
        keyMap.get(key)?.()
        keyMap.delete(key)
      }
    }

    // Record the new child reference
    if (newValue && isObjectToTrack(newValue)) {
      children.set(key, new WeakRef(newValue))
      this.childRefCount.set(
        newValue,
        (this.childRefCount.get(newValue) ?? 0) + 1,
      )
    }
  }

  /**
   * Iterate over all affected proxy objects that haven't been garbage collected.
   * Uses WeakRef.deref() to safely access objects - if deref() returns undefined,
   * the object has been GC'd and we skip it.
   */
  private forEachAffected(
    callback: (proxyObject: object, used: Used) => void,
  ): void {
    for (const ref of this.affectedKeys) {
      const proxyObject = ref.deref()
      if (proxyObject) {
        const used = this.affected.get(proxyObject)
        if (used) {
          callback(proxyObject, used)
        }
      }
    }
  }

  enable(): void {
    if (this.enabled) return
    this.enabled = true

    this.forEachAffected((proxyObject, used) => {
      for (const key in used) {
        const type = key as keyof Used
        if (type === NO_ACCESS_PROPERTY) {
          used[type] = this.observe(proxyObject)
        } else if (type === ALL_OWN_KEYS_PROPERTY) {
          used[type] = this.observe(proxyObject, allKeysSymbol)
        } else {
          const map = used[type]
          if (map) {
            for (const [key] of map) {
              map.set(key, this.observe(proxyObject as any, key))
            }
          }
        }
      }
    })
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false

    this.forEachAffected((_, used) => {
      for (const key in used) {
        const type = key as keyof Used
        if (type === NO_ACCESS_PROPERTY || type === ALL_OWN_KEYS_PROPERTY) {
          used[type]?.()
          used[type] = noop
        } else {
          const map = used[type]
          if (map) {
            for (const [key, unsub] of map.entries()) {
              unsub()
              map.set(key, noop)
            }
          }
        }
      }
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  broadcast = (): void => {
    this.listeners.forEach((listener) => listener())
  }

  /**
   * Prune a proxy object and its entire subtree from affected/subscriptions.
   * Called automatically when a child proxy is replaced during snapshot access.
   */
  pruneProxy(
    proxyObject: object,
    visited: Set<object> = new Set<object>(),
  ): void {
    // Cycle protection: skip already-visited nodes
    if (visited.has(proxyObject)) return
    visited.add(proxyObject)

    const used = this.affected.get(proxyObject)
    if (used) {
      // Unsubscribe all active subscriptions for this proxy
      for (const key in used) {
        const type = key as keyof Used
        if (type === NO_ACCESS_PROPERTY || type === ALL_OWN_KEYS_PROPERTY) {
          used[type]?.()
        } else {
          const map = used[type]
          if (map) {
            for (const [, unsub] of map) unsub()
          }
        }
      }
      this.affected.delete(proxyObject)
    }
    // Remove from affectedKeys set
    const weakRef = this.proxyToWeakRef.get(proxyObject)
    if (weakRef) {
      this.affectedKeys.delete(weakRef)
      this.proxyToWeakRef.delete(proxyObject)
    }
    // Recursively prune child subtree.
    // Decrement each child's refcount first — only recurse when it hits zero.
    const children = this.childProxies.get(proxyObject)
    if (children) {
      this.childProxies.delete(proxyObject)
      for (const [, childRef] of children) {
        const child = childRef.deref()
        if (!child) continue
        const count = (this.childRefCount.get(child) ?? 1) - 1
        if (count <= 0) {
          this.childRefCount.delete(child)
          this.pruneProxy(child, visited) // last reference — prune subtree
        } else {
          this.childRefCount.set(child, count) // still referenced elsewhere — skip
        }
      }
    }
  }

  clear(): void {
    const startEnabled = this.enabled
    this.disable()
    this.affected = new WeakMap()
    this.affectedKeys.clear()
    this.proxyToWeakRef = new WeakMap()
    this.childProxies = new WeakMap()
    this.childRefCount = new WeakMap()
    if (startEnabled) {
      this.enable()
    }
  }
}
