import { nextTick } from 'vue'
import {
  EffectScope,
  type Ref,
  WatchErrorCodes,
  type WatchOptions,
  computed,
  onWatcherCleanup,
  ref,
  watch,
  watchEffectAsyncLightest as watchEffectAsyncLight,
  reactive,
  EffectFlags,
  observeDependenciesIn,
  AsyncEffectHelperInterface,
  RunInfoFlags,
  ReactiveFlags2,
  ReactiveEffectAsync,
  WatchEffectAsyncOptionsLight,
  watchEffectLight,
} from '../src'

var sleep = (ms = 1) => new Promise(r => setTimeout(r, ms))
const getFirstKey = <K>(map: Map<K, any> | Set<K>) => map.keys().next().value
const areEqual = (a1: any[], a2: any[]) =>
  a1 && a1?.length === a2?.length && a1.every((x, i) => x === a2[i])

describe('watchEffectAsyncLight', () => {
  test('if sync mode works', () => {
    let dummy
    const obj = reactive({ prop: 'value', run: false })
    const v2 = ref(2)

    // Recursive triggering is only allowed if the flag TriggerSynchronously is set along with ALLOW_RECURSE
    // It's to mirror watchEffect behavior but it's not allowed otherwise
    let toRecurseInfinitely = false
    let numRuns = 0
    let hasRecursedInfinitely: Boolean = false
    const eSpy = vi.fn(() => {
      dummy = obj.run ? obj.prop : 'other'
      ++numRuns
      if (toRecurseInfinitely) {
        if (numRuns > 120) {
          hasRecursedInfinitely = true
          return
        }
        ++v2.value
      } else {
        v2.value
      }
    })

    var e = watchEffectAsyncLight(eSpy, {
      flags:
        EffectFlags.TriggerSynchronously | EffectFlags.EnabledManualBranching,
    })

    expect(dummy).toBe('other')
    expect(eSpy).toHaveBeenCalledTimes(1)
    obj.prop = 'Hi'
    expect(dummy).toBe('other')
    expect(eSpy).toHaveBeenCalledTimes(1)
    obj.run = true
    expect(dummy).toBe('Hi')
    expect(eSpy).toHaveBeenCalledTimes(2)
    obj.prop = 'World'
    expect(dummy).toBe('World')
    expect(eSpy).toHaveBeenCalledTimes(3)

    // recursive triggering
    e.flags |= EffectFlags.ALLOW_RECURSE
    assert(hasRecursedInfinitely === false, 'hasRecursedInfinitely')
    ++v2.value
    assert(hasRecursedInfinitely === false, 'hasRecursedInfinitely')
    toRecurseInfinitely = true
    ++v2.value
    assert(hasRecursedInfinitely === true, 'hasRecursedInfinitely')
  })

  test.each([
    { label: 'not reentrant, not livetracking', flags: 0 },
    { label: 'reentrant, not livetracking', flags: EffectFlags.REENTRANT },
    { label: 'not reentrant, livetracking', flags: EffectFlags.LIVETRACKING },
    {
      label: 'reentrant, livetracking',
      flags: EffectFlags.REENTRANT | EffectFlags.LIVETRACKING,
    },
    {
      label: 'reentrant, livetracking, EnabledManualBranching',
      flags:
        EffectFlags.REENTRANT |
        EffectFlags.LIVETRACKING |
        EffectFlags.EnabledManualBranching,
    },
    {
      label: 'not reentrant, not livetracking, EnabledManualBranching',
      flags: EffectFlags.EnabledManualBranching,
    },
  ])('if async mode works ($label)', async ({ label, flags }) => {
    expect(__DEV__).toBe(true)
    const LIVETRACKING = flags & EffectFlags.LIVETRACKING
    const REENTRANT = flags & EffectFlags.REENTRANT

    const obj = reactive({ prop: 'value', run: <any>false })
    const v2 = ref(2)
    // @ts-ignore
    v2.id = 'v2'
    const v3 = ref(3)
    // @ts-ignore
    v3.id = 'v3'
    const v4 = ref(4)
    // @ts-ignore
    v4.id = 'v4'
    const v5 = ref(6)
    // @ts-ignore
    v5.id = 'v5'

    const eSpy = vi.fn(async (x: AsyncEffectHelperInterface) => {
      let dummy = obj.run ? obj.prop : 'other'
      await x.resume(sleep(1))
      ++v2.value
      await x.resume(sleep(1))
      if (v3.value > 10) {
        v4.value
      } else {
        v5.value
      }
    })

    var e = watchEffectAsyncLight(eSpy, {
      flags: flags,
    })

    expect(eSpy).toHaveBeenCalledTimes(1)
    await nextTick()
    expect(eSpy).toHaveBeenCalledTimes(1)
    expect(e.runs.size).toBe(1)
    if (LIVETRACKING) {
      // @ts-ignore
      expect(e.getDeps().length).toBe(1)
    } else {
      // @ts-ignore
      expect(e.getDeps().length).toBe(0)
    }
    await e.awaitCompletion()
    expect(e.runs.size).toBe(0)
    expect(eSpy).toHaveBeenCalledTimes(1)
    // @ts-ignore
    let deps = e.getDeps()
    let expectedDeps = [
      ...observeDependenciesIn(() => {
        ;(obj.run, v2.value, v3.value, v5.value)
      }),
    ]
    expect(deps).toEqual(expectedDeps)
    obj.run = null
    expect(e.flags & EffectFlags.IsScheduledRun).toBe(
      EffectFlags.IsScheduledRun,
    )
    expect(e.runs.size).toBe(0)
    v3.value = 5
    expect(e.runs.size).toBe(0)
    await nextTick()
    expect(e.runs.size).toBe(1)
    await e.awaitCompletion()
    expect(e.runs.size).toBe(0)
    // @ts-ignore
    deps = e.getDeps()
    expect(deps).toEqual(expectedDeps)

    // @ts-ignore
    var v5_subs = v5.getSubs()
    expect(v5_subs.length).toBe(1)
    expect(v5_subs[0]).toBe(e)

    v3.value = 20
    obj.run = true
    await e.awaitCompletion()
    // @ts-ignore
    deps = e.getDeps()
    let expectedDeps2 = [
      ...observeDependenciesIn(() => {
        ;(obj.run, obj.prop, v2.value, v3.value, v4.value)
      }),
    ]
    expect(deps).toEqual(expectedDeps2)
    eSpy.mockClear()
    // @ts-ignore
    var v5_subs = v5.getSubs()
    expect(v5_subs.length).toBe(0)
    v5.value
    expect(e.flags & EffectFlags.IsScheduledRun).toBe(0)
    await nextTick()
    expect(eSpy).toHaveBeenCalledTimes(0)

    e.pause()
    ++v3.value
    ++v4.value
    expect(e.flags & EffectFlags.IsScheduledRun).toBe(0)
    await nextTick()
    expect(eSpy).toHaveBeenCalledTimes(0)

    e.resume()
    expect(e.flags & EffectFlags.IsScheduledRun).toBe(
      EffectFlags.IsScheduledRun,
    )
    await nextTick()
    expect(eSpy).toHaveBeenCalledTimes(1)
    await e.awaitCompletion()

    if (REENTRANT) {
      ++v2.value
      expect(e.flags & EffectFlags.IsScheduledRun).toBe(
        EffectFlags.IsScheduledRun,
      )
      await nextTick()
      expect(e.runs.size).toBe(1)
      expect(e.flags & EffectFlags.IsScheduledRun).toBe(0)

      ++v3.value
      expect(e.flags & EffectFlags.IsScheduledRun).toBe(
        EffectFlags.IsScheduledRun,
      )
      await nextTick()
      expect(e.runs.size).toBe(2)
      expect(e.flags & EffectFlags.IsScheduledRun).toBe(0)
      await e.awaitCompletion(true)
      expect(e.runs.size).toBe(0)
    }

    e.stop()
    // @ts-ignore
    expect(areEqual(e.getDeps(), [])).toBe(true)
    // @ts-ignore
    let allUnlinked = expectedDeps2.every(d => d.getSubs().length == 0)
    expect(allUnlinked).toBe(true)
  })

  test.each([
    { label: 'not reentrant, not livetracking', flags: 0 },
    { label: 'reentrant, not livetracking', flags: EffectFlags.REENTRANT },
    { label: 'not reentrant, livetracking', flags: EffectFlags.LIVETRACKING },
    {
      label: 'reentrant, livetracking',
      flags: EffectFlags.REENTRANT | EffectFlags.LIVETRACKING,
    },
    {
      label: 'reentrant, livetracking, EnabledManualBranching',
      flags:
        EffectFlags.REENTRANT |
        EffectFlags.LIVETRACKING |
        EffectFlags.EnabledManualBranching,
    },
    {
      label: 'not reentrant, not livetracking, EnabledManualBranching',
      flags: EffectFlags.EnabledManualBranching,
    },
    {
      label: 'not reentrant, not livetracking, EnabledManualBranching',
      flags: EffectFlags.EnabledManualBranching,
    },
    // Auto Aborts
    {
      label:
        'Aoto-abort, not reentrant, not livetracking, EnabledManualBranching',
      flags:
        EffectFlags.AbortRunOnPause |
        EffectFlags.AbortRunOnStop |
        EffectFlags.AbortRunOnRetrigger |
        EffectFlags.EnabledManualBranching,
    },
    {
      label: 'Aoto-abort, reentrant, not livetracking, EnabledManualBranching',
      flags:
        EffectFlags.AbortRunOnPause |
        EffectFlags.AbortRunOnStop |
        EffectFlags.AbortRunOnRetrigger |
        EffectFlags.REENTRANT |
        EffectFlags.EnabledManualBranching,
    },
    {
      label: 'Aoto-abort, reentrant, livetracking, EnabledManualBranching',
      flags:
        EffectFlags.AbortRunOnPause |
        EffectFlags.AbortRunOnStop |
        EffectFlags.AbortRunOnRetrigger |
        EffectFlags.REENTRANT |
        EffectFlags.LIVETRACKING |
        EffectFlags.EnabledManualBranching,
    },
  ])('abortions ($label)', async ({ label, flags }) => {
    expect(__DEV__).toBe(true)
    let REENTRANT = flags & EffectFlags.REENTRANT
    const AbortRunOnRetrigger = flags & EffectFlags.AbortRunOnRetrigger

    var n1, n2, n3, n4, n5
    n1 = n2 = n3 = n4 = n5 = 0

    const v2 = ref(2)
    // @ts-ignore
    v2.id = 'v2'
    const v3 = ref(3)
    // @ts-ignore
    v3.id = 'v3'
    const v4 = ref(4)
    // @ts-ignore
    v4.id = 'v4'
    const v5 = ref(6)
    // @ts-ignore
    v5.id = 'v5'

    const eSpy = vi.fn(async (x: AsyncEffectHelperInterface) => {
      n1 = n2 = n3 = n4 = n5 = 0
      ++v2.value
      n1 = 1
      await x.resume(sleep(50))
      ++v3.value
      n2 = 1
      await x.resume(sleep(50))
      ++v4.value
      n3 = 1
      await x.resume(sleep(50))
      n4 = 1
      return sleep(50).then(
        x.resume(() => {
          n5 = 1
          ++v5.value
        }),
      )
    })

    var e = watchEffectAsyncLight(eSpy, {
      flags: flags,
    })
    e.maxConcurrentRuns = 3

    // verify flag auto-correction
    if (REENTRANT && AbortRunOnRetrigger) {
      expect(
        e.flags & (EffectFlags.REENTRANT | EffectFlags.AbortRunOnRetrigger),
        'REENTRANT is ignored if AbortRunOnRetrigger',
      ).toBe(EffectFlags.AbortRunOnRetrigger)
      REENTRANT = 0
    }

    expect(eSpy).toHaveBeenCalledTimes(1)
    await nextTick()
    expect(eSpy).toHaveBeenCalledTimes(1)
    expect(e.runs.size).toBe(1)
    await e.awaitCompletion(true)
    expect(n1 + n2 + n3 + n4 + n5).toBe(5)
    // @ts-ignore
    var deps = e.getDeps()
    let expectedDeps2 = [...observeDependenciesIn([v2, v3, v4, v5])]
    expect(deps).toEqual(expectedDeps2)

    ++v5.value
    await sleep(2)
    await e.awaitCompletion(true)
    expect(e.runs.size).toBe(0)

    // manual abort
    ++v5.value
    await sleep(2)
    expect(e.runs.size).toBe(1)
    ++v5.value
    if (REENTRANT) {
      expect(
        e.flags &
          (EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
      ).toBe(EffectFlags.IsScheduledRun)
    } else {
      expect(
        e.flags &
          (EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
      ).toBe(0) // not collected yet so no re-trigger if AbortRunOnRetrigger
    }
    await sleep(111)
    expect(e.runs.size).toBe(REENTRANT ? 2 : 1)
    e.abort()
    expect(e.runs.size).toBe(0)
    await sleep(100)
    expect(n1 == 1 && n2 == 1 && n3 == 1 && n4 == 0 && n5 == 0).toBe(true)

    // then() handler aborted
    ++v2.value
    await sleep(1)
    expect(e.runs.size).toBe(1)
    await sleep(180)
    expect(n1 == 1 && n2 == 1 && n3 == 1 && n4 == 1 && n5 == 0).toBe(true)
    expect(e.runs.size).toBe(1)
    e.abort()
    expect(e.runs.size).toBe(0)
    await sleep(100)
    expect(n5 == 0).toBe(true)

    // auto abort
    ++v2.value
    await sleep(1)
    expect(e.runs.size).toBe(1)
    let run = getFirstKey(e.runs)!
    ++v2.value
    if (REENTRANT) {
      if (AbortRunOnRetrigger) {
        assert.fail('REENTRANT + AbortRunOnRetrigger')
      } else {
        expect(
          e.flags &
            (EffectFlags.IsScheduledRun |
              EffectFlags.ScheduleRunAfterCurrentRun),
        ).toBe(EffectFlags.IsScheduledRun)
        expect(run.flags & RunInfoFlags.Aborted).toBe(0)
        await sleep(1)
        expect(e.runs.size).toBe(2)
        ++v2.value
        await sleep(1)
        expect(e.runs.size).toBe(3)
        ++v2.value
        await sleep(1)
        expect(e.maxConcurrentRuns).toBe(3)
        expect(e.runs.size, 'respects maxConcurrentRuns').toBe(3)
      }
    } else {
      if (AbortRunOnRetrigger) {
        expect(
          e.flags &
            (EffectFlags.IsScheduledRun |
              EffectFlags.ScheduleRunAfterCurrentRun),
        ).toBe(
          EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun,
        )
        expect(e.runs.size).toBe(0)
        expect(!!e.abortedRun).toBe(true)
        expect(run.flags & RunInfoFlags.Aborted).toBe(RunInfoFlags.Aborted)
        await nextTick()
        expect(e.runs.size).toBe(1)
        expect(!!e.abortedRun).toBe(false)
        let runNew = getFirstKey(e.runs)!
        expect(runNew).not.toBe(run)
        expect(runNew.promise).toBe(run.promise)
        expect(runNew.flags & RunInfoFlags.Restarted).toBe(
          RunInfoFlags.Restarted,
        )
        expect(
          runNew.collectedDeps.size == 1 &&
            getFirstKey(runNew.collectedDeps) === (v2 as any),
        ).toBe(true)

        ++v2.value
        await nextTick()
        let runNew2 = getFirstKey(e.runs)!
        expect(
          runNew2 &&
            runNew2 !== runNew &&
            (runNew.flags & RunInfoFlags.Restarted) == RunInfoFlags.Restarted,
        ).toBe(true)
        ++v5.value
        expect(
          e.flags &
            (EffectFlags.IsScheduledRun |
              EffectFlags.ScheduleRunAfterCurrentRun),
          'v5 should not retrigger because not collected',
        ).toBe(0)
        expect(runNew2.flags & RunInfoFlags.Aborted).toBe(0)
      } else {
        expect(
          e.flags &
            (EffectFlags.IsScheduledRun |
              EffectFlags.ScheduleRunAfterCurrentRun),
        ).toBe(EffectFlags.ScheduleRunAfterCurrentRun)
        await sleep(1)
        let run2 = getFirstKey(e.runs)
        expect(run2).toBe(run)
      }
    }

    await e.awaitCompletion(true)
    expect(e.runs.size).toBe(0)
    expect(!!e.abortedRun).toBe(false)
    expect(
      e.flags &
        (EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
    ).toBe(0)
  })

  test.each([
    { label: 'not reentrant, not livetracking', flags: 0 },
    { label: 'reentrant, not livetracking', flags: EffectFlags.REENTRANT },
    { label: 'not reentrant, livetracking', flags: EffectFlags.LIVETRACKING },
    {
      label: 'reentrant, livetracking',
      flags: EffectFlags.REENTRANT | EffectFlags.LIVETRACKING,
    },
    // Auto Aborts
    {
      label:
        'Aoto-abort, not reentrant, not livetracking, EnabledManualBranching',
      flags:
        EffectFlags.AbortRunOnPause |
        EffectFlags.AbortRunOnStop |
        EffectFlags.AbortRunOnRetrigger |
        EffectFlags.EnabledManualBranching,
    },
    {
      label: 'Aoto-abort, reentrant, not livetracking, EnabledManualBranching',
      flags:
        EffectFlags.AbortRunOnPause |
        EffectFlags.AbortRunOnStop |
        EffectFlags.AbortRunOnRetrigger |
        EffectFlags.REENTRANT |
        EffectFlags.EnabledManualBranching,
    },
    {
      label: 'Aoto-abort, reentrant, livetracking, EnabledManualBranching',
      flags:
        EffectFlags.AbortRunOnPause |
        EffectFlags.AbortRunOnStop |
        EffectFlags.AbortRunOnRetrigger |
        EffectFlags.REENTRANT |
        EffectFlags.LIVETRACKING |
        EffectFlags.EnabledManualBranching,
    },
  ])('branching ($label)', async ({ label, flags }) => {
    expect(__DEV__).toBe(true)
    let REENTRANT = flags & EffectFlags.REENTRANT
    const AbortRunOnRetrigger = flags & EffectFlags.AbortRunOnRetrigger

    var n1, n2, n3, n4, n5
    n1 = n2 = n3 = n4 = n5 = 0

    var n1_inner, n2_inner, n3_inner, n4_inner, n5_inner
    n1_inner = n2_inner = n3_inner = n4_inner = n5_inner = 0

    const v2 = ref(2)
    // @ts-ignore
    v2.id = 'v2'
    const v3 = ref(3)
    // @ts-ignore
    v3.id = 'v3'
    const v4 = ref(4)
    // @ts-ignore
    v4.id = 'v4'
    const v5 = ref(5)
    // @ts-ignore
    v5.id = 'v5'
    const v6 = ref(6)
    // @ts-ignore
    v6.id = 'v6'

    const v7 = ref(2)
    // @ts-ignore
    v7.id = 'v7'
    const v8 = ref(3)
    // @ts-ignore
    v8.id = 'v8'
    const v9 = ref(9)
    // @ts-ignore
    v9.id = 'v9'
    const v10 = ref(10)
    // @ts-ignore
    v10.id = 'v10'
    const v11 = ref(11)
    // @ts-ignore
    v11.id = 'v11'

    const db: any = { 1: 1, 2: 2, 3: 3, 4: 4 }
    const param = ref(1)
    // @ts-ignore
    param.id = 'param'
    var doWork = (x: any): any => db[x]
    var toChangeV3_1 = false
    var toThrow = false
    var wasRun_0 = 0,
      wasRun_1 = 0,
      wasRun_2 = 0,
      wasRun_3 = 0
    var enableBranchLoop = 0,
      numTimesLoopedBranchWasRun = 0,
      numTimesLoopedBranchWasSkipped = 0,
      enableChangeLoopBranchDepsFromOutside = 0

    async function innerWork(p: any, x: AsyncEffectHelperInterface) {
      n1_inner = 1

      var res1: any
      // synchronous
      x.skippable(
        '_1_',
        x => {
          wasRun_1 = 1
          if (v2.value > 10) {
            res1 = x.cache[0] = doWork(v4.value)
          } else {
            res1 = x.cache[0] = 'xx'
          }
        },
        (cache: any) => {
          res1 = cache[0]
        },
      )

      var res2: any
      var res3: any
      // asynchronous, async cb needed
      await x.hasChanged(
        '_2_',
        async x => {
          wasRun_2 = 1
          if (v3.value > 10) {
            if (toChangeV3_1) {
              ++v3.value
            }
            if (startTime) {
              // console.log(-startTime + performance.now())
            }
            await x.resume(sleep(10))
            n2_inner = 1
            if (startTime) {
              // console.log(-startTime + performance.now())
            }

            await x.hasChanged(
              '_3_',
              async x => {
                wasRun_3 = 1
                res3 = x.cache[0] = v5.value + 'zz'
                if (toThrow) {
                  throw 'myLovelyError'
                }
                await x.hasChanged('_4_', async x => {
                  v10.value
                  if (enableBranchLoop) {
                    for (var i = 0; i < 10; i++) {
                      x.hasChanged(
                        '_Looped_',
                        x => {
                          ++v11.value
                          ++numTimesLoopedBranchWasRun
                        },
                        () => {
                          ++numTimesLoopedBranchWasSkipped
                        },
                      )
                      if (enableChangeLoopBranchDepsFromOutside) {
                        if (i < 3) {
                          ++v11.value
                        }
                      }
                    }
                  }
                })
              },
              (cache: any) => {
                res3 = cache[0]
              },
            )

            await x.resume(sleep(70))
            n3_inner = 1

            res2 = x.cache[0] = res3 + '!'
          } else {
            res2 = x.cache[0] = 'yy'
          }
        },
        (cache: any) => {
          res2 = cache[0]
        },
      )

      return [res1, res2, res3]
    }

    var sleep1Multiplyer: any = 1
    var final_result: any
    const eSpy = vi.fn(async (x: AsyncEffectHelperInterface) => {
      wasRun_0 = wasRun_1 = wasRun_2 = wasRun_3 = 0
      n1 = n2 = n3 = n4 = n5 = 0
      n1_inner = n2_inner = n3_inner = n4_inner = n5_inner = 0
      final_result = 0

      ++v7.value
      n1 = 1
      await x.resume(sleep(10 * sleep1Multiplyer))
      ++v8.value
      n2 = 1
      var res: any

      await x.hasChanged(
        '_0_',
        async x => {
          wasRun_0 = 1
          let innerPromise = innerWork(param.value, x)
          res = x.cache = await x.resume(innerPromise)
        },
        (cache: any) => {
          res = cache
        },
      )

      n3 = 1
      return sleep(10).then(
        x.resume(() => {
          n4 = 1
          ++v9.value
          final_result = res
          runPromiseResolver?.()
        }),
      )
    })

    var e = watchEffectAsyncLight(eSpy, {
      flags: flags | EffectFlags.EnabledManualBranching,
    })
    REENTRANT = e.flags & EffectFlags.REENTRANT
    e.maxConcurrentRuns = 3

    // Tests
    await e.awaitCompletion(true)
    expect(eSpy).toHaveBeenCalledTimes(1)
    expect(e.runs.size).toBe(0)
    expect(n1 + n2 + n3 + n4).toBe(4)
    expect(n1_inner + n2_inner + n3_inner).toBe(1)
    var verifyDepsAndBranches_1 = () => {
      // @ts-ignore
      expect(areEqual(e.getDeps(), [v7, v8, param, v2, v3, v9])).toBe(true)
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_0_'), [param])).toBe(true)
      // @ts-ignore
      expect(e.getBranchChildrenIds('_0_')).toEqual(['_1_', '_2_'])
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_1_'), [v2])).toBe(true)
      // @ts-ignore
      expect(e.getBranchChildrenIds('_1_')).toEqual([])
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_2_'), [v3])).toBe(true)
      // @ts-ignore
      expect(e.getBranchChildrenIds('_2_')).toEqual([])
      expect(e.branches!.get('_3_')).toBe(undefined)
    }
    verifyDepsAndBranches_1()
    expect(wasRun_0 + wasRun_1 + wasRun_2).toBe(3)
    expect(wasRun_3).toBe(0)
    expect(final_result).toEqual(['xx', 'yy', undefined])

    //   skips unchanged parts and re-tracks their deps
    ++param.value
    // @ts-ignore
    expect(e.getDirtyBranches()).toEqual(['_0_'])
    await e.awaitCompletion(true)
    expect(eSpy).toHaveBeenCalledTimes(2)
    // @ts-ignore
    var deps1 = e.getDeps()
    expect(wasRun_0).toBe(1)
    expect(wasRun_1 + wasRun_2 + wasRun_3).toBe(0)
    expect(final_result).toEqual(['xx', 'yy', undefined])
    verifyDepsAndBranches_1()

    ++v7.value
    // @ts-ignore
    expect(e.getDirtyBranches()).toEqual([])
    await e.awaitCompletion(true)
    expect(eSpy).toHaveBeenCalledTimes(3)
    // @ts-ignore
    expect(wasRun_0 + wasRun_1 + wasRun_2 + wasRun_3).toBe(0)
    expect(final_result).toEqual(['xx', 'yy', undefined])
    verifyDepsAndBranches_1()

    v2.value = 20
    await e.awaitCompletion(true)
    expect(final_result).toEqual([4, 'yy', undefined])
    var verifyDepsAndBranches_2 = () => {
      // @ts-ignore
      expect(areEqual(e.getDeps(), [v7, v8, param, v2, v4, v3, v9])).toBe(true)
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_0_'), [param])).toBe(true)
      // @ts-ignore
      expect(e.getBranchChildrenIds('_0_')).toEqual(['_1_', '_2_'])
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_1_'), [v2, v4])).toBe(true)
      // @ts-ignore
      expect(e.getBranchChildrenIds('_1_')).toEqual([])
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_2_'), [v3])).toBe(true)
      // @ts-ignore
      expect(e.getBranchChildrenIds('_2_')).toEqual([])
      expect(e.branches!.get('_3_')).toBe(undefined)
    }
    verifyDepsAndBranches_2()

    v3.value = 30
    // @ts-ignore
    expect(e.getDirtyBranches()).toEqual(['_0_', '_2_'])
    await e.awaitCompletion(true)
    // @ts-ignore
    expect(wasRun_0 + wasRun_2 + wasRun_3).toBe(3)
    expect(wasRun_1).toBe(0)
    var verifyDepsAndBranches_3 = () => {
      expect(
        // @ts-ignore
        areEqual(e.getDeps(), [v7, v8, param, v2, v4, v3, v5, v10, v9]),
      ).toBe(true)
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_0_'), [param])).toBe(true)
      // @ts-ignore
      expect(e.getBranchChildrenIds('_0_')).toEqual(['_1_', '_2_'])
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_1_'), [v2, v4])).toBe(true)
      // @ts-ignore
      expect(e.getBranchChildrenIds('_1_')).toEqual([])
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_2_'), [v3])).toBe(true)
      // @ts-ignore
      expect(e.getBranchChildrenIds('_2_')).toEqual(['_3_'])
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_3_'), [v5])).toBe(true)
      // @ts-ignore
      expect(e.getBranchChildrenIds('_3_')).toEqual(['_4_'])
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_4_'), [v10])).toBe(true)
      // @ts-ignore
      expect(e.getBranchChildrenIds('_4_')).toEqual([])
    }
    verifyDepsAndBranches_3()
    expect(final_result).toEqual([4, '5zz!', '5zz'])

    ++v5.value
    await e.awaitCompletion(true)
    expect(final_result).toEqual([4, '6zz!', '6zz'])

    // dep unlinking
    v3.value = 3
    v2.value = 2
    await e.awaitCompletion(true)
    var verifyDepsAndBranches_4 = () => {
      // @ts-ignore
      expect(areEqual(e.getDeps(), [v7, v8, param, v2, v3, v9])).toBe(true)
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_0_'), [param])).toBe(true)
      // @ts-ignore
      expect(e.getBranchChildrenIds('_0_')).toEqual(['_1_', '_2_'])
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_1_'), [v2])).toBe(true)
      // @ts-ignore
      expect(e.getBranchChildrenIds('_1_')).toEqual([])
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_2_'), [v3])).toBe(true)
      expect(
        // @ts-ignore
        e.getBranchChildrenIds('_2_'),
        'unvisited children of visited branches should not be listed',
      ).toEqual([])
      expect(
        // @ts-ignore
        areEqual(e.getBranchDeps('_3_'), [v5]),
        'depencendies of unvisited branches should be retained',
      ).toBe(true)
      expect(e.branches!.get('_3_')).not.toBe(undefined)
      expect(
        // @ts-ignore
        e.getBranchChildrenIds('_3_'),
        'children of unvisited branches should be retained',
      ).toEqual(['_4_'])
      // @ts-ignore
      expect(areEqual(e.getBranchDeps('_4_'), [v10])).toBe(true)
    }
    verifyDepsAndBranches_4()

    eSpy.mockClear()
    // @ts-ignore
    expect(v4.subs).toBe(undefined)
    ++v4.value
    // @ts-ignore
    expect(e.getDirtyBranches()).toEqual([])
    ++v5.value
    expect(
      // @ts-ignore
      e.getDirtyBranches(),
      'unvisited branches should be dirtied by their deps, but they should not dirty visited branches',
    ).toEqual(['_3_'])
    await e.awaitCompletion(true)
    expect(
      eSpy,
      'deps of unvisited branches should not trigger',
    ).toHaveBeenCalledTimes(0)

    // many changes
    v3.value = 30
    v2.value = 20
    ++param.value
    ++v9.value
    ++v7.value
    ++v7.value
    // @ts-ignore
    expect(e.getDirtyBranches()).toEqual(['_0_', '_1_', '_2_', '_3_'])
    await e.awaitCompletion(true)
    expect(eSpy).toHaveBeenCalledTimes(1)
    expect(
      // @ts-ignore
      areEqual(e.getDeps(), [v7, v8, param, v2, v4, v3, v5, v10, v9]),
    ).toBe(true)
    verifyDepsAndBranches_3()

    // exception detection
    toThrow = true
    ++v5.value
    // @ts-ignore
    expect(e.getDirtyBranches(), 're-linked v5 should trigger').toEqual([
      '_0_',
      '_2_',
      '_3_',
    ])
    await expect(e.awaitCompletion(true)).rejects.toThrow()
    expect(e.runs.size).toBe(0)
    toThrow = false

    // abortion
    ++v5.value
    await e.awaitCompletion(true)
    expect(n1_inner + n2_inner + n3_inner).toBe(3)
    ++v5.value
    var startTime = performance.now()
    await sleep(70)
    expect(e.runs.size).toBe(1)
    e.abort()
    expect(e.runs.size).toBe(0)
    expect(n1_inner + n2_inner).toBe(2)
    expect(n3_inner).toBe(0)

    // self changes do not re-trigger (except sync recursion if wanted)
    eSpy.mockClear()
    toChangeV3_1 = true
    ++v5.value
    await sleep(27)
    expect(e.runs.size).toBe(1)
    expect(
      e.flags &
        (EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
    ).toBe(0)
    await e.awaitCompletion(true)
    await sleep(1)
    expect(e.runs.size).toBe(0)
    expect(eSpy).toHaveBeenCalledTimes(1)

    // outside changes do re-trigger
    eSpy.mockClear()
    ++v5.value
    await sleep(27)
    var run1 = getFirstKey(e.runs)!
    // except for not yet collected deps - they do not re-trigger - but only if not reentrant
    expect(run1.collectedDeps.has(v9 as any)).toBe(false)
    ++v9.value
    if (REENTRANT) {
      expect(
        e.flags &
          (EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
      ).toBe(EffectFlags.IsScheduledRun)
      await nextTick()
      expect(e.runs.size).toBe(2)
    } else {
      expect(
        e.flags &
          (EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
      ).toBe(0)
      await nextTick()
      expect(e.runs.size).toBe(1)
      let run2 = getFirstKey(e.runs)!
      expect(run1 === run2).toBe(true)
    }
    await e.awaitCompletion(true)

    sleep1Multiplyer = 10 // to make the timing error margins smaller
    ++v5.value
    await sleep(27)
    sleep1Multiplyer = 1
    var run1 = getFirstKey(e.runs)!
    // collected deps do re-trigger
    expect(run1.collectedDeps.has(v7 as any)).toBe(true)
    ++v7.value
    expect(e.flags & ReactiveFlags2.Dirty).toBe(ReactiveFlags2.Dirty)
    await nextTick()
    var run2 = getFirstKey(e.runs)!
    if (REENTRANT) {
      expect(e.runs.size).toBe(2)
    } else {
      expect(e.runs.size).toBe(1)
      if (AbortRunOnRetrigger) {
        expect(run1 === run2).toBe(false)
        expect(run1.flags & RunInfoFlags.Aborted).toBe(RunInfoFlags.Aborted)
        expect(run2.flags & RunInfoFlags.Restarted).toBe(RunInfoFlags.Restarted)
      } else {
        expect(run1 === run2).toBe(true)
        expect(e.flags & EffectFlags.ScheduleRunAfterCurrentRun).toBe(
          EffectFlags.ScheduleRunAfterCurrentRun,
        )
        var runPromiseResolver: any,
          runPromise = new Promise(resolve => (runPromiseResolver = resolve))
        await runPromise
        await sleep(1)
        expect(e.runs.size).toBe(1)
        var run2 = getFirstKey(e.runs)!
        expect(run1 === run2).toBe(false)
      }
    }
    await e.awaitCompletion(true)
    expect(e.runs.size).toBe(0)

    // looped branches
    enableBranchLoop = 1
    ++v10.value
    await e.awaitCompletion(true)
    expect(numTimesLoopedBranchWasRun, 'self changes do not dirty').toBe(1)
    expect(numTimesLoopedBranchWasSkipped).toBe(9)
    numTimesLoopedBranchWasRun = 0
    numTimesLoopedBranchWasSkipped = 0
    enableChangeLoopBranchDepsFromOutside = 1
    ++v11.value
    await e.awaitCompletion(true)
    expect(numTimesLoopedBranchWasRun, 'outside changes do dirty').toBe(4)
    expect(numTimesLoopedBranchWasSkipped).toBe(6)
    // @ts-ignore
    expect(e.getBranchChildrenIds('_4_')).toEqual(['_Looped_'])
  })

  test('blacklists/whitelists', async () => {
    function isTriggerdBy(f: any) {
      function constraintCheck(dep: any) {
        let constraint = e.depConstraint
        return constraint
          ? e.flags & EffectFlags.DepConstraintIsBlacklist
            ? !constraint.has(dep)
            : constraint.has(dep)
          : true
      }
      var s = observeDependenciesIn(f)
      // @ts-ignore
      return e.getDeps().some(x => s.has(x) && constraintCheck(x))
    }
    function areSameDeps(f: any) {
      var s = observeDependenciesIn(f)
      // @ts-ignore
      return areEqual(e.getDeps(), [...s])
    }
    function renew(f: any, isBlacklist: any) {
      expect(e.runs.size).toBe(0)
      e.clearDependencies()
      e.setConstraint(f, isBlacklist)
      e.run()
      return e.awaitCompletion()
    }

    const v2 = ref(2)
    const v3 = ref(3)
    const v4 = ref(4)
    const v5 = ref(5)
    const v6 = ref(2)
    const v7 = ref(2)
    const array = reactive([1, 2, 3, 4])
    const obj = reactive({ a: 1, b: 2 })

    var e = watchEffectAsyncLight(
      async (x: AsyncEffectHelperInterface) => {
        v2.value
        await x.resume(sleep(1))
        v3.value
        await x.resume(sleep(1))
        v4.value
        await x.hasChanged('_0_', async x => {
          v5.value
          await x.resume(sleep(1))
          v6.value
          await x.resume(sleep(1))
          array[1]
          array.length
          obj.a = obj.b + obj.a
          'a' in obj
          await x.resume(sleep(1))
          for (var v of array) {
            break
          }
          for (var key in obj) {
            break
          }
        })
        v7.value
      },
      { flags: EffectFlags.ManualHandling },
    )

    // whitelist
    e.setConstraint(v2, false)
    e.run()
    await e.awaitCompletion()
    expect(e.runs.size).toBe(0)
    expect(isTriggerdBy(() => v4.value)).toBeFalsy()
    ++v4.value
    ++v5.value
    ++v7.value
    ++obj.a
    ++array[1]
    expect(e.flags & ReactiveFlags2.Dirty).toBeFalsy()
    await nextTick()
    expect(e.runs.size).toBe(0)
    expect(isTriggerdBy(() => v2.value)).toBeTruthy()
    ++v2.value
    expect(e.flags & ReactiveFlags2.Dirty).toBeTruthy()
    await e.awaitCompletion()

    await renew(() => {
      v4.value
      obj.a
      array[2]
    }, false)
    expect(
      areSameDeps(() => {
        v4.value
        obj.a
      }),
    ).toBe(true)
    expect(isTriggerdBy(v4)).toBeTruthy()
    expect(isTriggerdBy(() => obj.a)).toBeTruthy()
    expect(isTriggerdBy(() => array[1])).toBeFalsy() // not whitelisted
    expect(isTriggerdBy(() => array[2])).toBeFalsy() // whitelisted but not tracked
    expect(isTriggerdBy(() => v5.value)).toBeFalsy()
    expect(isTriggerdBy(() => 'x' in obj)).toBeFalsy()
    expect(isTriggerdBy(() => obj.b)).toBeFalsy()

    await renew(() => {
      'a' in obj
    }, false)

    expect(isTriggerdBy(() => 'a' in obj)).toBeTruthy()
    expect(isTriggerdBy(() => 'x' in obj)).toBeFalsy()

    // blacklist
    await renew(v2 as any, true)
    expect(e.runs.size).toBe(0)
    expect(
      areSameDeps(() => {
        v3.value
        v4.value
        v5.value
        v6.value
        array[1]
        array.length
        obj.b
        obj.a
        'a' in obj
        for (var v of array) {
          break
        }
        for (var key in obj) {
          break
        }
        v7.value
      }),
    ).toBe(true)
    expect(isTriggerdBy(v2)).toBeFalsy()
    expect(isTriggerdBy(() => obj.a)).toBeTruthy()
    expect(isTriggerdBy(() => array[1])).toBeTruthy()
  })

  test.each([
    { label: 'not reentrant, not livetracking', flags: 0 },
    { label: 'reentrant, not livetracking', flags: EffectFlags.REENTRANT },
    { label: 'not reentrant, livetracking', flags: EffectFlags.LIVETRACKING },
    {
      label: 'reentrant, livetracking',
      flags: EffectFlags.REENTRANT | EffectFlags.LIVETRACKING,
    },
  ])('cleanup ($label)', async ({ label, flags }) => {
    const v2 = ref(2)
    const v3 = ref(3)
    const v4 = ref(4)
    const v5 = ref(5)
    let wasCleanedUp1_0 = 0
    let wasCleanedUp1_1 = 0
    let wasCleanedUp2 = 0
    let wasCleanedUp3 = 0
    let wasCleanedUp4 = 0
    let wasCleanedUp1_2 = 0
    let wasCleanedUp1_1_aborted = 0 as any
    let resourceX_defined = 0
    let isImmediateBranchCleanup = 1
    let wasCleanedUp_1_before_2_ = 0

    var e = watchEffectAsyncLight(
      async (x: AsyncEffectHelperInterface) => {
        await x.resume(sleep(1))
        x.addCleanup(aborted => {
          ++wasCleanedUp1_0
          resourceX_defined = resourceX || 0
        }, true)
        x.addCleanup(aborted => {
          ++wasCleanedUp1_1
          wasCleanedUp1_1_aborted = aborted
        })
        var resourceX: any
        v2.value
        await x.hasChanged('_0_', async x => {
          x.addBranchCleanup(aborted => {
            ++wasCleanedUp2
          }, isImmediateBranchCleanup)
          await x.resume(sleep(20))
          if (v3.value) {
            await x.hasChanged('_1_', async x => {
              x.addBranchCleanup(aborted => {
                ++wasCleanedUp3
              }, isImmediateBranchCleanup)
              await x.resume(sleep(60))
              v4.value
            })
          }
          wasCleanedUp_1_before_2_ = wasCleanedUp3
          await x.resume(sleep(1))
          await x.hasChanged('_2_', async x => {
            x.addBranchCleanup(aborted => {
              ++wasCleanedUp4
            }, isImmediateBranchCleanup)
            await x.resume(sleep(40))
            v5.value
            resourceX = 1
          })
        })
        x.addCleanup(aborted => {
          ++wasCleanedUp1_2
        })
        await x.resume(sleep(40))
      },
      {
        flags:
          flags |
          EffectFlags.EnabledManualBranching |
          EffectFlags.AbortRunOnRetrigger,
      },
    )
    const REENTRANT = e.flags & EffectFlags.REENTRANT

    await e.awaitCompletion()

    expect(e.runs.size).toBe(0)
    expect(
      wasCleanedUp1_0 &&
        wasCleanedUp2 &&
        wasCleanedUp3 &&
        wasCleanedUp4 &&
        wasCleanedUp_1_before_2_ &&
        resourceX_defined,
    ).toBeTruthy()
    expect(wasCleanedUp1_1 && wasCleanedUp1_2).toBeFalsy()
    expect(wasCleanedUp1_1_aborted).toBeFalsy()

    ++v4.value
    ++v5.value
    await nextTick()
    expect(e.runs.size).toBe(1)
    expect(
      wasCleanedUp1_1 && wasCleanedUp1_2,
      'cleaned up at start',
    ).toBeTruthy()
    expect(
      wasCleanedUp1_0 + wasCleanedUp2 + wasCleanedUp3 + wasCleanedUp4,
      'not cleaned up at start',
    ).toBe(4)
    await e.awaitCompletion()
    expect(
      wasCleanedUp1_0 + wasCleanedUp2 + wasCleanedUp3 + wasCleanedUp4,
    ).toBe(8)

    // branches, deferred
    isImmediateBranchCleanup = 0
    wasCleanedUp2 = wasCleanedUp3 = wasCleanedUp4 = 0
    ++v4.value
    ++v5.value
    expect(wasCleanedUp2 + wasCleanedUp3 + wasCleanedUp4).toBe(0)
    await nextTick()
    expect(wasCleanedUp2 + wasCleanedUp3 + wasCleanedUp4).toBe(0)
    expect(wasCleanedUp1_1 + wasCleanedUp1_2, 'cleaned up at start 2').toBe(4)
    await e.awaitCompletion()
    expect(wasCleanedUp2 + wasCleanedUp3 + wasCleanedUp4).toBe(0)

    isImmediateBranchCleanup = 1
    ++v4.value
    ++v5.value
    expect(wasCleanedUp2 + wasCleanedUp3 + wasCleanedUp4).toBe(0)
    await e.awaitCompletion()
    expect(e.runs.size).toBe(0)
    expect(
      wasCleanedUp2 + wasCleanedUp3 + wasCleanedUp4,
      'branches cleaned up at start and end',
    ).toBe(6)
    expect(wasCleanedUp_1_before_2_).toBe(2)

    // aborting
    async function abortTest(isManual: any, isFirstCall?: any) {
      wasCleanedUp2 = wasCleanedUp3 = wasCleanedUp4 = 0
      wasCleanedUp1_0 = wasCleanedUp1_1 = wasCleanedUp1_2 = 0
      wasCleanedUp_1_before_2_ = 0
      resourceX_defined = 999
      ++v4.value
      ++v5.value
      await sleep(50)
      if (isManual) {
        e.abort()
      } else {
        expect(e.flags & EffectFlags.AbortRunOnRetrigger).toBe(
          EffectFlags.AbortRunOnRetrigger,
        )
        ++v2.value
        expect(e.flags & EffectFlags.IsScheduledRun).toBe(
          EffectFlags.IsScheduledRun,
        )
      }
      expect(e.runs.size).toBe(0)
      if (isFirstCall) {
        expect(wasCleanedUp1_1, 'on start (deferred) + on abort').toBe(2)
        expect(wasCleanedUp1_2, 'on start only (deferred run-cleanup)').toBe(1)
      } else {
        expect(
          wasCleanedUp1_1,
          'on abort (previous deferred cleanup was already called on previous abort)',
        ).toBe(1)
        expect(wasCleanedUp1_2, 'never reached due to abort').toBe(0)
      }
      expect(wasCleanedUp1_0 + wasCleanedUp2 + wasCleanedUp3, 'on abort').toBe(
        3,
      )
      expect(
        wasCleanedUp_1_before_2_ + wasCleanedUp4 + resourceX_defined,
        'never reached due to abort',
      ).toBe(0)

      if (!isManual) {
        // abort queued run
        await nextTick()
        e.abort()
      }
      await e.awaitCompletion()
      expect(e.runs.size).toBe(0)
      expect(
        e.flags &
          (EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
      ).toBe(0)
    }
    // maual abort
    isImmediateBranchCleanup = 0
    await abortTest(true, true)
    isImmediateBranchCleanup = 1
    await abortTest(true)

    // auto abort
    isImmediateBranchCleanup = 0
    await abortTest(false)
    isImmediateBranchCleanup = 1
    await abortTest(false)
  })

  test('effect nesting', async () => {
    async function awaitChildEffectCompletion(e: ReactiveEffectAsync) {
      await e.awaitCompletion()
      return Promise.all(
        // @ts-ignore
        e.children?.map(c => c.awaitCompletion(true)) || [],
      )
    }

    const v2 = ref(2)
    const v3 = ref(3)
    const v4 = ref(4)
    const v5 = ref(5)
    const v6 = ref(6)
    const v7 = ref(7)
    const v8 = ref(8)
    const v9 = ref(9)
    var _v4 = 0
    var _v5 = 0
    var _v6 = 0
    var _v7 = 0
    var _v8 = 0 as any

    var _if = 1
    var e1, e2, en1, en2, en3
    var e_run = 0,
      e1_run = 0,
      e2_run = 0,
      en1_run = 0,
      en2_run = 0,
      en3_run = 0
    var first_e2: ReturnType<typeof watchEffectAsyncLight>
    var sequence: any[] = []
    var en1_runOnUpdate = 0

    var e = watchEffectAsyncLight(
      async (x: AsyncEffectHelperInterface) => {
        sequence.push('e')
        ++e_run
        v2.value
        await x.resume(sleep(1))
        var v = v3.value + 10
        e1 = watchEffectAsyncLight(async x => {
          sequence.push('e1')
          ++e1_run
          await x.resume(sleep(1))
          await x.resume(sleep(50))
          _v4 = v4.value + v
        })
        await x.resume(sleep(1))

        if (_if) {
          en1 = watchEffectAsyncLight(
            'en1',
            async x => {
              sequence.push('en1')
              ++en1_run
              v9.v
              await x.resume(sleep(40))
              await x.resume(sleep(40))
              _v5 = v5.value + v
              await x.resume(sleep(40))
              _v5 += 1
            },
            {
              abortOldRunOnUpdate: 1,
              runOnUpdate: en1_runOnUpdate,
              flags: EffectFlags.AbortOnUnvisit,
            },
          )
          e2 = watchEffectAsyncLight(
            async x => {
              sequence.push('e2')
              ++e2_run
              await x.resume(sleep(40))
              await x.resume(sleep(40))
              _v6 = v6.value + e_run
              await x.resume(sleep(40))
              _v6 += 1
              v3.value
            },
            { abortOldRunOnUpdate: 1, runOnUpdate: 0 },
          )
          if (!first_e2) first_e2 = e2
        } else {
          en2 = watchEffectAsyncLight(
            'en2',
            async x => {
              sequence.push('en2')
              ++en2_run
              await x.resume(sleep(40))
              await x.resume(sleep(40))
              _v7 = v7.value + v
              var y = 'y' + v

              en3 = watchEffectAsyncLight(
                'en3',
                async x => {
                  sequence.push('en3')
                  ++en3_run
                  await x.resume(sleep(40))
                  await x.resume(sleep(40))
                  _v8 = v8.value + v + y
                  await x.resume(sleep(40))
                  v7.value
                  _v8 += 1
                },
                { abortOldRunOnUpdate: 0, runOnUpdate: 1 },
              )

              await x.resume(sleep(40))
              _v7 += 1
            },
            {
              abortOldRunOnUpdate: 0,
              runOnUpdate: 1,
              flags: EffectFlags.REENTRANT | EffectFlags.PersistentChildEffect,
            },
          )
        }

        await x.resume(sleep(25))
        v9.v
      },
      /* { flags: EffectFlags.ManualHandling }, */
    )

    await e.awaitCompletion()
    expect(e1 && en1 && e2).toBeTruthy()
    expect(en2 || en3).toBeFalsy()
    expect(areEqual(e.children!, [e1, en1, e2])).toBeTruthy()
    // @ts-ignore
    expect(areEqual(e.getchildEffectIds(), ['', 'en1', ''])).toBeTruthy()
    // @ts-ignore
    expect(areEqual(e.getDeps(), [v2, v3, v9])).toBe(true)
    expect(e1!.runs.size + e2!.runs.size + en1!.runs.size).toBe(3)
    // @ts-ignore
    expect(areEqual(e1?.getDeps(), [])).toBe(true)
    // @ts-ignore
    expect(areEqual(e2?.getDeps(), [])).toBe(true)
    // @ts-ignore
    expect(areEqual(en1?.getDeps(), [])).toBe(true)
    expect(areEqual(sequence, ['e', 'e1', 'en1', 'e2'])).toBeTruthy()
    await awaitChildEffectCompletion(e)
    expect(e1!.runs.size + e2!.runs.size + en1!.runs.size).toBe(0)
    // @ts-ignore
    expect(areEqual(e1?.getDeps(), [v4])).toBe(true)
    // @ts-ignore
    expect(areEqual(e2?.getDeps(), [v6, v3])).toBe(true)
    // @ts-ignore
    expect(areEqual(en1?.getDeps(), [v9, v5])).toBe(true)

    sequence = []
    let e1_prev = e1 as any
    let en1_prev = en1 as any
    let e2_prev = e2 as any
    ++v2.value
    await e.awaitCompletion()
    expect(e.runs.size).toBe(0)
    expect(e1!.runs.size).toBe(1)
    expect(en1!.runs.size).toBe(0)
    expect(
      e2!.runs.size,
      'unnamed effects are always recreated and never updated',
    ).toBe(1)
    expect(e1_prev === e1).toBeFalsy()
    expect(e2_prev === e2).toBeFalsy()
    expect(en1_prev === en1).toBeTruthy()
    expect(e1_prev.flags & EffectFlags.STOP).toBeTruthy()
    expect(e2_prev.flags & EffectFlags.STOP).toBeTruthy()
    expect(en1_prev.flags & EffectFlags.STOP).toBeFalsy()
    await awaitChildEffectCompletion(e)
    expect(e1!.runs.size + e2!.runs.size + en1!.runs.size).toBe(0)
    expect(areEqual(e.children!, [e1, en1, e2])).toBeTruthy()
    expect(areEqual(sequence, ['e', 'e1', 'e2'])).toBeTruthy()

    sequence = []
    ++v5.value
    await nextTick()
    expect(e.runs.size + e1!.runs.size + e2!.runs.size).toBe(0)
    expect(en1!.runs.size).toBe(1)
    await en1!.awaitCompletion()
    expect(areEqual(sequence, ['en1'])).toBeTruthy()

    sequence = []
    ++v6.value
    await nextTick()
    expect(e.runs.size + e1!.runs.size + en1!.runs.size).toBe(0)
    expect(e2!.runs.size).toBe(1)
    expect(areEqual(sequence, ['e2'])).toBeTruthy()
    await sleep(95)
    expect(_v6).toBe(9) // 7 + 2
    await e2!.awaitCompletion()
    expect(_v6).toBe(10)
    expect(e2!.runs.size).toBe(0)

    // expect non-persistent child to wait for its parent to init its execution if common dep trigger
    sequence = []
    expect(
      e.flags & (ReactiveFlags2.Dirty + e2!.flags) & ReactiveFlags2.Dirty,
    ).toBe(0)
    ++v3.value
    expect(
      (e.flags & ReactiveFlags2.Dirty) + (e2!.flags & ReactiveFlags2.Dirty),
    ).toBe(ReactiveFlags2.Dirty * 2)
    await nextTick()
    expect(e.runs.size).toBe(1)
    expect(e2!.runs.size).toBe(0)
    await sleep(20)
    expect(e.runs.size).toBe(1)
    expect(e2!.runs.size).toBe(1)
    await e2!.awaitCompletion()
    expect(areEqual(sequence, ['e', 'e1', 'e2'])).toBeTruthy()
    expect(e.runs.size + e2!.runs.size).toBe(0)

    sequence = []
    expect(
      e.flags & (ReactiveFlags2.Dirty + en1!.flags) & ReactiveFlags2.Dirty,
    ).toBe(0)
    let _v9 = v9 as any
    if (_v9.subs.effectId !== 'en1') {
      let s1 = _v9.subs
      let s2 = s1.nextSub
      s1.prevSub = s2
      s2.nextSub = s1
      s1.nextSub = undefined
      s2.prevSub = undefined
      s2.subsTail = s1
      _v9.subs = s2
    }
    expect(areEqual(_v9.getSubs(), [en1, e])).toBeTruthy()
    ++v9.value
    expect(
      (e.flags & ReactiveFlags2.Dirty) + (en1!.flags & ReactiveFlags2.Dirty),
    ).toBe(ReactiveFlags2.Dirty * 2)
    await nextTick()
    expect(e.runs.size).toBe(1)
    expect(en1!.runs.size).toBe(0)
    await sleep(20)
    expect(e.runs.size).toBe(1)
    expect(en1!.runs.size).toBe(1)
    await en1!.awaitCompletion()
    expect(areEqual(sequence, ['e', 'e1', 'en1', 'e2'])).toBeTruthy()
    expect(e.runs.size + en1!.runs.size).toBe(0)

    // abortOldRunOnUpdate
    sequence = []
    en1_runOnUpdate = 1
    ++v5.value
    await nextTick()
    expect(e.runs.size).toBe(0)
    expect(en1!.runs.size).toBe(1)
    ++v2.value
    await nextTick()
    expect(e.runs.size).toBe(1)
    expect(en1!.runs.size).toBe(1)
    en1_prev = en1 as any
    let en1_run_prev = getFirstKey(en1!.runs) as any
    await sleep(20)
    expect(e.runs.size).toBe(1)
    expect(en1!.runs.size).toBe(1)
    expect(en1_run_prev === getFirstKey(en1!.runs)).toBeFalsy()
    expect(en1_run_prev.flags & RunInfoFlags.Aborted).toBeTruthy()
    await awaitChildEffectCompletion(e)
    expect(e.runs.size).toBe(0)
    expect(en1!.runs.size).toBe(0)
    expect(areEqual(sequence, ['en1', 'e', 'e1', 'en1', 'e2'])).toBeTruthy()
    expect(en1_prev === en1).toBeTruthy()

    // unnamed effects are stopped on parent run start
    sequence = []
    e1_prev = e1 as any
    ++v4.value
    await nextTick()
    expect(e.runs.size).toBe(0)
    expect(e1!.runs.size).toBe(1)
    ++v2.value
    await nextTick()
    expect(e.runs.size).toBe(1)
    expect(e1!.runs.size).toBe(1)
    await sleep(10)
    expect(e.runs.size).toBe(1)
    expect(e1!.runs.size).toBe(1)
    expect(e1_prev === e1).toBeFalsy()
    expect(e1_prev.flags & EffectFlags.STOP).toBeTruthy()
    await awaitChildEffectCompletion(e)
    expect(e.runs.size).toBe(0)
    expect(e1!.runs.size).toBe(0)

    // new children
    _if = 0
    en1_runOnUpdate = 0
    ++v5.value
    await nextTick()
    expect(en1!.runs.size).toBe(1)
    en1_run_prev = getFirstKey(en1!.runs) as any
    ++v2.value
    await e.awaitCompletion()
    expect(en1!.runs.size).toBe(0)
    expect(en1_run_prev.flags & RunInfoFlags.Aborted).toBeTruthy()
    expect(en1!.flags & EffectFlags.PausedOnUnvisit).toBeTruthy()
    expect(areEqual(e.children!, [e1, en2, en1])).toBeTruthy()
    expect(en2).toBeTruthy()
    expect(en3).toBe(undefined)
    expect(en2!.runs.size).toBe(1)
    await en2!.awaitCompletion()
    expect(areEqual(e.children!, [e1, en2, en1])).toBeTruthy()
    expect(areEqual(en2!.children!, [en3])).toBeTruthy()
    expect(en3!.runs.size).toBe(1)
    await en3!.awaitCompletion()
    // @ts-ignore
    expect(areEqual(en3!.getDeps(), [v8, v7])).toBe(true)

    // PauseOnUnvisit
    ++v5.value
    await sleep(5)
    expect(
      e.runs.size +
        e1!.runs.size +
        en1!.runs.size +
        en2!.runs.size +
        en3!.runs.size,
    ).toBe(0)

    sequence = []
    ++v7.value
    await nextTick()
    expect(e.runs.size).toBe(0)
    expect(en2!.runs.size).toBe(1)
    expect(en3!.runs.size).toBe(0)
    await sleep(10)
    ++v7.value
    await nextTick()
    expect(en2!.runs.size).toBe(2)
    expect(en3!.runs.size).toBe(0)
    await sleep(100)
    expect(en2!.runs.size).toBe(2)
    expect(en3!.runs.size).toBe(1)
    expect(en3!.flags & EffectFlags.ScheduleRunAfterCurrentRun).toBeTruthy()
    en3!.abort()
    await en2!.awaitCompletion(true)
    expect(en2!.runs.size).toBe(0)
    expect(en3!.runs.size).toBe(0)
    expect(areEqual(sequence, ['en2', 'en2', 'en3'])).toBeTruthy()

    ++v8.value
    await nextTick()
    expect(en2!.runs.size).toBe(0)
    expect(en3!.runs.size).toBe(1)
    en3!.abort()

    _if = 1
    sequence = []
    ++v2.value
    await e.awaitCompletion()
    expect(areEqual(e.children!, [e1, en1, e2, en2])).toBeTruthy()
    ++v6.value
    await nextTick()
    expect(e2!.runs.size).toBe(1)
    e2!.abort()
    ++v7.value
    await nextTick()
    expect(en2!.runs.size).toBe(1)
    expect(en3!.runs.size).toBe(0)
    en2!.abort(false)
    await nextTick()
    expect(
      en3!.runs.size,
      'temporarily paused dirty children are resumed on parent abort',
    ).toBe(1)
    en3!.abort()

    expect(`An effectId is recommended for nested effects`).toHaveBeenWarned()
  })
})
