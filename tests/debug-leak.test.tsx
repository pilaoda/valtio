import LeakDetector from 'jest-leak-detector'
import { describe, expect, it, vi } from 'vitest'
import { SnapshotObserver, proxy, subscribeKey } from 'valtio'
import * as vanilla from 'valtio/vanilla'

describe('getProxyBySnapshot returns undefined (GC race)', () => {
  it('createSnapshotProxy should not throw when getProxyBySnapshot returns undefined', () => {
    // Simulate the scenario where snapToTargetMap's WeakRef target has been GC'd,
    // causing getProxyBySnapshot to return undefined.
    // In production this happens when the proxy target is collected between
    // snapshot() and createSnapshotProxy() — a rare but real race condition.
    const state = proxy({ child: { value: 42 } })
    const observer = new SnapshotObserver({ initEntireSubscribe: false })

    // Spy on getProxyBySnapshot to return undefined (simulating GC'd WeakRef)
    const spy = vi
      .spyOn(vanilla, 'getProxyBySnapshot')
      .mockReturnValue(undefined as any)

    try {
      // This should NOT throw "TypeError: WeakRef: invalid target"
      expect(() => {
        const snap = observer.getSnapshot(state)
        // Access a property to trigger the get trap
        const _val = (snap as any).child?.value
      }).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })

  it("snapshot proxy get trap should gracefully degrade when proxy target is GC'd", () => {
    const state = proxy({ child: { value: 42 } })
    const observer = new SnapshotObserver({ initEntireSubscribe: false })

    // First, create a normal snapshot proxy (getProxyBySnapshot works fine)
    const snap = observer.getSnapshot(state)

    // Now mock getProxyBySnapshot to return undefined for child access
    // (simulating the child's proxy target being GC'd mid-render)
    const spy = vi
      .spyOn(vanilla, 'getProxyBySnapshot')
      .mockReturnValue(undefined as any)

    try {
      // Accessing snap.child triggers createSnapshotProxy for the child snapshot.
      // With the bug: throws "TypeError: WeakRef: invalid target"
      // After fix: gracefully returns snapshot without tracking
      expect(() => {
        const _childVal = (snap as any).child
      }).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('minimal leak investigation', () => {
  // === vanilla.ts tests (all pass — vanilla is fine) ===
  it('bare proxy() child should be GC-able after delete', async () => {
    let childProxy: any = proxy({ value: 0 })
    const detector = new LeakDetector(childProxy)
    const state = proxy<{ child?: any }>({ child: childProxy })
    delete state.child
    childProxy = undefined
    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  // === SnapshotObserver-only tests (no React) ===
  it('observer: child tracked then deleted, observer alive — child should be GC-able', async () => {
    let childProxy: any = proxy({ value: 0 })
    const detector = new LeakDetector(childProxy)
    const state = proxy<{ child?: any; toggle: boolean }>({
      child: childProxy,
      toggle: true,
    })
    const observer = new SnapshotObserver({ initEntireSubscribe: false })

    // Simulate what useSnapshot does: get snapshot, access child
    let snap: any = observer.getSnapshot(state)
    // Access child to trigger recordUsage + childProxies tracking
    const _val = snap.child?.value

    // Now enable observer (simulates useLayoutEffect)
    observer.enable()

    // Toggle off — next snapshot won't read child
    state.toggle = false
    // Delete child
    delete state.child

    // Disable observer (simulates unmount cleanup)
    observer.disable()

    // Drop all refs
    snap = undefined
    childProxy = undefined

    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('observer: child tracked then deleted, observer cleared — child should be GC-able', async () => {
    let childProxy: any = proxy({ value: 0 })
    const detector = new LeakDetector(childProxy)
    const state = proxy<{ child?: any; toggle: boolean }>({
      child: childProxy,
      toggle: true,
    })
    const observer = new SnapshotObserver({ initEntireSubscribe: false })

    let snap: any = observer.getSnapshot(state)
    const _val = snap.child?.value
    observer.enable()

    state.toggle = false
    delete state.child

    // Clear observer completely
    observer.clear()

    snap = undefined
    childProxy = undefined

    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('observer: child tracked, observer dropped — child should be GC-able', async () => {
    let childProxy: any = proxy({ value: 0 })
    const detector = new LeakDetector(childProxy)
    const state = proxy<{ child?: any }>({ child: childProxy })
    let observer: any = new SnapshotObserver({ initEntireSubscribe: false })

    let snap: any = observer.getSnapshot(state)
    const _val = snap.child?.value
    observer.enable()

    delete state.child
    observer.disable()
    observer = undefined
    snap = undefined
    childProxy = undefined

    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('observer: child never accessed, just in state, then deleted — child should be GC-able', async () => {
    let childProxy: any = proxy({ value: 0 })
    const detector = new LeakDetector(childProxy)
    const state = proxy<{ child?: any; toggle: boolean }>({
      child: childProxy,
      toggle: true,
    })
    let observer: any = new SnapshotObserver({ initEntireSubscribe: false })

    // Get snapshot but DON'T access child
    let snap: any = observer.getSnapshot(state)
    const _toggle = snap.toggle // only access toggle
    observer.enable()

    delete state.child
    observer.disable()
    observer = undefined
    snap = undefined
    childProxy = undefined

    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('snapshot() alone retains child?', async () => {
    let childProxy: any = proxy({ value: 0 })
    const detector = new LeakDetector(childProxy)
    const state = proxy<{ child?: any }>({ child: childProxy })

    // Just call snapshot() — no observer at all
    const { snapshot } = await import('valtio')
    let snap: any = snapshot(state)
    const _val = snap.child?.value

    delete state.child
    snap = undefined
    childProxy = undefined

    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('snapshot() without accessing child retains child?', async () => {
    let childProxy: any = proxy({ value: 0 })
    const detector = new LeakDetector(childProxy)
    const state = proxy<{ child?: any; x: number }>({ child: childProxy, x: 1 })

    const { snapshot } = await import('valtio')
    let snap: any = snapshot(state)
    // Don't access snap.child at all

    delete state.child
    void snap
    snap = undefined
    childProxy = undefined

    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('snapshot() retains child, but re-snapshot after delete releases it?', async () => {
    let childProxy: any = proxy({ value: 0 })
    const detector = new LeakDetector(childProxy)
    const state = proxy<{ child?: any; x: number }>({ child: childProxy, x: 1 })

    const { snapshot } = await import('valtio')
    let snap: any = snapshot(state)

    delete state.child
    // Re-snapshot to flush the cache with a new version
    snap = snapshot(state)
    void snap
    snap = undefined
    childProxy = undefined

    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('getSnapshot without observer retains child?', async () => {
    let childProxy: any = proxy({ value: 0 })
    const detector = new LeakDetector(childProxy)
    const state = proxy<{ child?: any }>({ child: childProxy })
    const observer = new SnapshotObserver({ initEntireSubscribe: false })

    // Just getSnapshot, don't access child, don't enable
    let snap: any = observer.getSnapshot(state)

    delete state.child
    void snap
    snap = undefined
    childProxy = undefined

    await Promise.resolve()
    expect(await detector.isLeaking()).toBe(false)
  })

  it('subscribeKey on state.child holds child alive via listener closure', async () => {
    let childProxy: any = proxy({ value: 0 })
    const detector = new LeakDetector(childProxy)
    const state = proxy<{ child?: any }>({ child: childProxy })

    // This is what observer.observe() does internally for key-level subscriptions
    let unsub: any = subscribeKey(state, 'child' as any, () => {}, true)

    delete state.child
    childProxy = undefined

    // With subscription still active
    const _leakingWithSub = await detector.isLeaking()

    unsub()
    unsub = undefined

    await Promise.resolve()
    const leakingAfterUnsub = await detector.isLeaking()

    // child should be GC-able even with active subscription on parent's key
    // because subscribeKey subscribes to the PARENT, not the child
    expect(leakingAfterUnsub).toBe(false)
  })
})
