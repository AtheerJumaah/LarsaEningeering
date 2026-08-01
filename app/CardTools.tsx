"use client";

/* Card tools: reorder any card grid by dragging, and pick the accent colour.
 *
 * Written as one layer mounted from the layout rather than as edits to every
 * screen. Two reasons. Card grids appear in a dozen places and adding drag
 * handlers to each would be a dozen chances to break a screen; and the app's
 * biggest file is 577 KB, where every targeted edit is a risk. This attaches
 * by delegation instead, so a new card grid added later gets both features for
 * free.
 *
 * Order is applied with the CSS order property, never by moving DOM nodes.
 * Moving nodes React owns would be undone on the next render; order is a style,
 * so it survives, and a MutationObserver puts it back if React replaces the
 * element outright.
 *
 * Both settings are per person and per device (localStorage). Syncing them to
 * the staff record is the better home, but that record rides in the shared blob
 * and the database trigger does not protect preference fields yet -- so this
 * stays local until it does.
 */

import { useEffect, useState } from "react";
import { Check, Palette, RotateCcw } from "lucide-react";

/* Containers whose children may be reordered. Each needs a stable key, because
   the order is stored against it. */
const GRIDS = [
  { selector: ".module-grid:not(.quick-grid)", key: "areas" },
  { selector: ".quick-action-row", key: "quick" },
  { selector: ".module-grid.quick-grid", key: "quickcards" },
];

const ACCENTS = [
  { id: "ink", label: "Larsa black", value: "#17181b" },
  { id: "slate", label: "Slate", value: "#475569" },
  { id: "blue", label: "Blue", value: "#2563eb" },
  { id: "teal", label: "Teal", value: "#0d9488" },
  { id: "violet", label: "Violet", value: "#7c3aed" },
  { id: "amber", label: "Amber", value: "#b45309" },
];

function storageKey(name: string): string {
  let who = "anon";
  try {
    const raw = localStorage.getItem("larsa-control-user");
    if (raw) who = String(JSON.parse(raw).id || "anon");
  } catch {
    who = "anon";
  }
  return "larsa.cardtools." + name + "." + who;
}

function readOrder(key: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey("order." + key));
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function writeOrder(key: string, ids: string[]) {
  try {
    localStorage.setItem(storageKey("order." + key), JSON.stringify(ids));
  } catch {
    /* a full quota should not break the page */
  }
}

/* A card is identified by its own text, not its position: positions change the
   moment somebody reorders, but the label on the card does not. */
