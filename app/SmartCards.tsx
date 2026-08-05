"use client";

/* The smart card grid.
 *
 * What it replaces: a fixed `repeat(6, 1fr)` grid where the first two cards
 * spanned 3 and everything else spanned 2. That is tuned for one card count
 * and falls apart at every other one — three cards left two thirds of a row
 * empty, six cards ended with a single card alone under two blank thirds.
 * Since every person sees a different number of cards depending on their
 * permissions, "one specific count" is the one thing the layout could never
 * rely on.
 *
 * The fix is to compute the row plan from the count instead of hardcoding it.
 * Six columns divide cleanly by both 2 and 3, so a row is either two halves
 * or three thirds, and every count above one decomposes into those two shapes
 * with nothing left over. That is what makes the grid hole-free by
 * construction rather than by patching the last child.
 *
 * Everything here is deliberately pure and exported: the layout maths is the
 * part worth testing, and it is much easier to prove "five cards never leave a
 * sixth-card gap" against a function than against a rendered page. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------- presets
export const CARD_SIZES = ["standard", "wide", "tall", "large", "full"] as const;
export type CardSize = (typeof CARD_SIZES)[number];

/* Six columns is the whole trick. Two-column and three-column rows both
   divide it exactly, so mixing halves and thirds never leaves a fraction. */
export const GRID_COLUMNS = 6;

export const SIZE_SPECS: Record<CardSize, { cols: number; rows: number; label: string }> = {
  standard: { cols: 2, rows: 1, label: "Standard" },
  wide:     { cols: 3, rows: 1, label: "Wide" },
  tall:     { cols: 2, rows: 2, label: "Tall" },
  large:    { cols: 3, rows: 2, label: "Large" },
  full:     { cols: 6, rows: 1, label: "Full width" },
};

export type SmartCard = {
  /* Stable across renames and translations. Saved layouts key off this, which
     is why it must never be the visible title. */
  id: string;
  /* Which shapes this card's content survives. A card whose body is a single
     line of navigation text has no business being Large, and one with a dense
     figure list should not be squeezed to a third. Declaring it per card is
     what stops a size preset from clipping content. */
  sizes?: CardSize[];
  node: React.ReactNode;
};

export function supportedSizes(card: SmartCard): CardSize[] {
  const declared = card.sizes?.filter((size) => CARD_SIZES.includes(size));
  return declared && declared.length ? declared : ["standard"];
}

// ------------------------------------------------------------ the row plan
/* Decompose a count into rows of three and rows of two, with no remainder.
 *
 *   n % 3 == 0  ->  all threes
 *   n % 3 == 2  ->  threes, plus one pair
 *   n % 3 == 1  ->  drop one three, add two pairs (3+1 == 2+2)
 *
 * Pairs lead, so the larger cards sit at the top. That keeps the existing
 * Larsa look, where the first cards on Home are the wide ones, instead of
 * reshuffling the visual hierarchy people already know. */
export function rowPlanFor(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [1];
  if (count === 2) return [2];

  const remainder = count % 3;
  let threes = Math.floor(count / 3);
  let pairs = 0;

  if (remainder === 2) {
    pairs = 1;
  } else if (remainder === 1) {
    // 3 + 1 is the awkward case: one card alone. Trading a three for two
    // pairs turns it into 2 + 2, which fills both rows exactly.
    threes -= 1;
    pairs = 2;
  }

  return [...Array(pairs).fill(2), ...Array(threes).fill(3)];
}

/* The column span each card gets under the smart default, in order. Always
   sums to a whole number of full rows — that is the guarantee the old CSS
   could not make. */
export function smartDefaultSpans(count: number): number[] {
  const spans: number[] = [];
  rowPlanFor(count).forEach((perRow) => {
    // One card in its own row is the single-card case; it is capped by
    // max-width in CSS rather than stretched across the page.
    const span = perRow === 1 ? GRID_COLUMNS : GRID_COLUMNS / perRow;
    for (let i = 0; i < perRow; i += 1) spans.push(span);
  });
  return spans.slice(0, count);
}

// --------------------------------------------------------------- validation
/* How many grid cells a set of spans leaves empty at the end of rows. Zero is
   the only acceptable answer for a saved layout — a hole is exactly the
   "unfinished" look this whole component exists to remove. */
export function layoutHoles(spans: number[], columns = GRID_COLUMNS): number {
  let used = 0;
  let holes = 0;
  spans.forEach((span) => {
    const width = Math.min(Math.max(span, 1), columns);
    if (used + width > columns) {
      holes += columns - used;   // the tail of the row this card could not fit
      used = width;
    } else {
      used += width;
    }
    if (used === columns) used = 0;
  });
  if (used > 0) holes += columns - used;
  return holes;
}

