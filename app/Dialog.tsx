"use client";

/* One in-app dialog for the whole app, so a confirmation or a short question
 * appears as a card in the middle of the app — never the browser's own
 * window.confirm/window.prompt band dropping from the top, which looks like it
 * belongs to Chrome rather than to Larsa Control.
 *
 * It is promise-based on purpose: window.confirm returns a boolean inline, so
 * every call site can move to `if (await dialog.confirm(...))` with the same
 * shape it already had. dialog.prompt returns the typed string, or null when
 * cancelled, exactly as window.prompt did.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

type DialogKind = "confirm" | "prompt";

type DialogOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  placeholder?: string;
  defaultValue?: string;
  danger?: boolean;
};

type Request = string | DialogOptions;

type Pending = DialogOptions & {
  kind: DialogKind;
  resolve: (value: boolean | string | null) => void;
};

type DialogApi = {
  confirm: (request: Request) => Promise<boolean>;
  prompt: (request: Request) => Promise<string | null>;
};

const DialogContext = createContext<DialogApi | null>(null);

/* Falls back to the native dialogs rather than throwing if something renders
   outside the provider — a missing confirmation must never take an action's
   place silently. */
export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (ctx) return ctx;
  return {
    confirm: (request) =>
      Promise.resolve(window.confirm(typeof request === "string" ? request : request.message)),
    prompt: (request) => {
      const opts = typeof request === "string" ? { message: request } : request;
      return Promise.resolve(window.prompt(opts.message, opts.defaultValue || ""));
    },
  };
}

function normalise(request: Request): DialogOptions {
  return typeof request === "string" ? { message: request } : request;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const openDialog = useCallback(
    (kind: DialogKind, request: Request): Promise<boolean | string | null> => {
      const opts = normalise(request);
      setValue(opts.defaultValue || "");
      return new Promise((resolve) => setPending({ kind, ...opts, resolve }));
    },
    [],
  );

  const api = useMemo<DialogApi>(
    () => ({
      confirm: (request) => openDialog("confirm", request) as Promise<boolean>,
      prompt: (request) => openDialog("prompt", request) as Promise<string | null>,
    }),
    [openDialog],
  );

  /* Resolving clears the pending request; the cancel value depends on the
     kind so a dismissed confirm reads false and a dismissed prompt reads
     null, matching the native dialogs each site replaced. */
  const settle = useCallback((result: boolean | string | null) => {
    setPending((current) => {
      current?.resolve(result);
      return null;
    });
  }, []);

  const cancelValue = pending?.kind === "confirm" ? false : null;

  useEffect(() => {
    if (!pending) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") settle(pending?.kind === "confirm" ? false : null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, settle]);

  useEffect(() => {
    if (pending?.kind === "prompt") {
      const id = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(id);
    }
  }, [pending]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {pending ? (
        <div className="modal-layer" onMouseDown={() => settle(cancelValue)} role="presentation">
          <section
            className="dialog-card"
            role="alertdialog"
            aria-modal="true"
            aria-label={pending.title || pending.message}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {pending.title ? <h2 className="dialog-title">{pending.title}</h2> : null}
            <p className="dialog-msg">{pending.message}</p>
            {pending.kind === "prompt" ? (
              <input
                ref={inputRef}
                className="dialog-input"
                type="text"
                value={value}
                placeholder={pending.placeholder || ""}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") settle(value);
                }}
              />
            ) : null}
            <div className="dialog-actions">
              <button type="button" className="dialog-cancel" onClick={() => settle(cancelValue)}>
                {pending.cancelLabel || "Cancel"}
              </button>
              <button
                type="button"
                className={"dialog-confirm" + (pending.danger ? " is-danger" : "")}
                onClick={() => settle(pending.kind === "confirm" ? true : value)}
              >
                {pending.confirmLabel || "OK"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </DialogContext.Provider>
  );
}
