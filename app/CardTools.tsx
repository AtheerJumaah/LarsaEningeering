"use client";

/* Card tools: pick the accent colour, and reorder any card grid by dragging.
 *
 * One layer mounted from the layout rather than edits to every screen. Card
 * grids appear in a dozen places and the app's biggest file is 577 KB, so
 * attaching by delegation is both safer and reaches grids added later.
 *
 * Order is applied with the CSS order property, never by moving DOM nodes:
 * nodes React owns get put back on the next render, a style survives. A
 * MutationObserver reapplies everything if React replaces an element outright.
 *
 * The control only appears where it can change something. On the sign-in card
 * there is nothing to reorder and nothing tinted, so it stays hidden.
 *
 * Both settings are per person, per device. Syncing them to the staff record is
 * the better home, but that record rides in the shared blob and the database
 * trigger does not protect preference fields yet.
 */

import { useEffect, useState } from "react";
import { Check, Palette, RotateCcw } from "lucide-react";

const GRIDS = [
  { selector: ".module-grid:not(.quick-grid)", key: "areas" },
  { selector: ".quick-action-row", key: "quick" },
  { selector: ".module-grid.quick-grid", key: "quickcards" },
];

const TINTED = ".chart-track, .hier-bar, .struct-share, .access-pill, .org-tabs, .hier-stat";

