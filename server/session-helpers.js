// server/session-helpers.js
import crypto from "crypto";

/**
 * Factory for session + logging helpers that depend on Supabase + logger.
 */
export function makeSessionHelpers(supabase, logger, PROMPT_CAP) {
  const pickSessionId = (row) => row?.id || row?.session_id || null;

  async function getSessionRow(sessionId) {
    if (!supabase) return { id: sessionId, mode: "guest" };

    let r = await supabase
      .from("sessions")
      .select("*")
      .eq("id", sessionId)
      .maybeSingle();
    if (r?.data) return r.data;

    r = await supabase
      .from("sessions")
      .select("*")
      .eq("session_id", sessionId)
      .maybeSingle();

    return r?.data || null;
  }

  async function logEvent(
    sessionId,
    role,
    content,
    channel = "chat",
    meta = {},
    tokens = null,
  ) {
    if (!supabase) return;
    const { error } = await supabase.from("chat_events").insert({
      session_id: sessionId,
      role,
      content,
      channel,
      meta,
      tokens,
    });
    if (error) logger?.error({ err: error }, "logEvent error");
  }

  async function countUserPrompts(sessionId) {
    if (!supabase) return 0;
    const { count, error } = await supabase
      .from("chat_events")
      .select("*", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("role", "user");

    if (error) throw error;
    return count ?? 0;
  }

  async function createSessionRow(extra = {}) {
    if (!supabase) return { local: true, id: `local_${Date.now()}` };

    const uuid = crypto.randomUUID();
    const tries = [
      { id: uuid, session_id: uuid, ...extra },
      { id: uuid, ...extra },
      { session_id: uuid, ...extra },
      { ...extra },
    ];

    let lastErr;
    for (const payload of tries) {
      const { data, error } = await supabase
        .from("sessions")
        .insert(payload)
        .select("*")
        .single();
      if (!error && data) return data;
      lastErr = error;
    }
    throw lastErr || new Error("Failed to create session");
  }

  // Per-session cap: prefer assignment_snapshot.prompt_cap, else global PROMPT_CAP
  async function getCapForSession(sessionId) {
    if (!supabase) return PROMPT_CAP;
    const session = await getSessionRow(sessionId);
    if (!session) return PROMPT_CAP;

    const snapCap = session.assignment_snapshot?.prompt_cap;
    if (
      typeof snapCap === "number" &&
      Number.isFinite(snapCap) &&
      snapCap > 0
    ) {
      return snapCap;
    }
    return PROMPT_CAP;
  }

  return {
    pickSessionId,
    getSessionRow,
    logEvent,
    countUserPrompts,
    createSessionRow,
    getCapForSession,
  };
}
