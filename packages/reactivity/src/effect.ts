import { extend, isArray, NOOP, remove } from '@vue/shared'
import type { TrackOpTypes, TriggerOpTypes } from './constants'
import { setupOnTrigger } from './debug'
import { activeEffectScope } from './effectScope'
import {
  type Link,
  ReactiveFlags,
  type ReactiveNode,
  activeSub,
  checkDirty,
  endTracking,
  link,
  setActiveSub,
  startTracking,
  unlink,
} from './system'
import { warn } from './warning'
import { Ref } from './ref'
import { Dep } from './dep'

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveNode
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  scheduler?: EffectScheduler
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export const enum EffectFlags {
  /**
   * ReactiveEffect only
   */
  ALLOW_RECURSE = 1 << 7, // synchronous only
  PAUSED = 1 << 8,
  STOP = 1 << 10,

  // async:
  ASYNC = 1 << 12,
  REENTRANT = 1 << 13,
  LIVETRACKING = 1 << 14,
  ScheduleRunAfterCurrentRun = 1 << 15,
  IsScheduledRun = 1 << 16,
  AbortRunOnRetrigger = 1 << 17,
  AbortRunOnPause = 1 << 18,
  AbortRunOnStop = 1 << 19,
  DepConstraintIsBlacklist = 1 << 20,
  ObservingDep = 1 << 21,
  EnabledManualBranching = 1 << 22,
  TriggerSynchronously = 1 << 23,
  RUNNING = 1 << 24,
  ScheduleRecursiveRerun = 1 << 25,
  ManualHandling = 1 << 26,
}

export class ReactiveEffect<T = any>
  implements ReactiveEffectOptions, ReactiveNode
{
  deps: Link | undefined = undefined
  depsTail: Link | undefined = undefined
  subs: Link | undefined = undefined
  subsTail: Link | undefined = undefined
  flags: number = ReactiveFlags.Watching | ReactiveFlags.Dirty

  /**
   * @internal
   */
  cleanups: (() => void)[] = []
  /**
   * @internal
   */
  cleanupsLength = 0

  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  // @ts-expect-error
  fn(): T {}

  constructor(fn?: () => T) {
    if (fn !== undefined) {
      this.fn = fn
    }
    if (activeEffectScope) {
      link(this, activeEffectScope)
    }

    if (__DEV__ && activeSub) {
      warn(`watchEffect() should never be used inside another effect `)
    }
    if (__DEV__) {
      // @ts-ignore
      this.EffectID = ++ReactiveEffectIdCtr
    }
  }

  get active(): boolean {
    return !(this.flags & EffectFlags.STOP)
  }

  pause(): void {
    this.flags |= EffectFlags.PAUSED
  }

  resume(): void {
    const flags = (this.flags &= ~EffectFlags.PAUSED)
    if (flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) {
      this.notify()
    }
  }

  notify(dep?: ReactiveNode): void {
    if (!(this.flags & EffectFlags.PAUSED) && this.dirty) {
      this.run()
    }
  }

  run(): T {
    if (!this.active) {
      return this.fn()
    }
    cleanup(this)
    const prevSub = startTracking(this)
    try {
      return this.fn()
    } finally {
      endTracking(this, prevSub)
      const flags = this.flags
      if (
        (flags & (ReactiveFlags.Recursed | EffectFlags.ALLOW_RECURSE)) ===
        (ReactiveFlags.Recursed | EffectFlags.ALLOW_RECURSE)
      ) {
        this.flags = flags & ~ReactiveFlags.Recursed
        this.notify()
      } else {
        // unlink effect if no deps so that it can be gc'd
        if (!this.subs) {
          this.stop()
        }
      }
    }
  }

  stop(): void {
    if (!this.active) {
      return
    }
    this.flags = EffectFlags.STOP
    let dep = this.deps
    while (dep !== undefined) {
      dep = unlink(dep, this)
    }
    const sub = this.subs
    if (sub !== undefined) {
      unlink(sub)
    }
    cleanup(this)
  }

  get dirty(): boolean {
    const flags = this.flags
    if (flags & ReactiveFlags.Dirty) {
      return true
    }
    if (flags & ReactiveFlags.Pending) {
      if (checkDirty(this.deps!, this)) {
        this.flags = flags | ReactiveFlags.Dirty
        return true
      } else {
        this.flags = flags & ~ReactiveFlags.Pending
      }
    }
    return false
  }
}

