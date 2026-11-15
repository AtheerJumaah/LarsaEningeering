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

import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { registerBackCloser } from "./backstack";

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
  const active = useRef<Pending | null>(null);
  const queue = useRef<Pending[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const id = useId();

  const openDialog = useCallback(
    (kind: DialogKind, request: Request): Promise<boolean | string | null> => {
      const opts = normalise(request);
      return new Promise((resolve) => {
        const next = { kind, ...opts, resolve };
        if (active.current) {
          queue.current.push(next);
          return;
        }
        active.current = next;
        setValue(next.defaultValue ?? "");
        setPending(next);
      });
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

  const settle = useCallback((result: boolean | string | null) => {
    const current = active.current;
    if (!current) return;
    const next = queue.current.shift() ?? null;
    active.current = next;
    setValue(next?.defaultValue ?? "");
    setPending(next);
    current.resolve(result);
  }, []);

  const cancelValue = pending?.kind === "confirm" ? false : null;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!pending) {
      if (dialog.open) {
        dialog.close();
        if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
        opener.current = null;
      }
      return;
    }
    if (!dialog.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    if (pending.kind === "prompt") inputRef.current?.focus();
    else cancelRef.current?.focus();
    /* The phone's Back button closes an open dialog exactly like Escape does,
       instead of navigating (or leaving the app) underneath it. */
    return registerBackCloser(() => settle(cancelValue));
  }, [pending, cancelValue, settle]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      <dialog
        ref={dialogRef}
        className="in-app-dialog"
        role={pending?.kind === "confirm" ? "alertdialog" : "dialog"}
        aria-labelledby={pending?.title ? `${id}-title` : `${id}-message`}
        aria-describedby={pending?.title ? `${id}-message` : undefined}
        onCancel={(event) => { event.preventDefault(); settle(cancelValue); }}
        onClick={(event) => { if (event.target === event.currentTarget) settle(cancelValue); }}
      >
        {pending ? (
          <section className="dialog-card">
            {pending.title ? <h2 id={`${id}-title`} className="dialog-title">{pending.title}</h2> : null}
            <p id={`${id}-message`} className="dialog-msg">{pending.message}</p>
            {pending.kind === "prompt" ? (
              <input
                ref={inputRef}
                className="dialog-input"
                type="text"
                aria-labelledby={`${id}-message`}
                value={value}
                placeholder={pending.placeholder || ""}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    settle(value);
                  }
                }}
              />
            ) : null}
            <div className="dialog-actions">
              <button ref={cancelRef} type="button" className="dialog-cancel" onClick={() => settle(cancelValue)}>
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
        ) : null}
      </dialog>
    </DialogContext.Provider>
  );
}
