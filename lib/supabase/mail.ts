"use client";

/* Sends an email through Microsoft Graph (as the notifications@larsaeng.com
 * shared mailbox) via the send-mail Edge Function -- same call shape as
 * lib/supabase/push.ts's sendPush. Needs three things to actually deliver,
 * all set as secrets on the Supabase project's Edge Functions (never here,
 * never in the client bundle): MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID,
 * MS_GRAPH_CLIENT_SECRET. Without Supabase configured this whole module is
 * a no-op, exactly like lib/supabase/sync.ts. */
import { getSupabaseClient, supabaseConfigured } from "./client";

type SendMailParams = {
    to: string | string[];
    subject: string;
    html: string;
    cc?: string | string[];
};

/* Fire-and-forget: asks the send-mail Edge Function to deliver an email.
 * Never throws -- matches sendPush's contract so a failed email never blocks
 * whatever UI action triggered it. Await client.functions.invoke directly
 * at a call site instead if you need to confirm delivery. */
export function sendMail({ to, subject, html, cc }: SendMailParams): void {
    if (!supabaseConfigured()) return;
    const client = getSupabaseClient();
    if (!client) return;
    client.functions.invoke("send-mail", { body: { to, subject, html, cc } }).catch(() => {
          // Best-effort only, matching sendPush.
    });
}