if (__DEV__) {
  setupOnTrigger(ReactiveEffect)
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions,
): ReactiveEffectRunner<T> {
  if ((fn as ReactiveEffectRunner).effect instanceof ReactiveEffect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  const e = new ReactiveEffect(fn)
  if (options) {
    const { onStop, scheduler } = options
    if (onStop) {
      options.onStop = undefined
      const stop = e.stop.bind(e)
      e.stop = () => {
        stop()
        onStop()
      }
    }
    if (scheduler) {
      options.scheduler = undefined
      e.notify = () => {
        if (!(e.flags & EffectFlags.PAUSED)) {
          scheduler()
        }
      }
    }
    extend(e, options)
  }
  try {
    e.run()
  } catch (err) {
    e.stop()
    throw err
  }
  const runner = e.run.bind(e) as ReactiveEffectRunner
  runner.effect = e
  return runner
}

/**
 * Stops the effect associated with the given runner.
 *
 * @param runner - Association with the effect to stop tracking.
 */
export function stop(runner: ReactiveEffectRunner): void {
  runner.effect.stop()
}

const resetTrackingStack: (ReactiveNode | undefined)[] = []

/**
 * Temporarily pauses tracking.
 */
export function pauseTracking(): void {
  resetTrackingStack.push(activeSub)
  setActiveSub()
}

/**
 * Re-enables effect tracking (if it was paused).
 */
export function enableTracking(): void {
  const isPaused = activeSub === undefined
  if (!isPaused) {
    // Add the current active effect to the trackResetStack so it can be
    // restored by calling resetTracking.
    resetTrackingStack.push(activeSub)
  } else {
    // Add a placeholder to the trackResetStack so we can it can be popped
    // to restore the previous active effect.
    resetTrackingStack.push(undefined)
    for (let i = resetTrackingStack.length - 1; i >= 0; i--) {
      if (resetTrackingStack[i] !== undefined) {
        setActiveSub(resetTrackingStack[i])
        break
      }
    }
  }
}

/**
 * Resets the previous global effect tracking state.
 */
export function resetTracking(): void {
  if (__DEV__ && resetTrackingStack.length === 0) {
    warn(
      `resetTracking() was called when there was no active tracking ` +
        `to reset.`,
    )
  }
  if (resetTrackingStack.length) {
    setActiveSub(resetTrackingStack.pop()!)
  } else {
    setActiveSub()
  }
}

export function cleanup(
  sub: ReactiveNode & { cleanups: (() => void)[]; cleanupsLength: number },
): void {
  const l = sub.cleanupsLength
  if (l) {
    for (let i = 0; i < l; i++) {
      sub.cleanups[i]()
    }
    sub.cleanupsLength = 0
  }
}

/**
 * Registers a cleanup function for the current active effect.
 * The cleanup function is called right before the next effect run, or when the
 * effect is stopped.
 *
 * Throws a warning if there is no current active effect. The warning can be
 * suppressed by passing `true` to the second argument.
 *
 * @param fn - the cleanup function to be registered
 * @param failSilently - if `true`, will not throw warning when called without
 * an active effect.
 */
export function onEffectCleanup(fn: () => void, failSilently = false): void {
  if (activeSub instanceof ReactiveEffect) {
    activeSub.cleanups[activeSub.cleanupsLength++] = () => cleanupEffect(fn)
  } else if (__DEV__ && !failSilently) {
    warn(
      `onEffectCleanup() was called when there was no active effect` +
        ` to associate with.`,
    )
  }
}

function cleanupEffect(fn: () => void) {
  // run cleanup without active effect
  const prevSub = setActiveSub()
  try {
    fn()
  } finally {
    setActiveSub(prevSub)
  }
}

// EFFECT ASYNC ------------------------------------------------------------------------------------------------------------------------

// Helpers -------------------------------------------------------------------------------------------------------
const getFirstKey = <K>(map: Map<K, any> | Set<K>) => map.keys().next().value

// Types ---------------------------------------------------------------------------------------------------------
export interface SubscriberAsync extends ReactiveNode {
  track(dep: ReactiveNode): any
  observedDeps?: Set<ReactiveNode>
}

export const enum RunInfoFlags {
  Aborted = 1 << 0,
  Ended = 1 << 1,
  RunningInitialSyncPart = 1 << 2,
  Restarted = 1 << 3, // aborted and restarted
}
type CleanupHandler = (hasAborted: Boolean) => any

export interface AsyncEffectHelperInterface {
  resume<X>(something: X): X
  hasChanged(
    branchID: String,
    yesBranchFunction: (helper: AsyncEffectHelperInterface) => any,
    onSkippedCallback?: (cache: any) => any,
  ): Promise<any>
  // aliases
  skippable: AsyncEffectHelperInterface['hasChanged']
  ifHasChanges: AsyncEffectHelperInterface['hasChanged']
  ifDirty: AsyncEffectHelperInterface['hasChanged']

  addCleanup(fn: CleanupHandler, isCleanupImmediate?: any): void
  addBranchCleanup(fn: CleanupHandler, isCleanupImmediate?: any): void
  cache: any
}
export type ListedDependencies =
  | ReactiveNode // ref
  | Ref
  | Array<ReactiveNode | Ref | [obj: Record<any, any>, prop: string]>
  | ((...any: any) => any)
export type ListedDependenciesWithOther =
  | ListedDependencies
  | 'other'
  | Array<ReactiveNode | 'other' | Ref | [obj: Record<any, any>, prop: string]>

type BranchInfo = {
  flags: BranchFlags
  ctx: any
  activeDeps: Set<ReactiveNode>
  collectingDeps: Set<ReactiveNode>
  currentNumVisits: number
  parentBranch: BranchInfo | undefined
  children: BranchInfo[]
  collectingChildren: BranchInfo[]
  deferredCleanups?: CleanupHandler[]
  ID?: string
}
export type AsyncEffectFunction = (
  effectHelper: AsyncEffectHelperInterface,
) => any
const enum BranchFlags {
  DIRTY = 1 << 0,
  RUNNING = 1 << 1,
  INACTIVE = 1 << 2,
}

// Globals ----------------------------------------------------------------------------------------------------------
let DepBranchMap: WeakMap<ReactiveNode, BranchInfo | BranchInfo[]> =
  new WeakMap() // used for dirtying branches

if (__DEV__) {
  var ReactiveEffectIdCtr = 0
}

// ------------------------------------------------------------------------------------------------------------------

export function observeDependenciesIn(
  dependencies: ListedDependencies,
): Set<ReactiveNode>
export function observeDependenciesIn(
  dependencies: ListedDependencies,
): [Set<ReactiveNode>, boolean]
export function observeDependenciesIn(dependencies: ListedDependencies): any {
  let observedDeps = (ObservingSubscriber.observedDeps = new Set())
  const prevEffect = setActiveSub(ObservingSubscriber)
  try {
    if (Array.isArray(dependencies)) {
      for (let i = 0; i < dependencies.length; i++) {
        let ref = dependencies[i]
        if (Array.isArray(ref)) {
          // reactive object
          let [obj, prop] = ref
          obj[prop]
        } else {
          // @ts-ignore
          ref.value
        }
      }
    } else if (typeof dependencies === 'function') {
      dependencies()
    } else if (dependencies instanceof Dep) {
      observedDeps.add(dependencies)
    } else {
      // @ts-ignore
      dependencies.value
    }
  } finally {
    setActiveSub(prevEffect)
    ObservingSubscriber.observedDeps = null
  }
  return observedDeps
}
const ObservingSubscriber = {
  flags: EffectFlags.ASYNC | EffectFlags.ObservingDep,
  observedDeps: null as Set<ReactiveNode> | null,
}
export class AsyncRunInfo {
  public runId?: number
  constructor(
    public promise: Promise<any>,
    public resolver: (result?: any) => void,
  ) {}
  collectedDeps: Set<ReactiveNode> = new Set()
  cleanups?: CleanupHandler[] = undefined
  deferredCleanups?: CleanupHandler[] = undefined
  flags: RunInfoFlags = RunInfoFlags.RunningInitialSyncPart
  lastTrackedDepLink?: Link = undefined
  visitedBranches?: BranchInfo[] = undefined
  immediateBranchCleanups?: Map<BranchInfo, CleanupHandler[]> = undefined
  deferredBranchCleanups?: Map<BranchInfo, CleanupHandler[]> = undefined
}
export class AsyncEffectHelper implements AsyncEffectHelperInterface {
  private _this?: AsyncEffectHelper
  private _cache?: any = undefined
  constructor(
    private runInfo: AsyncRunInfo,
    private effect: ReactiveEffectAsync,
    private branch?: BranchInfo | undefined,
    private prevBranch?: BranchInfo | undefined,
  ) {}

  public get cache(): string {
    return (this._cache ??= [])
  }
  public set cache(cache: string) {
    this._cache = cache
  }

  private thenHandlerBound: any
  private thenHandler(result: any) {
    let { effect, runInfo, branch, prevBranch } = this
    if (runInfo.flags & (RunInfoFlags.Aborted | RunInfoFlags.Ended)) {
      return new Promise(NOOP) // a never resolving promise stops the chain
    }
    let isLivetracking = effect.flags & EffectFlags.LIVETRACKING
    if (isLivetracking) {
      startTracking(effect, true)
    } else {
      setActiveSub(effect)
    }
    effect.activeRun = runInfo
    effect.activeBranch = branch
    return result
  }

  resume(): void
  resume<X>(something: X): X
  resume<X>(something?: X, id?: any): X | void {
    let { effect, runInfo, branch, prevBranch } = this

    let flags = effect.flags
    let isLivetracking = flags & EffectFlags.LIVETRACKING

    // To use Vue's slower isPromise() ?
    if (something instanceof Promise) {
      if (activeSub !== effect) {
        return something
      }
      if (isLivetracking) {
        endTracking(effect, undefined)
      } else {
        setActiveSub()
      }
      effect.activeRun = undefined // must come after endTracking
      effect.activeBranch = undefined
      let resumingPromise = something.then(
        this.thenHandlerBound ||
          (this.thenHandlerBound = this.thenHandler.bind(this)),
      ) as X
      return resumingPromise
    } else if (typeof something === 'function') {
      // callback
      return ((...args: any[]) => {
        if (runInfo.flags & (RunInfoFlags.Aborted | RunInfoFlags.Ended)) {
          return
        }
        if (activeSub === effect) {
          // already tracking, so this is not a task callback
          return something(...args)
        }
        const prevEffect = isLivetracking
          ? startTracking(effect, true)
          : setActiveSub(effect)
        effect.activeRun = runInfo
        effect.activeBranch = branch
        try {
          return something(...args)
        } finally {
          if (isLivetracking) endTracking(effect, prevEffect)
          else setActiveSub(prevEffect)
          effect.activeRun = undefined
          effect.activeBranch = undefined
        }
      }) as X
    }

    // x.resume() starts tracking again in case tracking was stopped
    if (activeSub !== effect) {
      if (isLivetracking) {
        startTracking(effect, true)
      } else {
        setActiveSub(effect)
      }
      effect.activeRun = runInfo
      effect.activeBranch = branch
    }
    return something
  }

  async hasChanged(
    branchID: string,
    yesBranchFunction: (helper: AsyncEffectHelperInterface) => any,
    onSkippedCallback?: (cache: any) => any,
  ): Promise<any> {
    var { effect, runInfo, branch } = this
    let flags = effect.flags
    if (!(flags & EffectFlags.EnabledManualBranching)) {
      return yesBranchFunction?.(this)
    }

    var hasChanges: any
    let branches: typeof effect.branches = effect.branches!
    let branchInfo = branches!.get(branchID)
    if (!branchInfo) {
      branchInfo = {
        flags: BranchFlags.DIRTY,
        ctx: undefined,
        activeDeps: new Set(),
        collectingDeps: new Set(),
        currentNumVisits: 0,
        parentBranch: branch,
        children: [], // children are always active children
        collectingChildren: [],
      }
      if (__DEV__) branchInfo.ID = branchID
      branches.set(branchID, branchInfo)
      hasChanges = true
    } else {
      hasChanges = branchInfo.flags & (BranchFlags.DIRTY | BranchFlags.RUNNING)
      branchInfo.parentBranch = branch // parent can differ from run to run
    }

    branch?.collectingChildren.push(branchInfo)

    if (hasChanges) {
      function onBranchEnd(branchInfo: BranchInfo, helper: any) {
        branchInfo.flags &= ~(BranchFlags.DIRTY | BranchFlags.RUNNING)
        branchInfo.ctx = helper._cache
        let activeDeps = branchInfo.activeDeps
        let collectedDeps = branchInfo.collectingDeps
        for (const dep of activeDeps) {
          if (!collectedDeps.has(dep)) {
            let depBranches = DepBranchMap.get(dep)!
            if (isArray(depBranches)) {
              remove(depBranches, branchInfo)
            } else {
              DepBranchMap.delete(dep)
            }
          }
        }
        branchInfo.activeDeps = collectedDeps
        branchInfo.collectingDeps = activeDeps

        let { children: prevChildren, collectingChildren: newChildren } =
          branchInfo
        branchInfo.children = newChildren
        branchInfo.collectingChildren = prevChildren
        let prevChildrenLength = prevChildren.length
        if (prevChildrenLength) {
          let childOffset = 0
          for (let i = 0; i < prevChildrenLength; ++i) {
            let prevChild = prevChildren[i]
            if (prevChild.currentNumVisits > 0) continue
            if (prevChild === newChildren[childOffset]) {
              ++childOffset
              continue
            }
            let isInList = newChildren.indexOf(prevChild, childOffset + 1) >= 0
            if (!isInList) {
              prevChild.parentBranch = undefined
            }
          }
        }

        // cleanup
        let branchClenupsImmediate =
          runInfo.immediateBranchCleanups?.get(branchInfo)
        if (branchClenupsImmediate) {
          _cleanup(branchClenupsImmediate)
        }
        let deferredBranchCleanups =
          runInfo.deferredBranchCleanups?.get(branchInfo)
        if (deferredBranchCleanups) {
          ;(branchInfo.deferredCleanups ??= []).push(...deferredBranchCleanups)
          deferredBranchCleanups.length = 0
        }
      }
      ++branchInfo.currentNumVisits
      runInfo.visitedBranches?.push(branchInfo)

      let result: any
      let prevBranch = effect.activeBranch
      effect.activeBranch = branchInfo
      branchInfo.flags |= BranchFlags.RUNNING
      let helper = Object.create((this._this ??= this))
      helper.thenHandlerBound = null
      helper.branch = branchInfo
      helper.prevBranch = prevBranch
      try {
        let deferredCleanups = branchInfo.deferredCleanups
        if (deferredCleanups?.length) _cleanup(deferredCleanups)
        result = yesBranchFunction(helper)
        if (result instanceof Promise) {
          await this.resume(result)
        }
        onBranchEnd(branchInfo, helper)
      } catch (err) {
        branchInfo.flags &= ~BranchFlags.RUNNING
        throw err
      } finally {
        effect.activeBranch = prevBranch
        branchInfo.collectingChildren.length = 0
        branchInfo.collectingDeps.clear()
      }
    } else {
      let isLivetracking = flags & EffectFlags.LIVETRACKING
      let collected = runInfo.collectedDeps

      function retrackBranchDepsAndMarkAsVisited(branchInfo: BranchInfo) {
        ++branchInfo.currentNumVisits
        runInfo.visitedBranches?.push(branchInfo)
        for (const dep of branchInfo.activeDeps) {
          if (isLivetracking && !collected.has(dep)) {
            link(dep, effect)
          }
          collected.add(dep) // must come after link()
        }
        for (const child of branchInfo.children) {
          retrackBranchDepsAndMarkAsVisited(child)
        }
      }

      retrackBranchDepsAndMarkAsVisited(branchInfo)
      if (onSkippedCallback) {
        onSkippedCallback(branchInfo.ctx)
      }
      await null
      this.resume()
    }
  }
  ifHasChanges!: typeof this.hasChanged
  ifDirty!: typeof this.hasChanged
  skippable!: typeof this.hasChanged

  addCleanup(fn: CleanupHandler, isCleanupImmediate?: any): void {
    let { effect, runInfo } = this
    if (activeSub !== effect || runInfo.flags & RunInfoFlags.Ended) {
      return
    }
    if (isCleanupImmediate) {
      ;(runInfo.cleanups ??= []).push(fn)
    } else {
      ;(runInfo.deferredCleanups ??= []).push(fn)
    }
  }
  addBranchCleanup(fn: CleanupHandler, isCleanupImmediate?: any): void {
    let { effect, runInfo } = this
    if (activeSub !== effect || runInfo.flags & RunInfoFlags.Ended) {
      return
    }
    var activeBranch = effect.activeBranch
    if (activeBranch && this.branch === activeBranch) {
      let map = (
        isCleanupImmediate
          ? (runInfo.immediateBranchCleanups ??= new Map())
          : (runInfo.deferredBranchCleanups ??= new Map())
      ) as Map<BranchInfo, CleanupHandler[]>
      let cleanups = map.get(activeBranch)
      if (cleanups) {
        cleanups.push(fn)
      } else {
        map.set(activeBranch, [fn])
      }
    }
  }
}
AsyncEffectHelper.prototype.ifHasChanges =
  AsyncEffectHelper.prototype.hasChanged
AsyncEffectHelper.prototype.ifDirty = AsyncEffectHelper.prototype.hasChanged
AsyncEffectHelper.prototype.skippable = AsyncEffectHelper.prototype.hasChanged

//   -------------------------------------------------------------------------------------------
export class ReactiveEffectAsync
  implements SubscriberAsync, ReactiveEffectOptions, ReactiveNode
{
  runs: Set<AsyncRunInfo> = new Set()
  activeRun?: AsyncRunInfo = undefined
  activeBranch?: BranchInfo = undefined
  maxConcurrentRuns: number = Infinity
  branches?: Map<string, BranchInfo> = undefined
  abortedRun?: AsyncRunInfo
  deferredCleanups?: CleanupHandler[]
  private runIdCtr?: number

  // whitelist / blacklist
  depConstraint?: WeakSet<ReactiveNode> = undefined

  /** deps-Head (Subscriber interface)
   * @internal
   */
  deps: Link | undefined = undefined
  depsTail: Link | undefined = undefined
  subs: Link | undefined = undefined
  subsTail: Link | undefined = undefined

  flags: ReactiveFlags =
    ReactiveFlags.Watching | ReactiveFlags.Dirty | EffectFlags.ASYNC
  onStop?: () => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void

  constructor(
    public fn: AsyncEffectFunction,
    initialFlags: number = 0,
  ) {
    if (activeEffectScope) {
      link(this, activeEffectScope)
    }

    // Flag corrections
    if (
      (initialFlags &
        (EffectFlags.REENTRANT | EffectFlags.AbortRunOnRetrigger)) ===
      (EffectFlags.AbortRunOnRetrigger | EffectFlags.REENTRANT)
    ) {
      initialFlags &= ~EffectFlags.REENTRANT
    }

    // init
    this.flags |= initialFlags
    if (this.flags & EffectFlags.EnabledManualBranching) {
      this.branches = new Map()
    }

    if (__DEV__ && activeSub) {
      warn(`watchEffectAsync() should never be used inside another effect `)
    }

    if (__DEV__) {
      this.runIdCtr = 0
      // @ts-ignore
      this.EffectID = ++ReactiveEffectIdCtr
      // @ts-ignore
      this.getDeps = () => {
        // @ts-ignore
        let d = this.deps
        let a = []
        let i = 0
        while (d) {
          if (++i > 200) {
            console.warn('possible linked list loop')
            break
          }
          a.push(d.dep)
          d = d.nextDep
        }
        return a
      }
      // @ts-ignore
      this.getDepLinks = () => {
        // @ts-ignore
        let d = this.deps
        let a = []
        let i = 0
        while (d) {
          if (++i > 200) {
            console.warn('possible dep linked list loop')
            break
          }
          a.push(
            // @ts-ignore
            `d:{id:${d.dep.DepID ?? d.dep.id ?? d.dep.ID}, k:${d.dep.key?.toString() || ''}}, linked:${d.tracking_Islinked}`,
          )
          d = d.nextDep
        }
        return a
      }
      // @ts-ignore
      this.getDepLinks2 = () => {
        // @ts-ignore
        let d = this.deps
        let a = []
        let i = 0
        while (d) {
          if (++i > 200) {
            console.warn('possible dep linked list loop')
            break
          }
          // @ts-ignore
          a.push(d)
          d = d.nextDep
        }
        return a
      }
      // @ts-ignore
      this.getDirtyBranches = () => {
        return this.branches
          ? [...this.branches]
              .filter(b => b[1].flags & BranchFlags.DIRTY)
              .map(b => b[0])
          : []
      }
      // @ts-ignore
      this.getBranchDeps = branchId => {
        return [...(this.branches?.get(branchId)?.activeDeps ?? [])]
      }
      // @ts-ignore
      this.getBranchChildrenIds = branchId => {
        return (this.branches?.get(branchId)?.children ?? []).map(c => c.ID)
      }
      // @ts-ignore
      this.getBranchInfos = () => {
        return [...(this.branches?.values() ?? [])].map(b => {
          // @ts-ignore
          return `${b.ID}: deps(${[...b.activeDeps].map(d => d.DepID ?? d.id).join(', ')}) children(${b.children.map(c => c.ID).join(', ')})`
        })
      }
    }
  }

  endRun(run: AsyncRunInfo, aborted?: Boolean, result?: any): void {
    if (run) {
      if (run.flags & RunInfoFlags.Ended) {
        return
      }
      let flags = this.flags
      let isScheduledReRunOnAbort
      let toRecurse = flags & EffectFlags.ScheduleRecursiveRerun
      if (aborted) {
        run.flags |= RunInfoFlags.Aborted
      }
      run.flags |= RunInfoFlags.Ended
      this.runs.delete(run)

      if (!this.runs.size) {
        this.flags &= ~EffectFlags.RUNNING
        if (!toRecurse && flags & EffectFlags.ScheduleRunAfterCurrentRun) {
          this.scheduleRun(false)
          const ScheduledNewRunOnAbort =
            EffectFlags.AbortRunOnRetrigger |
            EffectFlags.ScheduleRunAfterCurrentRun
          if (
            aborted &&
            (flags & ScheduledNewRunOnAbort) === ScheduledNewRunOnAbort
          ) {
            isScheduledReRunOnAbort = true
            this.abortedRun = run
          }
        }
      }
      if (!isScheduledReRunOnAbort) {
        run.resolver!(result)
      }

      let cleanupError1: any
      if (flags & EffectFlags.EnabledManualBranching) {
        // Branch dependencies
        for (const branchInfo of run.visitedBranches!) {
          --branchInfo.currentNumVisits
          if (aborted) {
            branchInfo.collectingDeps.clear()
            branchInfo.collectingChildren.length = 0
          }
          if (__DEV__ && branchInfo.currentNumVisits < 0) {
            throw new Error('branchInfo.currentNumVisits < 0')
          }
        }
        // Branch cleanups on abort
        if (aborted) {
          try {
            let immediate = run.immediateBranchCleanups
            let deferred = run.deferredBranchCleanups
            if (immediate || deferred) {
              for (const branchInfo of run.visitedBranches!) {
                immediate && _cleanup(immediate.get(branchInfo), aborted)
                deferred && _cleanup(deferred.get(branchInfo), aborted)
              }
            }
          } catch (error) {
            cleanupError1 = error
          }
        }
      }
      let cleanupError2: any
      try {
        _cleanup(run.cleanups, aborted)
        let deferred = run.deferredCleanups
        if (deferred?.length) {
          if (aborted || flags & EffectFlags.STOP) {
            _cleanup(deferred, aborted)
          } else {
            ;(this.deferredCleanups ??= []).push(...deferred)
          }
        }
      } catch (error) {
        cleanupError2 = error
      }

      if (cleanupError1) {
        throw cleanupError1 || cleanupError2
      }

      if (toRecurse) {
        this.flags &= ~(
          EffectFlags.ScheduleRunAfterCurrentRun |
          EffectFlags.ScheduleRecursiveRerun
        )
        this.run()
      } else {
        // unlink effect if no deps found so that it can be gc'd
        if (
          !this.deps &&
          !(flags & EffectFlags.ManualHandling) &&
          !this.runs.size &&
          !(this.flags & EffectFlags.IsScheduledRun)
        ) {
          this.stop()
        }
      }
    }
  }

  scheduleRun(toCheckIfDirty: any): void {
    if (this.flags & EffectFlags.IsScheduledRun) return
    this.flags |= EffectFlags.IsScheduledRun
    queueMicrotask(() => {
      this.flags &= ~(
        EffectFlags.ScheduleRunAfterCurrentRun |
        EffectFlags.IsScheduledRun |
        EffectFlags.ScheduleRecursiveRerun
      )
      let flags = this.flags
      if (
        !(flags & EffectFlags.STOP) &&
        (flags & EffectFlags.REENTRANT || !(flags & EffectFlags.RUNNING))
      ) {
        if (!toCheckIfDirty || this.dirty) {
          this.run()
        }
      }
    })
  }

  abortRunsIfWanted(eventFlag: number): Boolean {
    let flag_runningAbortOnEvent = EffectFlags.RUNNING | eventFlag
    if ((this.flags & flag_runningAbortOnEvent) === flag_runningAbortOnEvent) {
      for (const run of this.runs) {
        this.endRun(run, true)
      }
      return true
    }
    return false
  }
  abort(): void {
    this.flags &= ~(
      EffectFlags.ScheduleRunAfterCurrentRun |
      EffectFlags.ScheduleRecursiveRerun
    )
    this.abortRunsIfWanted(EffectFlags.RUNNING)
  }

  stop(): void {
    if (!(this.flags & EffectFlags.STOP)) {
      let depLink = this.deps
      while (depLink !== undefined) {
        depLink = unlink(depLink, this)
      }
      const sub = this.subs
      if (sub !== undefined) {
        unlink(sub)
      }
      this.flags |= EffectFlags.STOP
      this.abortRunsIfWanted(EffectFlags.AbortRunOnStop)
    }
  }

  pause(): void {
    this.flags |= EffectFlags.PAUSED
    this.abortRunsIfWanted(EffectFlags.AbortRunOnPause)
  }

  resume(): void {
    let flags = this.flags
    if (flags & EffectFlags.PAUSED) {
      this.flags &= ~EffectFlags.PAUSED
      if (flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) {
        this.notify()
      }
    }
  }
  get active(): boolean {
    return !(this.flags & EffectFlags.STOP)
  }

  private async _run(runInfo: AsyncRunInfo, rejecter: any): Promise<any> {
    let flags = this.flags
    let isLivetracking = flags & EffectFlags.LIVETRACKING
    let isReentrant = flags & EffectFlags.REENTRANT
    let prevEffect
    if (isLivetracking) {
      prevEffect = startTracking(this, true)
      flags = this.flags
    } else {
      prevEffect = setActiveSub(this)
      flags &= ~(
        ReactiveFlags.Recursed |
        ReactiveFlags.Dirty |
        ReactiveFlags.Pending
      )
    }
    flags |= EffectFlags.RUNNING
    this.flags = flags

    let effectHelper = new AsyncEffectHelper(runInfo, this)

    var numDepsCollected
    var result
    try {
      this.activeRun = runInfo
      this.activeBranch = undefined

      try {
        var resultPromise = this.fn(effectHelper)
      } finally {
        if (activeSub === this) {
          if (!isLivetracking) setActiveSub(prevEffect)
          else endTracking(this, prevEffect)
          this.activeRun = undefined // must come after endTracking
          this.activeBranch = undefined
        }
        runInfo.flags &= ~RunInfoFlags.RunningInitialSyncPart
      }
      if (runInfo.flags & RunInfoFlags.Aborted) {
        return
      }

      try {
        if (
          flags & EffectFlags.TriggerSynchronously &&
          !(resultPromise instanceof Promise)
        ) {
          result = resultPromise
        } else {
          result = await resultPromise
          if (runInfo.flags & RunInfoFlags.Aborted) {
            return
          }
        }
      } finally {
        if (activeSub === this) {
          if (!isLivetracking) setActiveSub()
          else endTracking(this, undefined)
        }
        this.activeRun = undefined
        this.activeBranch = undefined
      }

      // track and remove unused
      let collected = runInfo.collectedDeps
      numDepsCollected = collected.size
      if (numDepsCollected && !isLivetracking) {
        if (!(this.flags & EffectFlags.STOP)) {
          const prevEffect = startTracking(this)
          for (const dep of collected) {
            link(dep, this)
          }
          endTracking(this, prevEffect)
        }
      } else {
        // live tracking mode
        const lastTrackedDepLink = runInfo.lastTrackedDepLink
        this.depsTail = lastTrackedDepLink
        let toRemove =
          lastTrackedDepLink !== undefined
            ? lastTrackedDepLink.nextDep
            : this.deps

        let depLink = this.deps
        while (depLink) {
          depLink.tracking_Islinked = false
          depLink = depLink.nextDep
        }
        // Effect dependencies
        if (isReentrant) {
          // remove unused that are not in collectedDeps of any concurrent run
          while (toRemove !== undefined) {
            let isDepCollectedByARun = false
            const dep = toRemove.dep
            for (const run of this.runs) {
              if (run.collectedDeps.has(dep)) {
                isDepCollectedByARun = true
                break
              }
            }
            if (isDepCollectedByARun) {
              toRemove = toRemove.nextDep
            } else {
              toRemove = unlink(toRemove, this)
            }
          }
        } else {
          // just remove unused
          while (toRemove !== undefined) {
            toRemove = unlink(toRemove, this)
          }
        }
      }
    } catch (err) {
      rejecter(err)
      throw err
    } finally {
      this.endRun(runInfo, false, result)
    }
  }
  run(): Promise<any> {
    let { flags } = this
    if (
      this.runs.size >= this.maxConcurrentRuns ||
      (flags & EffectFlags.RUNNING && !(flags & EffectFlags.REENTRANT))
    ) {
      let firstRun = getFirstKey(this.runs)
      return firstRun!.promise!
    }
    if (
      flags & EffectFlags.STOP ||
      flags & EffectFlags.ScheduleRunAfterCurrentRun
    ) {
      return Promise.resolve()
    }

    let resolver: any
    let rejecter: any
    let runPromise
    let abortedRun = this.abortedRun
    if (abortedRun) {
      this.abortedRun = undefined
      resolver = abortedRun.resolver
      runPromise = abortedRun.promise
    } else {
      runPromise = new Promise(
        (resolve, reject) => ((resolver = resolve), (rejecter = reject)),
      )
    }

    let deferredCleanups = this.deferredCleanups
    if (deferredCleanups) {
      _cleanup(deferredCleanups, false)
    }

    let runInfo = new AsyncRunInfo(runPromise, resolver)
    if (__DEV__) {
      runInfo.runId = ++this.runIdCtr!
    }
    if (flags & EffectFlags.EnabledManualBranching) {
      runInfo.visitedBranches = []
    }

    if (abortedRun) {
      runInfo.flags |= RunInfoFlags.Restarted
    }
    this.runs.add(runInfo)
    this._run(runInfo, rejecter)
    return runPromise
  }

  /**
   * @internal
   */
  notify(dep?: ReactiveNode, usesCustomScheduler?: Boolean): any {
    let flags = this.flags
    if (flags & EffectFlags.PAUSED) {
      return
    }
    try {
      if (dep) {
        let running = flags & EffectFlags.RUNNING
        if (running) {
          const REENTRANT = flags & EffectFlags.REENTRANT
          if (!REENTRANT) {
            let firstRun = getFirstKey(this.runs)
            if (!firstRun!.collectedDeps.has(dep)) {
              // Do not notify if dep has not been collected yet
              return
            } else {
              // Dep has been collected. so an outdated version has been used.
            }
          }

          let activeRun = this.activeRun
          if (activeRun) {
            // notification was caused by this effect function
            let isRunningSyncPartAndRecursionIsAllowed =
              activeRun.flags & RunInfoFlags.RunningInitialSyncPart &&
              (flags &
                (EffectFlags.ALLOW_RECURSE |
                  EffectFlags.TriggerSynchronously)) ===
                (EffectFlags.ALLOW_RECURSE |
                  EffectFlags.TriggerSynchronously) &&
              !REENTRANT &&
              !(flags & EffectFlags.ScheduleRunAfterCurrentRun)
            if (isRunningSyncPartAndRecursionIsAllowed) {
              this.flags |= EffectFlags.ScheduleRecursiveRerun
              return
            } else {
              // changes to deps made by this effect-function do not re-trigger, unless it's sync recursion which must be explicitly allowed
              return
            }
          }
        }
      }
      return this.trigger(usesCustomScheduler)
    } finally {
      this.flags &= ~ReactiveFlags.Pending
    }
  }

  private trigger(usesCustomScheduler?: Boolean): any {
    let flags = this.flags
    if (this.dirty) {
      if (flags & EffectFlags.RUNNING && !(flags & EffectFlags.REENTRANT)) {
        this.flags |= EffectFlags.ScheduleRunAfterCurrentRun
        this.abortRunsIfWanted(EffectFlags.AbortRunOnRetrigger)
      } else if (!usesCustomScheduler) {
        if (flags & EffectFlags.TriggerSynchronously) {
          this.run()
        } else {
          this.scheduleRun(false)
        }
      }
      return true
    }
  }

  /**
   * @internal
   */
  track(dep: ReactiveNode): any {
    var { flags, depConstraint: constraint } = this
    if (flags & EffectFlags.STOP) {
      return false
    } else {
      var toTrack = true
      if (constraint) {
        if (flags & EffectFlags.DepConstraintIsBlacklist) {
          toTrack = !constraint.has(dep)
        } else {
          toTrack = constraint.has(dep)
        }
      }
      if (toTrack) {
        let collected = this.activeRun!.collectedDeps
        if (flags & EffectFlags.LIVETRACKING && !collected.has(dep)) {
          link(dep, this)
        }
        collected.add(dep)

        // branch dependencies
        let activeBranch = this.activeBranch
        if (activeBranch) {
          activeBranch.collectingDeps.add(dep)
          let depBranches = DepBranchMap.get(dep)
          if (!depBranches) {
            DepBranchMap.set(dep, activeBranch)
          } else {
            if (isArray(depBranches)) {
              if (depBranches.indexOf(activeBranch) >= 0)
                depBranches.push(activeBranch)
            } else if (depBranches !== activeBranch) {
              DepBranchMap.set(dep, [depBranches as BranchInfo, activeBranch])
            }
          }
        }
      }
      return toTrack
    }
  }

  get dirty(): boolean {
    const flags = this.flags
    if (flags & ReactiveFlags.Dirty) {
      return true
    }
    if (flags & ReactiveFlags.Pending) {
      if (checkDirty(this.deps!, this)) {
        this.flags = flags | ReactiveFlags.Dirty
        return true
      } else {
        this.flags = flags & ~ReactiveFlags.Pending
      }
    }
    return false
  }

  async awaitCompletion(toAwaitAll: any = false): Promise<any> {
    var result
    while (true) {
      if (this.flags & EffectFlags.IsScheduledRun) {
        await new Promise(r => queueMicrotask(r as any))
        continue
      }
      let num = this.runs.size
      if (!num) {
        return Promise.resolve(result)
      }
      if (num > 1) {
        if (toAwaitAll) {
          await Promise.all([...this.runs].map(x => x.promise))
        } else {
          return Promise.race([...this.runs].map(x => x.promise))
        }
      } else {
        result = await getFirstKey(this.runs)?.promise
      }
    }
  }

  setConstraint(
    dependencies?: ListedDependencies,
    isBlacklist: any = true,
  ): void {
    let depConstraint = dependencies
      ? observeDependenciesIn(dependencies)
      : null
    this.depConstraint = depConstraint?.size
      ? new WeakSet(depConstraint)
      : undefined
    if (isBlacklist) this.flags |= EffectFlags.DepConstraintIsBlacklist
  }

  clearDependencies(): void {
    if (this.flags & EffectFlags.RUNNING) {
      return
    }
    let depLink = this.deps
    while (depLink !== undefined) {
      depLink = unlink(depLink, this)
    }

    let branches = this.branches
    if (branches) {
      for (const b of branches.values()) {
        for (const d of b.activeDeps) {
          DepBranchMap.delete(d)
        }
        b.activeDeps.clear()
      }
    }
  }
}

function _cleanup(
  cleanups: CleanupHandler[] | undefined,
  aborted: any = false,
): void {
  if (cleanups?.length) {
    const prevSub = setActiveSub()
    try {
      let cleanup
      while ((cleanup = cleanups.pop())) {
        cleanup(aborted)
      }
    } finally {
      setActiveSub(prevSub)
    }
  }
}

export function setSubsDirtyOnBranchDepChange(dep: any): any {
  function setDirty(branchInfo?: BranchInfo) {
    while (branchInfo && !(branchInfo.flags & BranchFlags.DIRTY)) {
      branchInfo.flags |= BranchFlags.DIRTY
      branchInfo = branchInfo.parentBranch
    }
  }
  let depBranches: any = DepBranchMap.get(dep)
  if (depBranches) {
    if (isArray(depBranches)) {
      for (const depBranch of depBranches) {
        setDirty(depBranch)
      }
    } else {
      setDirty(depBranches)
    }
  }
}
