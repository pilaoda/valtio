import LeakDetector from 'jest-leak-detector'
import { describe, expect, it } from 'vitest'
import { SnapshotObserver, proxy, subscribeKey } from 'valtio'

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
