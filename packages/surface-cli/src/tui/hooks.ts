/**
 * TUI 共用 hooks(4.7a)。
 *
 * useSyncedRef:useState + ref 双写合一。TUI 的按键处理在 useInput 闭包里,同帧多次
 * 按键/事件必须能同步读到最新值(useState 异步批处理读不到,4.5 已踩过),此前 app.ts
 * 对每份状态手写「useState + useRef + set 双写」样板约 10 份,忘一处即 stale-closure bug。
 * 本 hook 把三件套收敛为一个返回值:读走 `.current`(恒最新),写走 `set()`(同步改
 * ref + 触发重渲),渲染取值直接用 `.value`。
 */
import { useEffect, useRef, useState } from 'react';

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

/**
 * 双击确认(4.7c):首次触发进入武装态(窗口内提示「再按一次」),窗口内再次触发才执行。
 * 空闲 Ctrl+C/Ctrl+D 退出与审批面板 Esc 拒绝共用;任何其他按键可 disarm() 解除。
 */
export interface ArmedConfirm {
  /** 渲染快照:武装中(显示「再按一次」提示)。 */
  armed: boolean;
  /** 未武装 → 武装并起倒计时;武装中 → 解除并执行 action。 */
  fire(action: () => void): void;
  /** 解除武装(倒计时一并清除;未武装时 no-op)。 */
  disarm(): void;
}

export function useArmedConfirm(windowMs = 3000): ArmedConfirm {
  const armed = useSyncedRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = (): void => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅卸载时清定时器;clear 每渲染重建但语义恒定
  useEffect(() => clear, []);
  return {
    armed: armed.value,
    fire(action) {
      if (armed.current) {
        clear();
        armed.set(false);
        action();
        return;
      }
      armed.set(true);
      clear();
      timer.current = setTimeout(() => armed.set(false), windowMs);
    },
    disarm() {
      clear();
      if (armed.current) armed.set(false);
    },
  };
}
