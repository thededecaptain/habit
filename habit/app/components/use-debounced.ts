import { useEffect, useRef } from "react";

/**
 * Runs `fn` once the calls stop for `delayMs` — for search boxes that
 * reload the page's data, so it happens when the merchant pauses typing
 * instead of on every keystroke.
 *
 * Polaris web components need `onInput` for this: React 18 never delivers
 * their `change` events to an `onChange` prop.
 */
export function useDebounced<Args extends unknown[]>(fn: (...args: Args) => void, delayMs = 300) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => () => clearTimeout(timer.current), []);
  return (...args: Args) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(...args), delayMs);
  };
}
