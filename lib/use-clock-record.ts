"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseClient } from "./supabase/client";

export type ShiftPunch = { id: string; status: "In" | "Out"; time: string; type: string };
export type ClockRecord = {
  uid: string;
  state: "checking" | "confirmed" | "unavailable";
  punch: ShiftPunch | null;
};

export function useClockRecord(uid: string | undefined, connected: boolean) {
  const [record, setRecord] = useState<ClockRecord | null>(null);
  const refreshRef = useRef<(() => Promise<boolean>) | null>(null);
  const refresh = useCallback(() => refreshRef.current?.() ?? Promise.resolve(false), []);

  useEffect(() => {
    const client = uid && connected ? getSupabaseClient() : null;
    if (!uid || !client) {
      setRecord(null);
      return;
    }
    let disposed = false;
    let current: AbortController | null = null;
    function publish(next: ClockRecord) {
      setRecord(old => old?.uid === next.uid && old.state === next.state
        && old.punch?.id === next.punch?.id && old.punch?.status === next.punch?.status
        && old.punch?.time === next.punch?.time && old.punch?.type === next.punch?.type ? old : next);
    }
    const read = async () => {
      if (disposed || document.hidden) return false;
      current?.abort();
      const request = new AbortController();
      current = request;
      let deadline: number | undefined;
      try {
        const query = client.rpc("latest_attendance_shift", { p_uid: uid })
          .abortSignal(request.signal).maybeSingle<{ id: string; status: "In" | "Out"; occurred_at: string; work_mode: string | null }>();
        const { data, error } = await Promise.race([query, new Promise<never>((_, reject) => {
          deadline = window.setTimeout(() => {
            request.abort();
            reject(new Error("Clock read timed out"));
          }, 6000);
        })]);
        if (disposed || current !== request) return false;
        if (error || request.signal.aborted) throw new Error("Clock read failed");
        if (data && ((data.status !== "In" && data.status !== "Out") || !data.id
          || !Number.isFinite(Date.parse(data.occurred_at)))) throw new Error("Invalid clock record");
        publish({ uid, state: "confirmed", punch: data ? {
          id: data.id, status: data.status, time: data.occurred_at, type: data.work_mode || "Office",
        } : null });
        return true;
      } catch {
        if (!disposed && current === request) publish({ uid, state: "unavailable", punch: null });
        return false;
      } finally {
        window.clearTimeout(deadline);
        if (current === request) current = null;
      }
    };
    const onResume = () => {
      if (document.hidden) {
        current?.abort();
        current = null;
      }
      publish({ uid, state: "checking", punch: null });
      if (!document.hidden) void read();
    };
    const onRemote = (event: Event) => {
      const changed = (event as CustomEvent<{events?: {uid: string}[]}>).detail?.events;
      if (changed?.some(row => row.uid === uid)) onResume();
    };
    refreshRef.current = read;
    onResume();
    const timer = window.setInterval(() => { if (!current && !document.hidden) void read(); }, 5000);
    window.addEventListener("focus", onResume);
    window.addEventListener("online", onResume);
    window.addEventListener("pageshow", onResume);
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("larsa:attendance-realtime", onRemote);
    return () => {
      disposed = true;
      current?.abort();
      refreshRef.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("online", onResume);
      window.removeEventListener("pageshow", onResume);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("larsa:attendance-realtime", onRemote);
    };
  }, [uid, connected]);
  return { record: connected && record?.uid === uid ? record : null, refresh };
}