// ------------------------------------------------------------ saved layouts
export const LAYOUT_VERSION = 1;
export const LAYOUT_STORE_KEY = "larsaCardLayoutsV1";

export type SavedLayout = {
  version: number;
  order: string[];
  sizes: Record<string, CardSize>;
  updatedAt: string;
};

/* Device class is part of the key because a Wide card is a sensible choice on
   a desktop and a meaningless one on a phone, where everything is a single
   column anyway. Keeping them apart is what stops a desktop preference from
   producing a broken mobile layout. */
export function deviceClass(width: number): "mobile" | "tablet" | "desktop" {
  if (width <= 720) return "mobile";
  if (width <= 1100) return "tablet";
  return "desktop";
}

export function layoutKey(userId: string, pageKey: string, device: string) {
  return `${userId || "anon"}::${pageKey}::${device}`;
}

/* Saved layouts are untrusted input: they outlive the code that wrote them,
 * they survive module renames, and a determined person can edit them by hand.
 * So this never trusts what it reads. It intersects the saved order with the
 * cards the caller has ALREADY filtered by permission, which is what makes
 * hand-editing the stored JSON pointless — an id that is not in `cards` was
 * never authorized and simply does not appear. Sizes the card does not
 * support are dropped rather than honoured. */
export function sanitizeLayout(raw: unknown, cards: SmartCard[]): SavedLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const saved = raw as Partial<SavedLayout>;
  if (saved.version !== LAYOUT_VERSION) return null;

  const byId = new Map(cards.map((card) => [card.id, card]));
  const savedOrder = Array.isArray(saved.order) ? saved.order : [];

  // Known ids first, in the saved order; then anything newly granted, which
  // lands at the end rather than displacing what the person arranged.
  const kept = savedOrder.filter((id) => byId.has(id));
  const seen = new Set(kept);
  const order = [...kept, ...cards.map((card) => card.id).filter((id) => !seen.has(id))];

  const sizes: Record<string, CardSize> = {};
  const savedSizes = (saved.sizes && typeof saved.sizes === "object" ? saved.sizes : {}) as Record<string, unknown>;
  order.forEach((id) => {
    const card = byId.get(id);
    if (!card) return;
    const wanted = savedSizes[id];
    const allowed = supportedSizes(card);
    if (typeof wanted === "string" && (allowed as string[]).includes(wanted)) {
      sizes[id] = wanted as CardSize;
    }
  });

  return { version: LAYOUT_VERSION, order, sizes, updatedAt: String(saved.updatedAt || "") };
}

