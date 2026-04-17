import { StrictMode, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import LeakDetector from 'jest-leak-detector'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type Snapshot,
  SnapshotObserver,
  proxy,
  subscribe,
  useSnapshot,
} from 'valtio'

describe('no memory leaks with proxy', () => {
  it('empty object', async () => {
    let state = proxy({})
    const detector = new LeakDetector(state)
    state = undefined as never
    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('child object', async () => {
    let state = proxy({ child: {} })
    const detector = new LeakDetector(state)
    state = undefined as never
    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('global child object', async () => {
    const child = {}
    let state = proxy({ child })
    const detector = new LeakDetector(state)
    state = undefined as never
    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('global child proxy', async () => {
    const child = proxy({})
    let state = proxy({ child })
    const detector = new LeakDetector(state)
    state = undefined as never
    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('object cycle (level 1)', async () => {
    let state = proxy({} as { child?: unknown })
    state.child = state
    const detector = new LeakDetector(state)
    state = undefined as never
    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('object cycle (level 2)', async () => {
    let state = proxy({ child: {} as { child?: unknown } })
    state.child.child = state
    const detector = new LeakDetector(state)
    state = undefined as never
    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })
})

describe('no memory leaks with SnapshotObserver', () => {
  it('deleted child proxy should not leak through proxyCache after clear()', async () => {
    // Simulate: parent proxy stays alive (like clsObjRecord[className]),
    // child is deleted (like Reset() deleting a customID entry),
    // observer stays alive (like atomWithObserver in Jotai store).
    // Verify the deleted child can be GC'd despite proxyCache not being reset in clear().
    const state = proxy({} as Record<string, { value: number }>)
    state.agent1 = { value: 1 }

    let childProxy: object | undefined = state.agent1
    const childDetector = new LeakDetector(childProxy)

    const observer = new SnapshotObserver({
      enabled: true,
      initEntireSubscribe: false,
    })

    // Get snapshot and access child — this populates proxyCache with child's snapshot→proxySnapshot
    let snap: any = observer.getSnapshot(state)
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    snap.agent1.value

    // Delete child from parent (simulates Reset() deleting customID keys)
    delete state.agent1

    // Clear observer — this resets affected/affectedKeys but NOT proxyCache
    observer.clear()

    // Get new snapshot so snapCache is updated (old snapshot overwritten)
    snap = observer.getSnapshot(state)

    // Release direct reference to child proxy
    childProxy = undefined
    await Promise.resolve()

    // Child proxy should be GC-able.
    // proxyCache is a WeakMap — old entries are ephemerons that don't prevent GC.
    expect(await childDetector.isLeaking()).toBe(false)

    // observer and state stay alive
    expect(observer).toBeDefined()
    expect(state).toBeDefined()
    expect(snap).toBeDefined()
  })

  it('deleted child proxy should not leak when parent stays alive and no new snapshot taken', async () => {
    // Even without requesting a new snapshot after delete,
    // the child proxy should eventually be collectible.
    const state = proxy({} as Record<string, { value: number }>)
    state.agent1 = { value: 1 }

    let childProxy: object | undefined = state.agent1
    const childDetector = new LeakDetector(childProxy)

    const observer = new SnapshotObserver({
      enabled: true,
      initEntireSubscribe: false,
    })

    let snap: any = observer.getSnapshot(state)
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    snap.agent1.value

    // Delete child and clear observer, but do NOT get a new snapshot
    delete state.agent1
    observer.clear()

    // Release references
    snap = undefined
    childProxy = undefined
    await Promise.resolve()

    // Child should still be GC-able — proxyCache and snapCache use WeakMaps
    expect(await childDetector.isLeaking()).toBe(false)

    expect(observer).toBeDefined()
    expect(state).toBeDefined()
  })

  it('SnapshotObserver.affected should not prevent proxy from being garbage collected', async () => {
    let state = proxy({ count: 0, nested: { value: 1 } })
    const detector = new LeakDetector(state)

    // Create observer and get snapshot (this adds proxyObject to affected Map)
    const observer = new SnapshotObserver()
    let snap: Snapshot<typeof state> | undefined = observer.getSnapshot(state)

    // Access properties to trigger recording in affected Map
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    snap.count
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    snap.nested.value

    // Release snap and state, but keep observer alive
    // If affected uses Map, state will leak because Map strongly references the key
    // If affected uses WeakMap, state can be garbage collected
    snap = undefined

    // Release state reference
    state = undefined as never
    await Promise.resolve()

    // State should be garbage collected (only works if affected is WeakMap)
    expect(await detector.isLeaking()).toBe(false)

    // observer is still alive here (prevents it from being optimized away)
    expect(observer).toBeDefined()
  })

  it('SnapshotObserver should not leak after multiple snapshots', async () => {
    let state = proxy({ count: 0 })
    const detector = new LeakDetector(state)

    const observer = new SnapshotObserver()
    let snap: Snapshot<typeof state> | undefined

    // Get multiple snapshots
    for (let i = 0; i < 10; i++) {
      state.count = i
      snap = observer.getSnapshot(state)
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      snap.count
    }

    snap = undefined
    state = undefined as never
    await Promise.resolve()

    expect(await detector.isLeaking()).toBe(false)
    expect(observer).toBeDefined()
  })

  it('SnapshotObserver with nested proxy should not leak', async () => {
    let parent = proxy({ child: proxy({ value: 0 }) })
    const parentDetector = new LeakDetector(parent)
    const childDetector = new LeakDetector(parent.child)

    const observer = new SnapshotObserver()
    let snap: Snapshot<typeof parent> | undefined = observer.getSnapshot(parent)

    // Access nested property
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    snap.child.value

    snap = undefined
    parent = undefined as never
    await Promise.resolve()

    expect(await parentDetector.isLeaking()).toBe(false)
    expect(await childDetector.isLeaking()).toBe(false)
    expect(observer).toBeDefined()
  })
})

describe('no memory leaks with proxy with subscription', () => {
  it('empty object', async () => {
    let state = proxy({})
    const detector = new LeakDetector(state)
    let unsub = subscribe(state, () => {})
    await new Promise((resolve) => setTimeout(resolve, 1))
    unsub()
    unsub = undefined as never
    state = undefined as never
    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('child object', async () => {
    let state = proxy({ child: {} })
    const detector = new LeakDetector(state)
    let unsub = subscribe(state, () => {})
    await new Promise((resolve) => setTimeout(resolve, 1))
    unsub()
    unsub = undefined as never
    state = undefined as never
    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('global child object', async () => {
    const child = {}
    let state = proxy({ child })
    const detector = new LeakDetector(state)
    let unsub = subscribe(state, () => {})
    await new Promise((resolve) => setTimeout(resolve, 1))
    unsub()
    unsub = undefined as never
    state = undefined as never
    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('global child proxy', async () => {
    const child = proxy({})
    let state = proxy({ child })
    const detector = new LeakDetector(state)
    let unsub = subscribe(state, () => {})
    await new Promise((resolve) => setTimeout(resolve, 1))
    unsub()
    unsub = undefined as never
    state = undefined as never
    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('object cycle (level 1)', async () => {
    let state = proxy({} as { child?: unknown })
    state.child = state
    const detector = new LeakDetector(state)
    let unsub = subscribe(state, () => {})
    await new Promise((resolve) => setTimeout(resolve, 1))
    unsub()
    unsub = undefined as never
    state = undefined as never
    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('object cycle (level 2)', async () => {
    let state = proxy({ child: {} as { child?: unknown } })
    state.child.child = state
    const detector = new LeakDetector(state)
    let unsub = subscribe(state, () => {})
    await new Promise((resolve) => setTimeout(resolve, 1))
    unsub()
    unsub = undefined as never
    state = undefined as never
    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })
})

describe('no memory leaks with proxy with useSnapshot', () => {
  beforeEach(() => {
    // don't fake setImmediate, it conflict with javascript debugger and cause stuck
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'setInterval',
        'clearTimeout',
        'clearInterval',
        'Date',
      ],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('simple counter', async () => {
    let state = proxy({ count: 0 })
    const stateDetector = new LeakDetector(state)
    let snap: Snapshot<typeof state> | undefined
    let observer = new SnapshotObserver()

    const Counter = () => {
      // eslint-disable-next-line react-hooks/react-compiler
      snap = useSnapshot(state, { testOnlyObserver: observer })
      return (
        <>
          <div>count: {snap.count}</div>
          <button onClick={() => ++state.count}>button</button>
        </>
      )
    }

    let view = render(
      <StrictMode>
        <Counter />
      </StrictMode>,
    )
    const viewDetector = new LeakDetector(view)
    const snapDetector = new LeakDetector(snap!)
    const observerDetector = new LeakDetector(observer)

    expect(screen.getByText('count: 0')).toBeInTheDocument()

    fireEvent.click(screen.getByText('button'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('count: 1')).toBeInTheDocument()

    await act(() => view.unmount())
    view = undefined as never
    snap = undefined as never
    observer = undefined as never
    await Promise.resolve()
    expect(await viewDetector.isLeaking()).toBe(false)
    expect(await snapDetector.isLeaking()).toBe(false)
    expect(await observerDetector.isLeaking()).toBe(false)

    state = undefined as never
    await Promise.resolve()
    expect(await stateDetector.isLeaking()).toBe(false)
  })

  it('nested object reference change', async () => {
    let state = proxy({ nested: { count: 0 } })
    const stateDetector = new LeakDetector(state)
    let snap: Snapshot<typeof state> | undefined
    let observer = new SnapshotObserver()

    const renderFn = vi.fn()
    const Component = () => {
      // eslint-disable-next-line react-hooks/react-compiler
      snap = useSnapshot(state, { testOnlyObserver: observer })
      renderFn()
      return (
        <>
          <div>Count: {snap.nested.count}</div>
          <button
            onClick={() => {
              state.nested = { count: 0 }
            }}
          >
            button-zero
          </button>
          <button
            onClick={() => {
              state.nested = { count: 1 }
            }}
          >
            button-one
          </button>
        </>
      )
    }

    let view = render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    const viewDetector = new LeakDetector(view)
    const snapDetector = new LeakDetector(snap!)
    const observerDetector = new LeakDetector(observer)

    expect(screen.getByText('Count: 0')).toBeInTheDocument()
    expect(renderFn).toBeCalledTimes(2)

    fireEvent.click(screen.getByText('button-zero'))

    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(renderFn).toBeCalledTimes(4)

    fireEvent.click(screen.getByText('button-one'))

    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('Count: 1')).toBeInTheDocument()
    expect(renderFn).toBeCalledTimes(6)

    await act(() => view.unmount())
    view = undefined as never
    snap = undefined as never
    observer = undefined as never
    await Promise.resolve()
    expect(await viewDetector.isLeaking()).toBe(false)
    expect(await snapDetector.isLeaking()).toBe(false)
    expect(await observerDetector.isLeaking()).toBe(false)

    state = undefined as never
    await Promise.resolve()
    expect(await stateDetector.isLeaking()).toBe(false)
  })

  it('proxy object change', async () => {
    let state1 = proxy({ nested: { count: 0 } })
    let state2 = proxy({ nested: { count: 10 } })
    const stateDetector1 = new LeakDetector(state1)
    const stateDetector2 = new LeakDetector(state2)
    let snap: Snapshot<typeof state1> | undefined
    let observer = new SnapshotObserver()

    const renderFn = vi.fn()
    const Component = () => {
      const [second, setSecond] = useState(false)
      const state = second ? state2 : state1
      // eslint-disable-next-line react-hooks/react-compiler
      snap = useSnapshot(state, { testOnlyObserver: observer })
      renderFn()
      return (
        <>
          <div>Count: {snap.nested.count}</div>
          <button
            onClick={() => {
              state.nested.count++
            }}
          >
            increment
          </button>
          <button
            onClick={() => {
              setSecond(true)
            }}
          >
            use second state
          </button>
        </>
      )
    }

    let view = render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    const viewDetector = new LeakDetector(view)
    const snapDetector = new LeakDetector(snap!)
    const observerDetector = new LeakDetector(observer)

    expect(screen.getByText('Count: 0')).toBeInTheDocument()
    expect(renderFn).toBeCalledTimes(2)

    fireEvent.click(screen.getByText('increment'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('Count: 1')).toBeInTheDocument()
    expect(renderFn).toBeCalledTimes(4)

    fireEvent.click(screen.getByText('use second state'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('Count: 10')).toBeInTheDocument()
    expect(renderFn).toBeCalledTimes(6)

    fireEvent.click(screen.getByText('increment'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('Count: 11')).toBeInTheDocument()
    expect(renderFn).toBeCalledTimes(8)

    await act(() => view.unmount())
    view = undefined as never
    snap = undefined as never
    observer = undefined as never
    await Promise.resolve()
    expect(await viewDetector.isLeaking()).toBe(false)
    expect(await snapDetector.isLeaking()).toBe(false)
    expect(await observerDetector.isLeaking()).toBe(false)

    state1 = undefined as never
    state2 = undefined as never
    await Promise.resolve()
    expect(await stateDetector1.isLeaking()).toBe(false)
    expect(await stateDetector2.isLeaking()).toBe(false)
  })
})

describe('auto-prune replaced child proxy subscriptions', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'setInterval',
        'clearTimeout',
        'clearInterval',
        'Date',
      ],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Count how many proxy objects in affectedKeys are still alive (not GC'd).
   */
  function countAliveAffectedKeys(observer: SnapshotObserver): number {
    let count = 0
    for (const ref of observer.affectedKeys) {
      if (ref.deref()) count++
    }
    return count
  }

  it('replaced nested proxy is auto-pruned from observer without clearOnRender', async () => {
    // Simulate: a long-lived component reads snap.agent.value
    // The agent proxy gets replaced multiple times (e.g. game re-entry)
    // Old agent proxies should be auto-pruned when the get trap detects replacement
    const state = proxy({ agent: proxy({ value: 0 }) })
    const observer = new SnapshotObserver()
    const oldAgents: object[] = []

    const Component = () => {
      // No clearOnRender needed — auto-prune handles it
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      return <div>Value: {snap.agent.value}</div>
    }

    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    expect(screen.getByText('Value: 0')).toBeInTheDocument()

    const initialAliveCount = countAliveAffectedKeys(observer)
    // initial: state proxy + state.agent proxy = 2
    expect(initialAliveCount).toBe(2)

    // Replace agent 3 times (simulating 3 game round transitions)
    for (let i = 1; i <= 3; i++) {
      oldAgents.push(state.agent)
      state.agent = proxy({ value: i })
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(screen.getByText(`Value: ${i}`)).toBeInTheDocument()
    }

    // Old agents are NOT tracked — auto-pruned when child proxy changed
    for (const oldAgent of oldAgents) {
      expect(observer.affected.has(oldAgent)).toBe(false)
    }

    // affectedKeys alive count stays at 2 (state + current agent only)
    const finalAliveCount = countAliveAffectedKeys(observer)
    expect(finalAliveCount).toBe(initialAliveCount)
  })

  it('deep nested proxy replacement is recursively pruned', async () => {
    // state.a.b.value — replace state.a, both a and b should be pruned
    const state = proxy({
      a: proxy({ b: proxy({ value: 0 }) }),
    })
    const observer = new SnapshotObserver()

    const Component = () => {
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      return <div>Deep: {snap.a.b.value}</div>
    }

    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    expect(screen.getByText('Deep: 0')).toBeInTheDocument()

    // initial: state + a + b = 3
    const initialAliveCount = countAliveAffectedKeys(observer)
    expect(initialAliveCount).toBe(3)

    const oldA = state.a
    const oldB = state.a.b
    state.a = proxy({ b: proxy({ value: 1 }) })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('Deep: 1')).toBeInTheDocument()

    // Both old a and old b should be pruned
    expect(observer.affected.has(oldA)).toBe(false)
    expect(observer.affected.has(oldB)).toBe(false)

    // Still 3: state + new a + new b
    const finalAliveCount = countAliveAffectedKeys(observer)
    expect(finalAliveCount).toBe(initialAliveCount)
  })

  it('unchanged sibling subscriptions are preserved when one child is replaced', async () => {
    const state = proxy({
      agent: proxy({ value: 0 }),
      config: proxy({ name: 'test' }),
    })
    const observer = new SnapshotObserver()

    const Component = () => {
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      return (
        <div>
          V: {snap.agent.value} N: {snap.config.name}
        </div>
      )
    }

    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    expect(screen.getByText('V: 0 N: test')).toBeInTheDocument()

    // initial: state + agent + config = 3
    expect(countAliveAffectedKeys(observer)).toBe(3)

    // config should still be tracked
    expect(observer.affected.has(state.config)).toBe(true)

    // Replace only agent
    state.agent = proxy({ value: 1 })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('V: 1 N: test')).toBeInTheDocument()

    // config is still tracked (not pruned)
    expect(observer.affected.has(state.config)).toBe(true)

    // Still 3: state + new agent + config
    expect(countAliveAffectedKeys(observer)).toBe(3)
  })
})

describe('auto-prune edge cases (review findings)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'setInterval',
        'clearTimeout',
        'clearInterval',
        'Date',
      ],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function countAliveAffectedKeys(observer: SnapshotObserver): number {
    let count = 0
    for (const ref of observer.affectedKeys) {
      if (ref.deref()) count++
    }
    return count
  }

  /**
   * Review finding #2: Object→primitive/delete transition
   *
   * When state.child changes from an object proxy to a primitive (number/string/null),
   * the get trap's `isObjectToTrack(childSnap)` returns false, so it never enters
   * the prune branch. The old child proxy's subscriptions remain in the observer.
   */
  it('object→primitive transition: old child proxy should be pruned', async () => {
    const state = proxy({ child: proxy({ value: 0 }) as any })
    const observer = new SnapshotObserver()

    const Component = () => {
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      const child = snap.child
      if (typeof child === 'object' && child !== null) {
        return <div>Object: {child.value}</div>
      }
      return <div>Primitive: {String(child)}</div>
    }

    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    expect(screen.getByText('Object: 0')).toBeInTheDocument()
    expect(countAliveAffectedKeys(observer)).toBe(2) // state + child

    const oldChild = state.child
    // Replace object with primitive
    state.child = 42
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('Primitive: 42')).toBeInTheDocument()

    // BUG? Old child proxy should be pruned but might not be
    // because isObjectToTrack(42) is false, so prune branch is skipped
    const oldChildStillTracked = observer.affected.has(oldChild)
    const aliveCount = countAliveAffectedKeys(observer)

    // If auto-prune works correctly: oldChild should NOT be tracked, aliveCount should be 1
    // If bug exists: oldChild IS still tracked, aliveCount is 2
    expect(oldChildStillTracked).toBe(false)
    expect(aliveCount).toBe(1) // only state
  })

  /**
   * Review finding #3: Root proxy switching (known over-subscription)
   *
   * When a component switches the proxy object passed to useSnapshot,
   * the observer is a useMemo([], []) singleton — it never resets.
   * The old root proxy's subscriptions remain in the observer.
   *
   * This is intentionally accepted behavior: handleKeyChange only fires for
   * subscribeKey(parent, key) callbacks on proxy properties. Root proxies are
   * held in React local variables — no parent proxy holds them as a key, so no
   * subscribeKey callback fires when the component switches to a different proxy.
   * The stale subscription is harmless: useSyncExternalStore's snapshot comparison
   * ensures extra re-renders are suppressed; the old root's subscription is
   * eventually GC'd when the proxy becomes unreachable.
   */
  it('root proxy switch: old root causes known over-subscription', async () => {
    const state1 = proxy({ count: 0 })
    const state2 = proxy({ count: 100 })
    const observer = new SnapshotObserver()

    const Component = () => {
      const [useFirst, setUseFirst] = useState(true)
      const target = useFirst ? state1 : state2
      const snap = useSnapshot(target, { testOnlyObserver: observer })
      return (
        <div>
          <span>Count: {snap.count}</span>
          <button onClick={() => setUseFirst(false)}>switch</button>
        </div>
      )
    }

    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    expect(screen.getByText('Count: 0')).toBeInTheDocument()
    // state1 is tracked
    expect(observer.affected.has(state1)).toBe(true)

    // Switch to state2
    fireEvent.click(screen.getByText('switch'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('Count: 100')).toBeInTheDocument()

    // Known limitation: state1 is still tracked after switching to state2.
    // handleKeyChange cannot detect root-level variable changes (no parent key).
    // Both state1 and state2 are tracked → aliveCount = 2 (over-subscription).
    const state1StillTracked = observer.affected.has(state1)
    const aliveCount = countAliveAffectedKeys(observer)

    expect(state1StillTracked).toBe(true) // known over-subscription
    expect(aliveCount).toBe(2) // state1 + state2 (both tracked)
  })

  /**
   * Review finding #4: Shared child proxy (DAG, not tree)
   *
   * Two parent keys point to the same child proxy object.
   * When one parent replaces the shared child, pruneProxy removes ALL subscriptions
   * for that child, even though the other parent path still needs them.
   */
  it('shared child proxy: replacing one reference should not break the other', async () => {
    const shared = proxy({ value: 0 })
    const state = proxy({ a: shared, b: shared })
    const observer = new SnapshotObserver()

    const Component = () => {
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      return (
        <div>
          A: {snap.a.value} B: {snap.b.value}
        </div>
      )
    }

    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    expect(screen.getByText('A: 0 B: 0')).toBeInTheDocument()

    // shared proxy is tracked (state + shared = 2, since a and b point to same proxy)
    expect(observer.affected.has(shared)).toBe(true)
    // state + shared = 2 (not 3, since a and b are same object)
    expect(countAliveAffectedKeys(observer)).toBe(2)

    // Replace only state.a — this triggers pruneProxy(shared)
    // But state.b still references the same shared proxy!
    state.a = proxy({ value: 99 })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('A: 99 B: 0')).toBeInTheDocument()

    // The shared proxy is still reachable via state.b
    // BUG? pruneProxy may have removed its subscriptions entirely
    const sharedStillTracked = observer.affected.has(shared)

    // If correct: shared should still be tracked via state.b path
    // If bug: shared was pruned when state.a was replaced
    expect(sharedStillTracked).toBe(true)

    // Verify state.b still triggers re-renders
    shared.value = 999
    await act(() => vi.advanceTimersByTimeAsync(0))
    // If shared's subscriptions were incorrectly pruned, this update won't re-render
    expect(screen.getByText('A: 99 B: 999')).toBeInTheDocument()
  })

  /**
   * Review finding #4b: Shared child proxy with REVERSED access order
   *
   * Same scenario as #4, but component reads B before A.
   * During re-render when state.a is replaced:
   *   1. get trap for 'b' → recordUsage(shared, ...) → registers shared subscription
   *   2. get trap for 'a' → detects child changed → pruneProxy(shared) → deletes the
   *      subscription just registered in step 1!
   * Result: shared.value mutations no longer trigger re-render.
   * This is equivalent to memo preventing re-registration.
   */
  it('shared child proxy (reversed access order): prune destroys sibling subscription', async () => {
    const shared = proxy({ value: 0 })
    const state = proxy({ a: shared, b: shared })
    const observer = new SnapshotObserver()

    const Component = () => {
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      // NOTE: B is read BEFORE A — this is the key difference from the test above
      return (
        <div>
          B: {snap.b.value} A: {snap.a.value}
        </div>
      )
    }

    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    expect(screen.getByText('B: 0 A: 0')).toBeInTheDocument()

    // shared proxy is tracked
    expect(observer.affected.has(shared)).toBe(true)
    expect(countAliveAffectedKeys(observer)).toBe(2)

    // Replace only state.a — pruneProxy(shared) happens AFTER b's subscription is registered
    state.a = proxy({ value: 99 })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('B: 0 A: 99')).toBeInTheDocument()

    // shared should still be tracked via state.b path
    expect(observer.affected.has(shared)).toBe(true)

    // Verify state.b still triggers re-renders
    shared.value = 999
    await act(() => vi.advanceTimersByTimeAsync(0))
    // If pruneProxy destroyed b's subscription, this won't re-render
    expect(screen.getByText('B: 999 A: 99')).toBeInTheDocument()
  })

  /**
   * Review finding #4c: Shared child proxy WITHOUT initEntireSubscribe
   *
   * The above two shared-child tests pass because initEntireSubscribe=true (default)
   * adds a full `subscribe(state, broadcast)` on the root proxy, which catches ALL
   * nested mutations as a safety net — masking the key-level prune issue.
   *
   * With initEntireSubscribe=false, only per-key subscriptions exist.
   * When pruneProxy(shared) removes shared's subscriptions, there's no root-level
   * catch-all to fall back on. Reversed access order should expose the real bug.
   */
  it('shared child proxy (no initEntireSubscribe, reversed order): prune exposes real bug', async () => {
    const shared = proxy({ value: 0 })
    const state = proxy({ a: shared, b: shared })
    const observer = new SnapshotObserver({ initEntireSubscribe: false })

    const Component = () => {
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      // B before A: prune(shared) happens after b's subscription is registered
      return (
        <div>
          B: {snap.b.value} A: {snap.a.value}
        </div>
      )
    }

    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    expect(screen.getByText('B: 0 A: 0')).toBeInTheDocument()

    expect(observer.affected.has(shared)).toBe(true)

    // Replace state.a — should prune shared, but shared is still needed by state.b
    state.a = proxy({ value: 99 })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('B: 0 A: 99')).toBeInTheDocument()

    // shared should still be tracked via state.b path
    expect(observer.affected.has(shared)).toBe(true)

    // Mutate shared — should trigger re-render via state.b
    shared.value = 999
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('B: 999 A: 99')).toBeInTheDocument()
  })

  /**
   * Review finding #4d: Shared child proxy WITHOUT StrictMode
   *
   * StrictMode double-renders components. The first render triggers pruneProxy(shared)
   * when processing 'a', but the second render sees childProxies already updated
   * (oldChild === childProxy for 'a'), so no prune happens and shared's subscription
   * is re-registered via recordUsage.
   *
   * Without StrictMode, only one render happens:
   *   1. get trap for 'b' → recordUsage(shared, 'value') → subscription registered
   *   2. get trap for 'a' → pruneProxy(shared) → subscription destroyed!
   * shared.value mutations are now invisible to the observer.
   */
  it('shared child proxy (no StrictMode, reversed order): single render exposes prune bug', async () => {
    const shared = proxy({ value: 0 })
    const state = proxy({ a: shared, b: shared })
    const observer = new SnapshotObserver({ initEntireSubscribe: false })

    const Component = () => {
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      // B before A: single render means prune(shared) destroys b's subscription permanently
      return (
        <div>
          B: {snap.b.value} A: {snap.a.value}
        </div>
      )
    }

    // NO StrictMode — single render, no self-healing second pass
    render(<Component />)
    expect(screen.getByText('B: 0 A: 0')).toBeInTheDocument()

    expect(observer.affected.has(shared)).toBe(true)

    state.a = proxy({ value: 99 })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('B: 0 A: 99')).toBeInTheDocument()

    // shared should still be tracked via state.b
    expect(observer.affected.has(shared)).toBe(true)

    // Mutate shared — should trigger re-render via state.b
    shared.value = 999
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('B: 999 A: 99')).toBeInTheDocument()
  })

  /**
   * Review finding #1: Same-proxy stale key subscriptions (known over-subscription)
   *
   * Component reads snap.x in render 1, then only snap.y in render 2.
   * Since the proxy object hasn't changed identity, SET-time prune never fires
   * (no child proxy replacement). The subscription on key 'x' remains.
   *
   * This is intentionally accepted behavior: snap.x could be held by a useMemo
   * or child component that the observer cannot see. Pruning it would be unsafe.
   * The re-render is harmless — useSyncExternalStore's snapshot comparison ensures
   * the component only re-renders when the accessed snapshot actually changes.
   *
   * See also: optimization.test.tsx "subscribe different property on separate renders"
   * which documents the same accepted behavior.
   */
  it('same-proxy key change: stale key subscription causes known over-subscription', async () => {
    const state = proxy({ x: 0, y: 0 })
    const observer = new SnapshotObserver({ initEntireSubscribe: false })

    const renderFn = vi.fn()
    const Component = () => {
      const [readY, setReadY] = useState(false)
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      renderFn()
      return (
        <div>
          <span>Val: {readY ? snap.y : snap.x}</span>
          <button onClick={() => setReadY(true)}>switch to y</button>
        </div>
      )
    }

    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    expect(screen.getByText('Val: 0')).toBeInTheDocument()

    // Switch to reading y instead of x
    fireEvent.click(screen.getByText('switch to y'))
    await act(() => vi.advanceTimersByTimeAsync(0))

    const rendersBefore = renderFn.mock.calls.length
    // Mutate x — stale subscription on 'x' still fires, causing a re-render.
    // This is accepted over-subscription: observer cannot safely prune 'x' because
    // snap.x might be held by a useMemo or child component outside the render body.
    state.x = 42
    await act(() => vi.advanceTimersByTimeAsync(0))

    // Re-render happens due to stale subscription — this is the known behavior.
    // StrictMode double-invokes render functions, so expect +2.
    expect(renderFn).toBeCalledTimes(rendersBefore + 2)
  })

  it('conditional branch stops reading child proxy and delete it: child should be GC-able', async () => {
    // Use `let` so we can null the reference after pruning to allow GC
    let childProxy: { toggle222: string } | undefined = proxy({
      toggle222: 'a'.repeat(10000000),
    })
    const childDetector = new LeakDetector(childProxy)
    const state = proxy<{ child?: { toggle222: string }; toggle: boolean }>({
      child: childProxy,
      toggle: true,
    })
    const observer = new SnapshotObserver({ initEntireSubscribe: false })

    const Component = () => {
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      if (snap.toggle) {
        return <div>Child: {snap.child?.toggle222}</div>
      }
      return <div>No child</div>
    }

    const view = render(<Component />)

    // child proxy is tracked: root + child = 2
    expect(observer.affected.has(childProxy)).toBe(true)
    expect(countAliveAffectedKeys(observer)).toBe(2)

    // Toggle off — component no longer reads snap.child
    state.toggle = false
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('No child')).toBeInTheDocument()

    // Delete child from state — removes the only strong reference in the state tree
    delete state.child
    await act(() => vi.advanceTimersByTimeAsync(0))

    // Logical check: observer should have pruned the child proxy
    expect(observer.affected.has(childProxy!)).toBe(false)
    expect(countAliveAffectedKeys(observer)).toBe(1) // only root

    // Real GC check: drop local reference; state.child is deleted so no ref from state.
    // If the observer's subscription system still holds a strong reference, isLeaking() → true.
    await act(() => view.unmount())
    childProxy = undefined
    await Promise.resolve()
    expect(await childDetector.isLeaking()).toBe(false)
  })

  it('conditional branch stops reading multi parent child proxy and delete it: child should be GC-able', async () => {
    // childProxy is referenced by two parent keys (p1.child and p2.child).
    // Only after BOTH are deleted should childProxy become GC-eligible.
    let childProxy: { value: number } | undefined = proxy({ value: 0 })
    const childDetector = new LeakDetector(childProxy)
    const state = proxy<{
      p1: { child?: { value: number } }
      p2: { child?: { value: number } }
      toggle: boolean
    }>({
      p1: { child: childProxy },
      p2: { child: childProxy },
      toggle: true,
    })
    const observer = new SnapshotObserver({ initEntireSubscribe: false })

    const Component = () => {
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      if (snap.toggle) {
        return (
          <div>
            p1 Child: {snap.p1.child?.value} p2 Child: {snap.p2.child?.value}
          </div>
        )
      }
      return <div>No child</div>
    }

    render(<Component />)
    expect(screen.getByText('p1 Child: 0 p2 Child: 0')).toBeInTheDocument()

    // child proxy is tracked: root + p1 + p2 + child = 4
    expect(observer.affected.has(childProxy)).toBe(true)
    expect(countAliveAffectedKeys(observer)).toBe(4)

    // Toggle off — component no longer reads snap.p1.child / snap.p2.child
    state.toggle = false
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('No child')).toBeInTheDocument()

    // Delete from both parents — removes all strong references from the state tree
    delete state.p1.child
    delete state.p2.child
    await act(() => vi.advanceTimersByTimeAsync(0))

    // Logical check: refcount reaches 0 only after both parents release the child
    expect(observer.affected.has(childProxy!)).toBe(false)
    expect(countAliveAffectedKeys(observer)).toBe(3) // root + p1 + p2

    // Real GC check: both state references deleted; drop local ref too
    childProxy = undefined
    expect(await childDetector.isLeaking()).toBe(false)
  })

  it('conditional branch stops reading child proxy and replace it: old child should be GC-able', async () => {
    // child1Proxy is replaced by child2Proxy while the component isn't reading it.
    // child1Proxy should be pruned from the observer and become GC-eligible.
    // child2Proxy is never read by the component so it's never tracked.
    let child1Proxy: { value: number } | undefined = proxy({ value: 0 })
    const child1Detector = new LeakDetector(child1Proxy)
    const child2Proxy = proxy({ value: 999 })
    const child2Detector = new LeakDetector(child2Proxy)
    const state = proxy<{ child?: { value: number }; toggle: boolean }>({
      child: child1Proxy,
      toggle: true,
    })
    const observer = new SnapshotObserver({ initEntireSubscribe: false })

    const Component = () => {
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      if (snap.toggle) {
        return <div>Child: {snap.child?.value}</div>
      }
      return <div>No child</div>
    }

    render(<Component />)
    expect(screen.getByText('Child: 0')).toBeInTheDocument()

    // child1 is tracked: root + child1 = 2
    expect(observer.affected.has(child1Proxy)).toBe(true)
    expect(countAliveAffectedKeys(observer)).toBe(2)

    // Toggle off — component no longer reads snap.child
    state.toggle = false
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('No child')).toBeInTheDocument()

    // Replace child1 with child2 — child1 should be pruned; child2 is never read so never tracked
    state.child = child2Proxy
    await act(() => vi.advanceTimersByTimeAsync(0))

    // Logical check
    expect(observer.affected.has(child1Proxy!)).toBe(false) // pruned
    expect(observer.affected.has(child2Proxy)).toBe(false) // never tracked
    expect(countAliveAffectedKeys(observer)).toBe(1) // only root

    // Real GC check for child1: state.child is now child2, so child1 has no state reference.
    // Drop local ref and verify GC.
    child1Proxy = undefined
    expect(await child1Detector.isLeaking()).toBe(false)

    // child2 is still referenced by state.child → should still be alive
    expect(await child2Detector.isLeaking()).toBe(true)
  })

  it('conditional branch stops reading multi parent child proxy and replace it: old child should be GC-able', async () => {
    // child1Proxy referenced by both p1.child and p2.child.
    // Both must be replaced before child1Proxy's refcount reaches 0.
    let child1Proxy: { value: number } | undefined = proxy({ value: 0 })
    const child1Detector = new LeakDetector(child1Proxy)
    const child2Proxy = proxy({ value: 999 })
    const child2Detector = new LeakDetector(child2Proxy)
    const state = proxy<{
      p1: { child?: { value: number } }
      p2: { child?: { value: number } }
      toggle: boolean
    }>({
      p1: { child: child1Proxy },
      p2: { child: child1Proxy },
      toggle: true,
    })
    const observer = new SnapshotObserver({ initEntireSubscribe: false })

    const Component = () => {
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      if (snap.toggle) {
        return (
          <div>
            p1 Child: {snap.p1.child?.value} p2 Child: {snap.p2.child?.value}
          </div>
        )
      }
      return <div>No child</div>
    }

    render(<Component />)
    expect(screen.getByText('p1 Child: 0 p2 Child: 0')).toBeInTheDocument()

    // child1 is tracked: root + p1 + p2 + child1 = 4
    expect(observer.affected.has(child1Proxy)).toBe(true)
    expect(countAliveAffectedKeys(observer)).toBe(4)

    // Toggle off — component no longer reads snap.p1.child / snap.p2.child
    state.toggle = false
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('No child')).toBeInTheDocument()

    // Replace child1 in both parents — refcount drops to 0 only after both are replaced
    state.p1.child = child2Proxy
    state.p2.child = child2Proxy
    await act(() => vi.advanceTimersByTimeAsync(0))

    // Logical check
    expect(observer.affected.has(child1Proxy!)).toBe(false) // pruned (refcount hit 0)
    expect(observer.affected.has(child2Proxy)).toBe(false) // never tracked
    expect(countAliveAffectedKeys(observer)).toBe(3) // root + p1 + p2

    // Real GC check for child1: p1.child and p2.child are now child2, child1 has no state ref.
    child1Proxy = undefined
    expect(await child1Detector.isLeaking()).toBe(false)

    // child2 is still referenced by state.p1.child and state.p2.child → should be alive
    expect(await child2Detector.isLeaking()).toBe(true)
  })

  /**
   * Get-time prune "never triggers" #1c: true memory leak via deleted children
   *
   * Component reads snap.items[currentIndex].value. Each cycle:
   * 1. Advance currentIndex → component stops reading old item
   * 2. Delete the old item from state.items → it's gone from state tree
   *
   * After deletion, the old child proxy has zero external references EXCEPT
   * strong references held by the observer's subscription system. If pruning
   * doesn't release those references, GC cannot collect the proxy → real leak.
   *
   * N cycles = N leaked child proxies that should have been collected.
   *
   * Uses LeakDetector (FinalizationRegistry/WeakRef) for real GC verification,
   * plus observer.affected checks to confirm pruning at the logical level.
   */
  it('deleted children: observer retains references to removed proxies', async () => {
    const items: Record<string, any> = {}
    // Create LeakDetectors before any strong reference is released.
    // LeakDetector uses WeakRef internally — it does NOT prevent GC.
    const detectors: LeakDetector[] = []
    for (let i = 0; i < 10; i++) {
      items[i] = proxy({ value: i * 100 })
      detectors.push(new LeakDetector(items[i]))
    }
    const state = proxy({ items, currentIndex: 0 })
    const observer = new SnapshotObserver({ initEntireSubscribe: false })

    // Keep WeakRefs to old children so we can check observer.affected without
    // accidentally keeping the proxies alive ourselves.
    const oldChildRefs: WeakRef<object>[] = []

    const Component = () => {
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      const idx = snap.currentIndex
      const item = snap.items[idx]
      return <div>Item: {item!.value}</div>
    }

    const view = render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    expect(screen.getByText('Item: 0')).toBeInTheDocument()

    // initial: root + items + items[0] = 3
    const initialCount = countAliveAffectedKeys(observer)

    for (let i = 1; i < 10; i++) {
      // Create WeakRef directly without holding a strong reference in a local variable.
      // V8's async function implementation retains the last iteration's block-scoped
      // variables across GC boundaries, which would prevent the proxy from being collected.
      oldChildRefs.push(new WeakRef(state.items[i - 1]))

      // Advance index — component now reads items[i]
      state.currentIndex = i
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(screen.getByText(`Item: ${i * 100}`)).toBeInTheDocument()

      // DELETE old child from state — removes the only strong reference in the state tree.
      // After this point, the old child should be GC-eligible if the observer pruned it.
      delete state.items[i - 1]
      await act(() => vi.advanceTimersByTimeAsync(0))
    }

    // affectedKeys alive count should stay constant: root + items + current child
    const finalCount = countAliveAffectedKeys(observer)
    expect(finalCount).toBe(initialCount)

    // Unmount to release React-held snapshot references and observer subscriptions.
    await act(() => view.unmount())
    vi.useRealTimers()
    await Promise.resolve()

    // Real GC check: deleted proxies (items 0–8) should be collectable.
    for (let i = 0; i < 9; i++) {
      expect(await detectors[i]!.isLeaking()).toBe(false)
    }

    // Logical check (after GC): observer.affected should not track any deleted proxy
    let leakedCount = 0
    for (const ref of oldChildRefs) {
      const old = ref.deref()
      if (old && observer.affected.has(old)) {
        leakedCount++
      }
    }
    expect(leakedCount).toBe(0)
    // items[9] is the current item — still referenced by state.items[9], should be alive.
    expect(await detectors[9]!.isLeaking()).toBe(true)
  })

  /**
   * If the observer is reused (or just not GC'd), this is wasted memory.
   */
  it('component unmount: affected entries should be cleared', async () => {
    const state = proxy({ child: proxy({ value: 0 }) })
    const observer = new SnapshotObserver({ initEntireSubscribe: false })

    const Component = () => {
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      return <div>V: {snap.child.value}</div>
    }

    const { unmount } = render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    expect(screen.getByText('V: 0')).toBeInTheDocument()
    expect(countAliveAffectedKeys(observer)).toBe(2) // root + child

    // Unmount — disable() is called, subscriptions paused
    unmount()

    // Wait for microtask-based cleanup to run
    await act(() => vi.advanceTimersByTimeAsync(0))

    // affected entries should be cleared after unmount
    expect(countAliveAffectedKeys(observer)).toBe(0)
  })

  /**
   * Circular reference: self-referencing proxy
   *
   * state.self = state creates a cycle in childProxies: state → { self: state }
   * When the self-referencing key is replaced, pruneProxy recurses through
   * childProxies. Since childProxies.delete() happens AFTER the for loop,
   * the recursion revisits the same node → infinite loop → stack overflow.
   */
  it('circular reference (self-loop): pruneProxy should not stack overflow', async () => {
    const state = proxy({ self: null as any, value: 0 })
    state.self = state // circular: state.self === state

    const observer = new SnapshotObserver()

    const Component = () => {
      const snap = useSnapshot(state, { testOnlyObserver: observer })
      // Access the circular reference (only 1 level deep to avoid infinite render)
      return (
        <div>
          V: {snap.value} Self: {snap.self.value}
        </div>
      )
    }

    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    expect(screen.getByText('V: 0 Self: 0')).toBeInTheDocument()

    // Replace the self-reference — this triggers pruneProxy(state) on itself
    // If no cycle protection: stack overflow
    // state.self points to state, so childProxies has state → { self: state }
    const newChild = proxy({ value: 1, self: null as any })
    newChild.self = newChild
    state.self = newChild
    await act(() => vi.advanceTimersByTimeAsync(0))
    // state.value is still 0 (unchanged), state.self.value is newChild.value = 1
    expect(screen.getByText('V: 0 Self: 1')).toBeInTheDocument()
  })

  /**
   * Circular reference: mutual cycle between two proxies
   *
   * stateA.ref = stateB, stateB.ref = stateA creates a 2-node cycle.
   * childProxies: stateA → { ref: stateB }, stateB → { ref: stateA }
   * Replacing stateA.ref triggers pruneProxy(stateB) → pruneProxy(stateA) → ...
   */
  it('circular reference (mutual cycle): pruneProxy should not stack overflow', async () => {
    const stateA = proxy({ ref: null as any, label: 'A' })
    const stateB = proxy({ ref: null as any, label: 'B' })
    stateA.ref = stateB
    stateB.ref = stateA // mutual cycle

    const root = proxy({ entry: stateA })
    const observer = new SnapshotObserver()

    const Component = () => {
      const snap = useSnapshot(root, { testOnlyObserver: observer })
      // Access 3 levels deep through the cycle: entry → A.ref → B.ref → A
      // This builds childProxies: stateA → { ref: stateB }, stateB → { ref: stateA }
      return (
        <div>
          E: {snap.entry.label} R: {snap.entry.ref.label} RR:{' '}
          {snap.entry.ref.ref.label}
        </div>
      )
    }

    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    )
    expect(screen.getByText('E: A R: B RR: A')).toBeInTheDocument()

    // Replace entry — should prune stateA → stateB → stateA (cycle)
    const newA = proxy({ ref: null as any, label: 'A2' })
    const newB = proxy({ ref: null as any, label: 'B2' })
    newA.ref = newB
    newB.ref = newA
    root.entry = newA
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('E: A2 R: B2 RR: A2')).toBeInTheDocument()
  })

  /**
   * Circular reference with multiple roots
   *
   * Two independent root proxies both participating in a cycle.
   * A component reads from root1, another reads from root2.
   * Both roots share nodes in a cycle. Replacing one root's entry
   * should not corrupt subscriptions for the other root.
   */
  it('circular reference with multiple roots: prune should not corrupt other root', async () => {
    const shared1 = proxy({ value: 1, next: null as any })
    const shared2 = proxy({ value: 2, next: null as any })
    shared1.next = shared2
    shared2.next = shared1 // cycle: shared1 → shared2 → shared1

    const root1 = proxy({ entry: shared1 })
    const root2 = proxy({ entry: shared2 })
    const observer1 = new SnapshotObserver()
    const observer2 = new SnapshotObserver()

    const Comp1 = () => {
      const snap = useSnapshot(root1, { testOnlyObserver: observer1 })
      return <div data-testid="c1">C1: {snap.entry.value}</div>
    }

    const Comp2 = () => {
      const snap = useSnapshot(root2, { testOnlyObserver: observer2 })
      return <div data-testid="c2">C2: {snap.entry.value}</div>
    }

    render(
      <StrictMode>
        <Comp1 />
        <Comp2 />
      </StrictMode>,
    )
    expect(screen.getByText('C1: 1')).toBeInTheDocument()
    expect(screen.getByText('C2: 2')).toBeInTheDocument()

    // Replace root1.entry — prune shared1, which has cycle to shared2
    // But observer2 still subscribes to shared2 (different observer, so safe)
    root1.entry = proxy({ value: 99, next: null as any })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('C1: 99')).toBeInTheDocument()

    // shared2 mutations should still trigger Comp2 re-render
    shared2.value = 200
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('C2: 200')).toBeInTheDocument()
  })
})
