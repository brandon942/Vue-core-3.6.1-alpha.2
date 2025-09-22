/* eslint-disable */
// Ported from https://github.com/stackblitz/alien-signals/blob/v2.0.4/src/system.ts
import type { ComputedRefImpl as Computed } from './computed.js'
import { EffectFlags, type ReactiveEffect as Effect } from './effect.js'
import type { EffectScope } from './effectScope.js'
import { warn } from './warning.js'

export interface ReactiveNode {
  deps?: Link
  depsTail?: Link
  subs?: Link
  subsTail?: Link
  flags: ReactiveFlags
  activeSubLink?: Link // used to avoid searching for a link in the deps-link chain and to avoid creatiing link duplicates
}

export interface Link {
  dep: ReactiveNode | Computed | Effect | EffectScope
  sub: ReactiveNode | Computed | Effect | EffectScope
  prevSub: Link | undefined
  nextSub: Link | undefined
  prevDep: Link | undefined
  nextDep: Link | undefined
  tracking_Islinked?: Boolean // used to optimize detection of tracked links
  activeSubLinkPrev?: Link // used to support effect nesting
}

export const enum ReactiveFlags {
  None = 0,
  Mutable = 1 << 0,
  Watching = 1 << 1,
  RecursedCheck = 1 << 2,
  Recursed = 1 << 3,

  Dirty = 1 << 4,

  Pending = 1 << 5,
}

const notifyBuffer: (Effect | undefined)[] = []

export let batchDepth = 0
export let activeSub: ReactiveNode | undefined = undefined

let notifyIndex = 0
let notifyBufferLength = 0

export function setActiveSub(sub?: ReactiveNode): ReactiveNode | undefined {
  try {
    return activeSub
  } finally {
    activeSub = sub
  }
}

export function startBatch(): void {
  ++batchDepth
}

export function endBatch(): void {
  if (!--batchDepth && notifyBufferLength) {
    flush()
  }
}

export function link(dep: ReactiveNode, sub: ReactiveNode): void {
  // @ts-ignore
  const asyncRun = sub.activeRun
  const sub_depsTail = asyncRun ? asyncRun.lastTrackedDepLink : sub.depsTail
  if (sub_depsTail !== undefined && sub_depsTail.dep === dep) {
    return
  }
  let nextDepLink: Link | undefined = undefined
  const recursedCheck = sub.flags & ReactiveFlags.RecursedCheck
  if (recursedCheck) {
    nextDepLink = sub_depsTail !== undefined ? sub_depsTail.nextDep : sub.deps
    if (nextDepLink !== undefined && nextDepLink.dep === dep) {
      nextDepLink.tracking_Islinked = true
      if (asyncRun) {
        asyncRun.lastTrackedDepLink = nextDepLink
      }
      sub.depsTail = nextDepLink
      return
    }

    var activeLink = dep.activeSubLink
    if (activeLink?.sub === sub) {
      if (activeLink.tracking_Islinked) {
        return
      }

      activeLink.prevDep!.nextDep = activeLink.nextDep
      if (activeLink.nextDep) activeLink.nextDep.prevDep = activeLink.prevDep
      activeLink.prevDep = sub_depsTail
      activeLink.nextDep = nextDepLink
      activeLink.tracking_Islinked = true
      if (asyncRun) {
        asyncRun.lastTrackedDepLink = activeLink
      }
      sub.depsTail = activeLink
      if (nextDepLink !== undefined) {
        nextDepLink.prevDep = activeLink
      }
      if (sub_depsTail !== undefined) {
        sub_depsTail.nextDep = activeLink
      } else {
        sub.deps = activeLink
      }
      return
    }
  }

  const prevSub = dep.subsTail
  const newLink = (dep.subsTail = {
    dep,
    sub,
    prevDep: sub_depsTail,
    nextDep: nextDepLink,
    prevSub,
    nextSub: undefined,
    tracking_Islinked: true,
  }) as Link
  if (asyncRun) {
    asyncRun.lastTrackedDepLink = newLink
  }
  sub.depsTail = newLink
  if (sub === activeSub) {
    newLink.activeSubLinkPrev = dep.activeSubLink
    dep.activeSubLink = newLink
  }
  if (nextDepLink !== undefined) {
    nextDepLink.prevDep = newLink
  }
  if (sub_depsTail !== undefined) {
    sub_depsTail.nextDep = newLink
  } else {
    sub.deps = newLink
  }
  if (prevSub !== undefined) {
    prevSub.nextSub = newLink
  } else {
    dep.subs = newLink
  }
}