function cardId(node: Element): string {
  return (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
}

function applyOrder(container: HTMLElement, key: string) {
  const saved = readOrder(key);
  if (!saved.length) return;
  Array.from(container.children).forEach((child) => {
    const index = saved.indexOf(cardId(child));
    (child as HTMLElement).style.order = index < 0 ? "0" : String(index + 1);
  });
}

export function CardTools() {
  const [open, setOpen] = useState(false);  const [canOrder, setCanOrder] = useState(false);  const [canColour, setCanColour] = useState(false);
  const [accent, setAccent] = useState("#17181b");

  useEffect(() => {
    let stored = "";
    try {
      stored = localStorage.getItem(storageKey("accent")) || "";
    } catch {
      stored = "";
    }
    if (stored) {
      setAccent(stored);
      document.documentElement.style.setProperty("--larsa-accent", stored);
    }
  }, []);

  function chooseAccent(value: string) {
    setAccent(value);
    document.documentElement.style.setProperty("--larsa-accent", value);
    try {
      localStorage.setItem(storageKey("accent"), value);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    let dragged: HTMLElement | null = null;

    function containerFor(node: EventTarget | null): { el: HTMLElement; key: string } | null {
      if (!(node instanceof Element)) return null;
      for (const grid of GRIDS) {
        const el = node.closest(grid.selector);
        if (el) return { el: el as HTMLElement, key: grid.key };
      }
      return null;
    }
    function childOf(container: HTMLElement, node: EventTarget | null): HTMLElement | null {
      if (!(node instanceof Element)) return null;
      let current: Element | null = node;
      while (current && current.parentElement !== container) current = current.parentElement;
      return (current as HTMLElement) || null;
    }

    function prepare() {
      GRIDS.forEach((grid) => {
        document.querySelectorAll<HTMLElement>(grid.selector).forEach((container) => {
          Array.from(container.children).forEach((child) => {
            const el = child as HTMLElement;
            if (el.draggable) return;
            el.draggable = true;
            el.style.cursor = "grab";            if (getComputedStyle(el).position === "static") el.style.position = "relative";            if (!el.querySelector(":scope > .grip-dots")) {              const grip = document.createElement("span");              grip.className = "grip-dots";              grip.setAttribute("aria-hidden", "true");              grip.title = "Drag to reorder";              el.appendChild(grip);            }
          });
          applyOrder(container, grid.key);        });      });      const signedOut = Boolean(document.getElementById("auth-panel"));      const grids = GRIDS.some((grid) => document.querySelector(grid.selector));      const tinted = Boolean(document.querySelector(".chart-track, .hier-bar, .struct-share, .access-pill, .org-tabs, .hier-stat"));      setCanOrder(!signedOut && grids);      setCanColour(!signedOut && (grids || tinted));      if (false) { }        GRIDS.forEach((grid) => {          document.querySelectorAll<HTMLElement>(grid.selector).forEach((container) => {
        });
      });
    }

    function onDragStart(event: DragEvent) {
      const found = containerFor(event.target);
      if (!found) return;
      dragged = childOf(found.el, event.target);
      if (dragged) dragged.style.opacity = "0.45";
    }
    function onDragOver(event: DragEvent) {
      if (dragged) event.preventDefault();
    }
    function onDrop(event: DragEvent) {
      const found = containerFor(event.target);
      if (!found || !dragged) return;
      const target = childOf(found.el, event.target);
      if (!target || target === dragged) return;
      event.preventDefault();

      const kids = Array.from(found.el.children) as HTMLElement[];
      const current = kids
        .slice()
        .sort((a, b) => (Number(a.style.order) || 0) - (Number(b.style.order) || 0))
        .map(cardId);
      const from = current.indexOf(cardId(dragged));
      const to = current.indexOf(cardId(target));
      if (from < 0 || to < 0) return;
      const [moved] = current.splice(from, 1);
      current.splice(to, 0, moved);
      writeOrder(found.key, current);
      applyOrder(found.el, found.key);
    }
    function onDragEnd() {
      if (dragged) dragged.style.opacity = "";
      dragged = null;
    }

    prepare();
    const observer = new MutationObserver(() => prepare());
    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    document.addEventListener("dragend", onDragEnd);
    return () => {
      observer.disconnect();
      document.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("dragend", onDragEnd);
    };
  }, []);

  function resetOrder() {
    GRIDS.forEach((grid) => {
      try {
        localStorage.removeItem(storageKey("order." + grid.key));
      } catch {
        /* ignore */
      }
      document.querySelectorAll<HTMLElement>(grid.selector).forEach((container) => {
        Array.from(container.children).forEach((child) => {
          (child as HTMLElement).style.order = "";
        });
      });
    });
    setOpen(false);
  }

  return (
    !canColour ? null :     <div className="cardtools">
      <button type="button" className="cardtools-btn" onClick={() => setOpen(!open)} title="Colour and card order" aria-expanded={open}>
        <Palette size={17} />
      </button>
      {open ? (
        <div className="cardtools-panel" role="dialog" aria-label="Appearance">
          <span className="cardtools-title">Accent</span>
          <div className="cardtools-swatches">
            {ACCENTS.map((row) => (
              <button
                key={row.id}
                type="button"
                title={row.label}
                aria-label={row.label}
                className={"cardtools-swatch" + (accent === row.value ? " is-on" : "")}
                style={{ background: row.value }}
                onClick={() => chooseAccent(row.value)}
              >
                {accent === row.value ? <Check size={13} /> : null}
              </button>
            ))}
          </div>
          <label className="cardtools-custom">            <span>Custom</span>            <input type="color" value={accent} onChange={(event) => chooseAccent(event.target.value)} />          </label>          <p className="cardtools-note">Quota stays red, amber and green — there the colour is the reading.</p>
          {canOrder ? <button type="button" className="cardtools-reset" onClick={resetOrder}>
            <RotateCcw size={13} /> Reset card order
          </button>
          <p className="cardtools-note">Drag any card to reorder it. Saved for you on this device.</p>
        </div>
      ) : null}
    </div>
  );
}