function readAll(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(LAYOUT_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function loadLayout(key: string, cards: SmartCard[]): SavedLayout | null {
  if (typeof window === "undefined") return null;
  return sanitizeLayout(readAll()[key], cards);
}

export function saveLayout(key: string, layout: SavedLayout) {
  if (typeof window === "undefined") return;
  try {
    const all = readAll();
    all[key] = { ...layout, version: LAYOUT_VERSION, updatedAt: new Date().toISOString() };
    localStorage.setItem(LAYOUT_STORE_KEY, JSON.stringify(all));
  } catch {
    /* A full or disabled store just means the smart default keeps applying. */
  }
}

export function clearLayout(key: string) {
  if (typeof window === "undefined") return;
  try {
    const all = readAll();
    delete all[key];
    localStorage.setItem(LAYOUT_STORE_KEY, JSON.stringify(all));
  } catch { /* nothing to undo */ }
}

// ------------------------------------------------------------ auto arrange
/* Re-sorts sizes into an arrangement that fills every row, keeping the
   person's order. Widest first within the constraint, because a Large card
   trailing a row of thirds is what creates a hole. */
export function autoArrangeSizes(
  order: string[], cards: SmartCard[], sizes: Record<string, CardSize>,
): Record<string, CardSize> {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const spans = order.map((id) => {
    const size = sizes[id];
    return size ? SIZE_SPECS[size].cols : SIZE_SPECS.standard.cols;
  });
  if (layoutHoles(spans) === 0) return sizes;

  // Fall back to the smart default shape, honouring each card's declared
  // support: a card that cannot be Wide keeps whatever it can be.
  const wanted = smartDefaultSpans(order.length);
  const next: Record<string, CardSize> = {};
  order.forEach((id, index) => {
    const card = byId.get(id);
    if (!card) return;
    const allowed = supportedSizes(card);
    const target = (Object.keys(SIZE_SPECS) as CardSize[])
      .find((size) => SIZE_SPECS[size].cols === wanted[index] && SIZE_SPECS[size].rows === 1
        && allowed.includes(size));
    if (target && target !== "standard") next[id] = target;
  });
  return next;
}

// ------------------------------------------------------------- the component
export function SmartCardGrid({
  cards, pageKey, userId, label, className = "", customizable = true,
}: {
  cards: SmartCard[];
  pageKey: string;
  userId: string;
  label: string;
  className?: string;
  customizable?: boolean;
}) {
  const [device, setDevice] = useState<"mobile" | "tablet" | "desktop">("desktop");
  const [editing, setEditing] = useState(false);
  const [draftOrder, setDraftOrder] = useState<string[]>([]);
  const [draftSizes, setDraftSizes] = useState<Record<string, CardSize>>({});
  const [saved, setSaved] = useState<SavedLayout | null>(null);
  const [notice, setNotice] = useState("");
  const [dragId, setDragId] = useState("");
  const loadedFor = useRef("");
  const barRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLElement>(null);

  const key = layoutKey(userId, pageKey, device);

  useEffect(() => {
    const measure = () => setDevice(deviceClass(window.innerWidth));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  /* Reading the saved layout is keyed on the storage key, so it re-reads when
     the device class changes but not on every render. loadedFor stops a
     second pass from clobbering an edit in progress. */
  useEffect(() => {
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    setSaved(loadLayout(key, cards));
  }, [key, cards]);

  const cardIds = useMemo(() => cards.map((card) => card.id).join("|"), [cards]);

  /* The order actually rendered. A saved layout wins; otherwise the cards
     arrive in the order the page already decided, which is the smart default.
     Either way the list is derived from `cards` — the permission-filtered
     list — so nothing unauthorized can enter through a saved preference. */
  const activeOrder = useMemo(() => {
    const byId = new Map(cards.map((card) => [card.id, card]));
    if (!saved) return cards.map((card) => card.id);
    const kept = saved.order.filter((id) => byId.has(id));
    const seen = new Set(kept);
    return [...kept, ...cards.map((card) => card.id).filter((id) => !seen.has(id))];
    // cardIds is the cheap identity check for "the visible set changed".
  }, [saved, cards, cardIds]);

  const activeSizes = saved?.sizes || {};
  const order = editing ? draftOrder : activeOrder;
  const sizes = editing ? draftSizes : activeSizes;

  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);

  /* Spans for what is on screen. On a phone everything is one per row, so
     desktop presets are ignored rather than shrunk into something unusable. */
  const spans = useMemo(() => {
    if (device === "mobile") return order.map(() => GRID_COLUMNS);
    const anyCustom = order.some((id) => sizes[id]);
    if (!anyCustom) return smartDefaultSpans(order.length);
    return order.map((id) => {
      const size = sizes[id];
      return size ? SIZE_SPECS[size].cols : SIZE_SPECS.standard.cols;
    });
  }, [order, sizes, device]);

  const rowSpans = useMemo(() => order.map((id) => {
    if (device === "mobile") return 1;
    const size = sizes[id];
    return size ? SIZE_SPECS[size].rows : 1;
  }), [order, sizes, device]);

  const holes = useMemo(() => (device === "mobile" ? 0 : layoutHoles(spans)), [spans, device]);

  const startEditing = () => {
    setDraftOrder(activeOrder);
    setDraftSizes({ ...activeSizes });
    setNotice("");
    setEditing(true);
  };

  const move = (id: string, delta: number) => {
    setDraftOrder((current) => {
      const index = current.indexOf(id);
      const next = index + delta;
      if (index < 0 || next < 0 || next >= current.length) return current;
      const copy = [...current];
      copy.splice(index, 1);
      copy.splice(next, 0, id);
      return copy;
    });
  };

  const setSize = (id: string, size: CardSize) => {
    setDraftSizes((current) => {
      const next = { ...current };
      if (size === "standard") delete next[id]; else next[id] = size;
      return next;
    });
    setNotice("");
  };

  const commit = () => {
    const draftSpans = draftOrder.map((id) => {
      const size = draftSizes[id];
      return size ? SIZE_SPECS[size].cols : SIZE_SPECS.standard.cols;
    });
    // A layout with a hole in it is exactly what this component exists to
    // prevent, so it is not saveable. Saying which sizes cause it beats a
    // bare refusal.
    if (layoutHoles(draftSpans) > 0) {
      setNotice("Those sizes leave a gap in the grid. Use Auto Arrange, or change a card's size, then save.");
      return;
    }
    saveLayout(key, { version: LAYOUT_VERSION, order: draftOrder, sizes: draftSizes, updatedAt: "" });
    setSaved({ version: LAYOUT_VERSION, order: draftOrder, sizes: draftSizes, updatedAt: "" });
    setEditing(false);
    setNotice("");
  };

  /* Clicking anywhere outside the editor finishes it, the way a dynamic
     window closes when you move on. A valid layout is saved on the way out so
     the arrangement is never lost; a layout that still has a gap cannot be
     saved, so the unsaveable draft is simply dropped rather than kept open
     forever. */
  const finishOnOutside = useCallback(() => {
    const draftSpans = draftOrder.map((id) => {
      const size = draftSizes[id];
      return size ? SIZE_SPECS[size].cols : SIZE_SPECS.standard.cols;
    });
    if (layoutHoles(draftSpans) > 0) {
      setEditing(false);
      setNotice("");
      return;
    }
    saveLayout(key, { version: LAYOUT_VERSION, order: draftOrder, sizes: draftSizes, updatedAt: "" });
    setSaved({ version: LAYOUT_VERSION, order: draftOrder, sizes: draftSizes, updatedAt: "" });
    setEditing(false);
    setNotice("");
  }, [draftOrder, draftSizes, key]);

  const autoArrange = () => {
    setDraftSizes(autoArrangeSizes(draftOrder, cards, draftSizes));
    setNotice("");
  };

  const resetDefault = () => {
    clearLayout(key);
    setSaved(null);
    setDraftOrder(cards.map((card) => card.id));
    setDraftSizes({});
    setNotice("Back to the recommended layout. Your access has not changed.");
  };

  const onDrop = useCallback((targetId: string) => {
    if (!dragId || dragId === targetId) return;
    setDraftOrder((current) => {
      const from = current.indexOf(dragId);
      const to = current.indexOf(targetId);
      if (from < 0 || to < 0) return current;
      const copy = [...current];
      copy.splice(from, 1);
      copy.splice(to, 0, dragId);
      return copy;
    });
    setDragId("");
  }, [dragId]);

  /* Finish the layout editor on a click outside the bar and the grid. Only
     listens while editing; a click during a drag lands inside the grid, so it
     never interrupts a reorder. */
  useEffect(() => {
    if (!editing) return;
    function onDown(event: MouseEvent) {
      const target = event.target as Node;
      if (barRef.current?.contains(target)) return;
      if (gridRef.current?.contains(target)) return;
      finishOnOutside();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [editing, finishOnOutside]);

  if (!cards.length) return null;

  return (
    <>
      {customizable && (
        <div className="smart-grid-bar" ref={barRef}>
          {editing ? (
            <>
              <span className="smart-grid-flag">Customising layout</span>
              <div className="smart-grid-actions">
                <button type="button" onClick={autoArrange}>Auto Arrange</button>
                <button type="button" onClick={resetDefault}>Reset to Default</button>
                <button type="button" onClick={() => { setEditing(false); setNotice(""); }}>Cancel</button>
                <button type="button" className="primary" onClick={commit}>Save layout</button>
              </div>
            </>
          ) : (
            <button type="button" className="smart-grid-customise" onClick={startEditing}>
              Customize Layout
            </button>
          )}
        </div>
      )}
      {editing && notice && <p className="smart-grid-note" role="alert">{notice}</p>}
      {editing && !notice && holes > 0 && (
        <p className="smart-grid-note">These sizes leave a gap. Auto Arrange will close it.</p>
      )}

      <section
        ref={gridRef}
        className={`module-grid smart-grid ${editing ? "is-editing" : ""} ${className}`}
        aria-label={label}
        style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))` }}
      >
        {order.map((id, index) => {
          const card = byId.get(id);
          if (!card) return null;                       // an id that outlived its module
          const allowed = supportedSizes(card);
          return (
            <div
              key={id}
              className="smart-cell"
              style={{ gridColumn: `span ${spans[index]}`, gridRow: `span ${rowSpans[index]}` }}
              draggable={editing}
              onDragStart={() => setDragId(id)}
              onDragOver={(event) => { if (editing) event.preventDefault(); }}
              onDrop={() => onDrop(id)}
            >
              {editing && (
                <div className="smart-cell-tools">
                  {/* Drag is the fast path; the arrows are the one that works
                      with a keyboard and on a touch screen. */}
                  <span className="smart-drag" aria-hidden="true">⠿</span>
                  <button type="button" aria-label={`Move ${id} earlier`}
                    onClick={() => move(id, -1)} disabled={index === 0}>↑</button>
                  <button type="button" aria-label={`Move ${id} later`}
                    onClick={() => move(id, 1)} disabled={index === order.length - 1}>↓</button>
                  {allowed.length > 1 && (
                    <select
                      aria-label={`Size for ${id}`}
                      value={sizes[id] || "standard"}
                      onChange={(event) => setSize(id, event.target.value as CardSize)}
                    >
                      {allowed.map((size) => (
                        <option key={size} value={size}>{SIZE_SPECS[size].label}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              {/* While editing, the card must not navigate: a drag that ends
                  in a click would otherwise leave the page mid-rearrange. */}
              <div className={editing ? "smart-cell-body is-locked" : "smart-cell-body"}
                inert={editing}>
                {card.node}
              </div>
            </div>
          );
        })}
      </section>
    </>
  );
}