const ACCENTS = [  { id: "white", label: "White", value: "#ffffff" },  { id: "pearl", label: "Pearl", value: "#e8eaee" },  { id: "sandlight", label: "Light sand", value: "#e2d4bd" },  { id: "skylight", label: "Light sky", value: "#bfd6ef" },  { id: "mintlight", label: "Light mint", value: "#bfe0cb" },  { id: "roselight", label: "Light rose", value: "#efc6cf" },  { id: "emerald", label: "Emerald", value: "#047857" },  { id: "indigo", label: "Indigo", value: "#4338ca" },  { id: "crimson", label: "Crimson", value: "#be123c" },  { id: "orange", label: "Orange", value: "#c2410c" },  { id: "cyan", label: "Cyan", value: "#0e7490" },  { id: "plum", label: "Plum", value: "#86198f" },  { id: "olive", label: "Olive", value: "#4d7c0f" },  { id: "navy", label: "Navy", value: "#1e3a8a" },
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

/* A card is identified by its label, not its position: positions change the
   moment somebody reorders, the label does not. */
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
  const [open, setOpen] = useState(false);
  const [accent, setAccent] = useState("#17181b");
  const [canOrder, setCanOrder] = useState(false);
  const [canColour, setCanColour] = useState(false);  const [surface, setSurface] = useState("");  const [dense, setDense] = useState(false);

  useEffect(() => {
    let stored = "";
    try {
      stored = localStorage.getItem(storageKey("accent")) || "";
    } catch {
      stored = "";
    }
    let tone = "";    try { tone = localStorage.getItem(storageKey("surface")) || ""; } catch { tone = ""; }    if (tone) { setSurface(tone); document.documentElement.style.setProperty("--larsa-surface", tone); }    let density = "";    try { density = localStorage.getItem(storageKey("density")) || ""; } catch { density = ""; }    if (density === "compact") { setDense(true); document.documentElement.setAttribute("data-density", "compact"); }    if (stored) {
      setAccent(stored);
      document.documentElement.style.setProperty("--larsa-accent", stored);
    }
  }, []);

const SURFACES = [ { id: "default", label: "Default", value: "" }, { id: "warm", label: "Warm", value: "#faf7f2" }, { id: "cool", label: "Cool", value: "#f4f7fb" }, { id: "mint", label: "Mint", value: "#f3f9f5" }, { id: "rose", label: "Rose", value: "#fbf5f6" }, { id: "grey", label: "Grey", value: "#f2f3f5" }, { id: "sand", label: "Sand", value: "#ece3d5" }, { id: "stone", label: "Stone", value: "#e6e3dd" }, { id: "sky", label: "Sky", value: "#dfe9f6" }, { id: "sage", label: "Sage", value: "#dfe9e0" }, { id: "blush", label: "Blush", value: "#f2dfe2" }, { id: "steel", label: "Steel", value: "#dde2e9" }, { id: "lilac", label: "Lilac", value: "#e6e2f4" }, { id: "clay", label: "Clay", value: "#ecdfd8" }, { id: "slateblue", label: "Slate blue", value: "#d6dde7" }, { id: "graphite", label: "Graphite", value: "#d5d7db" } ];function chooseDense(value: boolean) {    setDense(value);    if (value) document.documentElement.setAttribute("data-density", "compact");    else document.documentElement.removeAttribute("data-density");    try { if (value) localStorage.setItem(storageKey("density"), "compact"); else localStorage.removeItem(storageKey("density")); } catch { /* ignore */ }  }    function chooseSurface(value: string) {    setSurface(value);    if (value) document.documentElement.style.setProperty("--larsa-surface", value);    else document.documentElement.style.removeProperty("--larsa-surface");    try { if (value) localStorage.setItem(storageKey("surface"), value); else localStorage.removeItem(storageKey("surface")); } catch { /* ignore */ }  }function onAccent(hex: string): string {    const clean = hex.replace("#", "");    if (clean.length !== 6) return "#ffffff";    const rr = parseInt(clean.slice(0, 2), 16);    const gg = parseInt(clean.slice(2, 4), 16);    const bb = parseInt(clean.slice(4, 6), 16);    const luma = (rr * 299 + gg * 587 + bb * 114) / 1000;    return luma > 165 ? "#17181b" : "#ffffff";  }    function chooseAccent(value: string) {
    setAccent(value);
    document.documentElement.style.setProperty("--larsa-accent", value);    document.documentElement.style.setProperty("--larsa-on-accent", onAccent(value));
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
            if (!el.draggable) {
              el.draggable = true;
              el.style.cursor = "grab";
            }
            if (getComputedStyle(el).position === "static") el.style.position = "relative";
            if (!el.querySelector(":scope > .grip-dots")) {
              const grip = document.createElement("span");
              grip.className = "grip-dots";
              grip.setAttribute("aria-hidden", "true");
              grip.title = "Drag to reorder";
              el.appendChild(grip);
            }
          });
          applyOrder(container, grid.key);
        });
      });

      const shell = document.querySelector(".native.active, .native, main");      let isDark = false;      if (shell) {        const rgb = getComputedStyle(shell).backgroundColor.match(/\d+/g);        if (rgb && rgb.length >= 3) {          const luma = (Number(rgb[0]) * 299 + Number(rgb[1]) * 587 + Number(rgb[2]) * 114) / 1000;          const opaque = rgb.length < 4 || Number(rgb[3]) > 0;          isDark = opaque && luma < 110;        }      }      if (!isDark) {        const page = getComputedStyle(document.body).backgroundColor.match(/\d+/g);        if (page && page.length >= 3) {          const luma = (Number(page[0]) * 299 + Number(page[1]) * 587 + Number(page[2]) * 114) / 1000;          if (luma < 110) isDark = true;        }      }      document.documentElement.setAttribute("data-mode", isDark ? "dark" : "light");      const signedOut = Boolean(document.getElementById("auth-panel"));
      const grids = GRIDS.some((grid) => document.querySelector(grid.selector));
      const tinted = Boolean(document.querySelector(TINTED));
      setCanOrder(!signedOut && grids);
      setCanColour(!signedOut && (grids || tinted));
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

  if (!canColour) return null;

  return (
    <div className="cardtools">
      <button type="button" className="cardtools-btn" onClick={() => setOpen(!open)} title="Appearance" aria-expanded={open}>
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
          <span className="cardtools-title">Background</span>          <div className="cardtools-swatches">            {SURFACES.map((row) => (              <button key={row.id} type="button" title={row.label} aria-label={row.label} className={"cardtools-swatch cardtools-tone" + (surface === row.value ? " is-on" : "")} style={{ background: row.value || "#ffffff" }} onClick={() => chooseSurface(row.value)}>{surface === row.value ? <Check size={13} /> : null}</button>            ))}          </div>          <label className="cardtools-custom">
            <span>Custom</span>
            <input type="color" value={accent} onChange={(event) => chooseAccent(event.target.value)} />
          </label>
          <p className="cardtools-note">Quota stays red, amber and green. There the colour is the reading.</p>          <span className="cardtools-title">Density</span>          <div className="cardtools-density">            <button type="button" className={dense ? "" : "is-on"} onClick={() => chooseDense(false)}>Comfortable</button>            <button type="button" className={dense ? "is-on" : ""} onClick={() => chooseDense(true)}>Compact</button>          </div>
          {canOrder ? (
            <>
              <button type="button" className="cardtools-reset" onClick={resetOrder}>
                <RotateCcw size={13} /> Reset card order
              </button>
              <p className="cardtools-note">Drag any card by its dots to reorder it.</p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
