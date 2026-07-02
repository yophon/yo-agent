/**
 * TUI 共用 hooks(4.7a)。
 *
 * useSyncedRef:useState + ref 双写合一。TUI 的按键处理在 useInput 闭包里,同帧多次
 * 按键/事件必须能同步读到最新值(useState 异步批处理读不到,4.5 已踩过),此前 app.ts
 * 对每份状态手写「useState + useRef + set 双写」样板约 10 份,忘一处即 stale-closure bug。
 * 本 hook 把三件套收敛为一个返回值:读走 `.current`(恒最新),写走 `set()`(同步改
 * ref + 触发重渲),渲染取值直接用 `.value`。
 */
import { useRef, useState } from 'react';

export interface SyncedRef<T> {
  /** 同帧同步可见的最新值(事件闭包内读这个)。 */
  readonly current: T;
  /** 本次渲染的快照(JSX 里读这个,与 React 渲染周期一致)。 */
  readonly value: T;
  /** 同步更新 ref 并触发重渲。 */
  set(next: T): void;
}

export function useSyncedRef<T>(initial: T | (() => T)): SyncedRef<T> {
  const [value, setValue] = useState<T>(initial);
  const ref = useRef<T>(value);
  // 每次渲染重建包装对象成本可忽略(TUI 状态份数有限);ref/set 恒稳定。
  return {
    get current() {
      return ref.current;
    },
    value,
    set(next: T) {
      ref.current = next;
      setValue(next);
    },
  };
}
