import type { Locator, Page } from "playwright";
import type { LocatorDescriptor } from "./types.js";

type AriaRole = Parameters<Page["getByRole"]>[0];

/**
 * Reconstructs a Playwright Locator from a graph-scoped descriptor. Only used
 * inside the adapter; the resulting Locator never escapes the package.
 */
export function locatorFor(page: Page, descriptor: LocatorDescriptor): Locator {
  if (descriptor.kind === "role" && descriptor.name !== undefined) {
    return page.getByRole(descriptor.role as AriaRole, {
      name: descriptor.name,
      exact: true,
    });
  }
  if (descriptor.text !== undefined) {
    return page.getByText(descriptor.text, { exact: true });
  }
  return page.getByRole(descriptor.role as AriaRole);
}
