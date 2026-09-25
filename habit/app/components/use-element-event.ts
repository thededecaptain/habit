import { useCallback, useRef } from "react";

/**
 * Listens for a Polaris web component's own event (e.g. s-banner's
 * "dismiss"). React 18 only wires up standard DOM events like click and
 * input on custom elements, so an `onDismiss` prop is silently ignored.
 *
 * Returns a callback ref, so it also works for elements rendered
 * conditionally.
 */
export function useElementEvent(eventName: string, handler: (event: Event) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  const detach = useRef<(() => void) | undefined>(undefined);
  return useCallback(
    (element: Element | null) => {
      detach.current?.();
      detach.current = undefined;
      if (!element) return;
      const listener = (event: Event) => latest.current(event);
      element.addEventListener(eventName, listener);
      detach.current = () => element.removeEventListener(eventName, listener);
    },
    [eventName],
  );
}
