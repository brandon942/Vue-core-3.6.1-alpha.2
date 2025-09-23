import { isArray, isIntegerKey, isMap, isSymbol } from '@vue/shared'
import { type TrackOpTypes, TriggerOpTypes } from './constants'
import { onTrack, triggerEventInfos } from './debug'
import {
  type Link,
  ReactiveFlags,
  type ReactiveNode,
  activeSub,
  endBatch,
  link,
  propagate,
  shallowPropagate,
  startBatch,
} from './system'
import {
  EffectFlags,
  SubscriberAsync,
  setSubsDirtyOnBranchDepChange,
} from './effect'

if (__DEV__) {
  var depId = 0
}
export class Dep implements ReactiveNode {
  _subs: Link | undefined = undefined
  subsTail: Link | undefined = undefined
  flags: ReactiveFlags = ReactiveFlags.None
  activeSubLink?: Link = undefined

  constructor(
    private map: KeyToDepMap,
    private key: unknown,
  ) {
    if (__DEV__) {
      // @ts-ignore
      this.DepID = ++depId
      // @ts-ignore
      this.getSubs = () => {
        // @ts-ignore
        let s = this._subs
        let a = []
        let c = 0
        while (s) {
          if (c++ > 200) {
            console.log('possible subs link loop')
            break
          }
          a.push(s.sub)
          s = s.nextSub
        }
        return a
      }
    }
  }

  get subs(): Link | undefined {
    return this._subs
  }

  set subs(value: Link | undefined) {
    this._subs = value
    if (value === undefined) {
      this.map.delete(this.key)
    }
  }
}

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Maps to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>

export const targetMap: WeakMap<object, KeyToDepMap> = new WeakMap()

export const ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Object iterate' : '',
)
export const MAP_KEY_ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Map keys iterate' : '',
)
export const ARRAY_ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Array iterate' : '',
)

/**
 * Tracks access to a reactive property.
 *
 * This will check which effect is running at the moment and record it as dep
 * which records all effects that depend on the reactive property.
 *
 * @param target - Object holding the reactive property.
 * @param type - Defines the type of access to the reactive property.
 * @param key - Identifier of the reactive property to track.
 */
export function track(target: object, type: TrackOpTypes, key: unknown): void {
  if (activeSub !== undefined) {
    let depsMap = targetMap.get(target)
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }
    let dep = depsMap.get(key)
    if (!dep) {
      depsMap.set(key, (dep = new Dep(depsMap, key)))
    }
    if (activeSub.flags & EffectFlags.ASYNC) {
      if (activeSub.flags & EffectFlags.ObservingDep) {
        ;(activeSub as SubscriberAsync).observedDeps!.add(dep)
        return
      }
      let toTrack = (activeSub as SubscriberAsync).track(dep) // links here
      if (!toTrack) return
    } else {
      link(dep, activeSub!)
    }
    if (__DEV__) {
      onTrack(activeSub!, {
        target,
        type,
        key,
      })
    }
  }
}

/**
 * Finds all deps associated with the target (or a specific property) and
 * triggers the effects stored within.
 *
 * @param target - The reactive object.
 * @param type - Defines the type of the operation that needs to trigger effects.
 * @param key - Can be used to target a specific reactive property in the target object.
 */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>,
): void {
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    return
  }

  const notifyAndDirty = (dep: ReactiveNode | undefined) => {
    if (dep !== undefined && dep.subs !== undefined) {
      if (__DEV__) {
        triggerEventInfos.push({
          target,
          type,
          key,
          newValue,
          oldValue,
          oldTarget,
        })
      }
      propagate(dep.subs)
      shallowPropagate(dep.subs)
      if (__DEV__) {
        triggerEventInfos.pop()
      }

      setSubsDirtyOnBranchDepChange(dep)
    }
  }

  startBatch()

  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(notifyAndDirty)
  } else {
    const targetIsArray = isArray(target)
    const isArrayIndex = targetIsArray && isIntegerKey(key)

    if (targetIsArray && key === 'length') {
      const newLength = Number(newValue)
      depsMap.forEach((dep, key) => {
        if (
          key === 'length' ||
          key === ARRAY_ITERATE_KEY ||
          (!isSymbol(key) && key >= newLength)
        ) {
          notifyAndDirty(dep)
        }
      })
    } else {
      // schedule runs for SET | ADD | DELETE
      if (key !== void 0 || depsMap.has(void 0)) {
        notifyAndDirty(depsMap.get(key))
      }

      // schedule ARRAY_ITERATE for any numeric key change (length is handled above)
      if (isArrayIndex) {
        notifyAndDirty(depsMap.get(ARRAY_ITERATE_KEY))
      }

      // also run for iteration key on ADD | DELETE | Map.SET
      switch (type) {
        case TriggerOpTypes.ADD:
          if (!targetIsArray) {
            notifyAndDirty(depsMap.get(ITERATE_KEY))
            if (isMap(target)) {
              notifyAndDirty(depsMap.get(MAP_KEY_ITERATE_KEY))
            }
          } else if (isArrayIndex) {
            // new index added to array -> length changes
            notifyAndDirty(depsMap.get('length'))
          }
          break
        case TriggerOpTypes.DELETE:
          if (!targetIsArray) {
            notifyAndDirty(depsMap.get(ITERATE_KEY))
            if (isMap(target)) {
              notifyAndDirty(depsMap.get(MAP_KEY_ITERATE_KEY))
            }
          }
          break
        case TriggerOpTypes.SET:
          if (isMap(target)) {
            notifyAndDirty(depsMap.get(ITERATE_KEY))
          }
          break
      }
    }
  }

  endBatch()
}

export function getDepFromReactive(
  object: any,
  key: string | number | symbol,
): ReactiveNode | undefined {
  const depMap = targetMap.get(object)
  return depMap && depMap.get(key)
}
