/* The system Back button's first duty is to close whatever is floating on top
 * of the app — a dialog, a preview, a panel — before any navigation happens.
 * Those overlays live in different components (Dialog, Platform Settings'
 * snapshot viewer, the card tools popover…), so this tiny registry is how they
 * all take part without threading props through the tree: a component
 * registers a closer while its overlay is open and unregisters when it shuts.
 *
 * The page's popstate controller (app/page.tsx) calls popBackCloser() first;
 * only when nothing is open does the press become a navigation step. Plain
 * module state on purpose — no React, no context, nothing to re-render.
 */

type Closer = () => void;

const stack: Closer[] = [];

/* Register a closer for an open overlay. Returns the matching unregister;
   calling it twice, or after the overlay closed itself, is harmless. */
export function registerBackCloser(close: Closer): () => void {
  stack.push(close);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const at = stack.lastIndexOf(close);
    if (at >= 0) stack.splice(at, 1);
  };
}

/* Close the top-most open overlay. True if one was there to close. */
export function popBackCloser(): boolean {
  const close = stack.pop();
  if (!close) return false;
  try { close(); } catch { /* an overlay that failed to close must not eat the press */ }
  return true;
}

/* Whether anything dismissible is currently open. */
export function hasBackCloser(): boolean {
  return stack.length > 0;
}
