import type { ComponentType } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { vi } from "vitest";

/** Stand-in for App Bridge's `shopify` global (toasts and the save bar). */
export const appBridge = { toast: { show: vi.fn() }, saveBar: { show: vi.fn(), hide: vi.fn() } };

type RouteStub = Parameters<typeof createRoutesStub>[0][number];

/**
 * Renders a route component with stubbed loader/action data, plus any extra
 * routes it fetches from (e.g. /app/customer-search).
 */
export async function renderRoute(
  Component: ComponentType,
  options: {
    path: string;
    loaderData: unknown;
    action?: (args: { request: Request }) => unknown;
    url?: string;
    extraRoutes?: RouteStub[];
  },
) {
  const actions: Record<string, FormDataEntryValue>[] = [];
  const Stub = createRoutesStub([
    {
      path: options.path,
      Component: Component as never,
      loader: () => options.loaderData,
      action: async ({ request }) => {
        const form = Object.fromEntries(await request.formData());
        actions.push(form);
        return options.action ? options.action({ request: new Request(request.url, { method: "POST" }) }) : null;
      },
    },
    ...(options.extraRoutes ?? []),
  ]);
  const utils = render(<Stub initialEntries={[options.url ?? options.path]} />);
  // Let the stubbed loader resolve.
  await act(async () => {
    await Promise.resolve();
  });
  return { ...utils, actions };
}

/** The first custom element matching `selector`, e.g. 's-text-field[label="Code"]'. */
export function el(container: HTMLElement, selector: string) {
  const found = container.querySelector(selector);
  if (!found) throw new Error(`No element matches ${selector}`);
  return found as HTMLElement & { value?: string };
}

/** Types into a Polaris field: sets its value and fires the input event React listens for. */
export function typeInto(element: HTMLElement & { value?: string }, value: string) {
  element.value = value;
  fireEvent.input(element);
}

/** Clicks the Polaris button/clickable containing `text`. */
export function clickText(container: HTMLElement, text: string, tag = "s-button") {
  const match = [...container.querySelectorAll(tag)].find((node) => node.textContent?.trim() === text);
  if (!match) throw new Error(`No ${tag} with text "${text}"`);
  fireEvent.click(match);
}

export async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