export function unlink(
  link: Link,
  sub: ReactiveNode = link.sub,
): Link | undefined {
  const dep = link.dep
  const prevDep = link.prevDep
  const nextDep = link.nextDep
  const nextSub = link.nextSub
  const prevSub = link.prevSub
  if (nextDep !== undefined) {
    nextDep.prevDep = prevDep
  } else {
    sub.depsTail = prevDep
  }
  if (prevDep !== undefined) {
    prevDep.nextDep = nextDep
  } else {
    sub.deps = nextDep
  }
  if (nextSub !== undefined) {
    nextSub.prevSub = prevSub
  } else {
    dep.subsTail = prevSub
  }
  if (prevSub !== undefined) {
    prevSub.nextSub = nextSub
  } else if ((dep.subs = nextSub) === undefined) {
    let toRemove = dep.deps
    if (toRemove !== undefined) {
      do {
        toRemove = unlink(toRemove, dep)
      } while (toRemove !== undefined)
      dep.flags |= ReactiveFlags.Dirty
    }
  }
  ;(dep as ReactiveNode).activeSubLink &&= undefined
  return nextDep
}

export function propagate(link: Link): void {
  let nextSubLink = link.nextSub
  let stack: any[]
  let stackIndex = 0
  const dep = link.dep
  let letWasAddedTo_notifyBuffer = false

  top: do {
    const sub = link.sub

    let flags = sub.flags

    if (flags & (ReactiveFlags.Mutable | ReactiveFlags.Watching)) {
      if (
        !(
          flags &
          (ReactiveFlags.RecursedCheck |
            ReactiveFlags.Recursed |
            ReactiveFlags.Dirty |
            ReactiveFlags.Pending)
        )
      ) {
        sub.flags = flags | ReactiveFlags.Pending
      } else if (
        !(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed))
      ) {
        flags = ReactiveFlags.None
      } else if (!(flags & ReactiveFlags.RecursedCheck)) {
        sub.flags = (flags & ~ReactiveFlags.Recursed) | ReactiveFlags.Pending
      } else if (
        !(flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) &&
        (flags & EffectFlags.REENTRANT
          ? true
          : sub.depsTail &&
            (link.tracking_Islinked || !(flags & ReactiveFlags.RecursedCheck)))
      ) {
        sub.flags = flags | ReactiveFlags.Recursed | ReactiveFlags.Pending
        flags &= ReactiveFlags.Mutable
      } else {
        flags = ReactiveFlags.None
      }

      if (flags & ReactiveFlags.Watching) {
        if (!letWasAddedTo_notifyBuffer) {
          notifyBuffer[notifyBufferLength++] = dep as Effect
          letWasAddedTo_notifyBuffer = true
        }
        notifyBuffer[notifyBufferLength++] = sub as Effect
      }

      if (flags & ReactiveFlags.Mutable) {
        const subSubs = sub.subs
        if (subSubs !== undefined) {
          link = subSubs
          if (subSubs.nextSub !== undefined) {
            stack ??= []
            stack[stackIndex++] = nextSubLink
            nextSubLink = link.nextSub
          }
          continue
        }
      }
    }

    if ((link = nextSubLink!) !== undefined) {
      nextSubLink = link.nextSub
      continue
    }

    while (stackIndex > 0) {
      link = stack![--stackIndex]
      if (link !== undefined) {
        nextSubLink = link.nextSub
        continue top
      }
    }

    break
  } while (true)
}

export function startTracking(
  sub: ReactiveNode,
  isAsyncSub?: any,
): ReactiveNode | undefined {
  if (!isAsyncSub) {
    sub.depsTail = undefined
  }
  sub.flags =
    (sub.flags &
      ~(ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending)) |
    ReactiveFlags.RecursedCheck

  let depLink = sub.deps
  while (depLink) {
    const dep = depLink.dep as ReactiveNode
    depLink.activeSubLinkPrev = dep.activeSubLink
    dep.activeSubLink = depLink
    depLink = depLink.nextDep
  }
  return setActiveSub(sub)
}

export function endTracking(
  sub: ReactiveNode,
  prevSub: ReactiveNode | undefined,
): void {
  if (__DEV__ && activeSub !== sub) {
    warn(
      'Active effect was not restored correctly - ' +
        'this is likely a Vue internal bug.',
    )
  }
  activeSub = prevSub

  // @ts-ignore
  const asyncRun = sub.activeRun
  if (asyncRun) {
    let depLink = sub.deps
    while (depLink) {
      const dep = depLink.dep as ReactiveNode
      if (dep.activeSubLink) {
        dep.activeSubLink = depLink.activeSubLinkPrev
        depLink.activeSubLinkPrev = undefined
      }
      depLink = depLink.nextDep
    }
  } else {
    let depLink = sub.deps
    while (depLink) {
      const dep = depLink.dep as ReactiveNode
      if (dep.activeSubLink) {
        dep.activeSubLink = depLink.activeSubLinkPrev
        depLink.activeSubLinkPrev = undefined
      }
      depLink.tracking_Islinked = false
      depLink = depLink.nextDep
    }
    const depsTail = sub.depsTail
    let toRemove = depsTail !== undefined ? depsTail.nextDep : sub.deps
    while (toRemove !== undefined) {
      toRemove = unlink(toRemove, sub)
    }
  }
  sub.flags &= ~ReactiveFlags.RecursedCheck
}

export function flush(): void {
  let dep
  while (notifyIndex < notifyBufferLength) {
    const item = notifyBuffer[notifyIndex]!
    notifyBuffer[notifyIndex++] = undefined
    if (!(item.flags & ReactiveFlags.Watching)) {
      dep = item
    } else {
      item.notify(dep)
    }
  }
  notifyBufferLength = 0
  notifyIndex = 0
}

export function checkDirty(link: Link, sub: ReactiveNode): boolean {
  let stack: any[]
  let stackIndex = 0
  let checkDepth = 0

  top: do {
    const dep = link.dep
    const depFlags = dep.flags

    let dirty = false

    if (sub.flags & ReactiveFlags.Dirty) {
      dirty = true
    } else if (
      (depFlags & (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) ===
      (ReactiveFlags.Mutable | ReactiveFlags.Dirty)
    ) {
      if ((dep as Computed).update()) {
        const subs = dep.subs!
        if (subs.nextSub !== undefined) {
          shallowPropagate(subs)
        }
        dirty = true
      }
    } else if (
      (depFlags & (ReactiveFlags.Mutable | ReactiveFlags.Pending)) ===
      (ReactiveFlags.Mutable | ReactiveFlags.Pending)
    ) {
      if (link.nextSub !== undefined || link.prevSub !== undefined) {
        stack ??= []
        stack[stackIndex++] = link
      }
      link = dep.deps!
      sub = dep
      ++checkDepth
      continue
    }

    if (!dirty && link.nextDep !== undefined) {
      link = link.nextDep
      continue
    }

    while (checkDepth) {
      --checkDepth
      const firstSub = sub.subs!
      const hasMultipleSubs = firstSub.nextSub !== undefined
      if (hasMultipleSubs) {
        link = stack![--stackIndex]
      } else {
        link = firstSub
      }
      if (dirty) {
        if ((sub as Computed).update()) {
          if (hasMultipleSubs) {
            shallowPropagate(firstSub)
          }
          sub = link.sub
          continue
        }
      } else {
        sub.flags &= ~ReactiveFlags.Pending
      }
      sub = link.sub
      if (link.nextDep !== undefined) {
        link = link.nextDep
        continue top
      }
      dirty = false
    }

    return dirty
  } while (true)
}

export function shallowPropagate(link: Link): void {
  do {
    const sub = link.sub
    const nextSub = link.nextSub
    const subFlags = sub.flags
    if (
      (subFlags & (ReactiveFlags.Pending | ReactiveFlags.Dirty)) ===
      ReactiveFlags.Pending
    ) {
      sub.flags = subFlags | ReactiveFlags.Dirty
    }
    link = nextSub!
  } while (link !== undefined)
}
