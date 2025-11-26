// public/app.js
let sessionId = null;
let cap = 0;
let used = 0;

const msgs = document.querySelector("#msgs");
const form = document.querySelector("#send");
const input = document.querySelector("#input");
const capEl = document.querySelector("#cap");
const makeIndexBtn = document.querySelector("#makeIndex");
const submitBtn = document.querySelector("#submitBtn");

// Declaration modal
const declBackdrop = document.querySelector("#declBackdrop");
const declConfirm = document.querySelector("#declConfirm");
const declCancel = document.querySelector("#declCancel");
const d_onlyWorksy = document.querySelector("#d_onlyWorksy");
const d_noGhost = document.querySelector("#d_noGhost");
const d_independent = document.querySelector("#d_independent");
const d_understand = document.querySelector("#d_understand");
const d_assgn = document.querySelector("#d_assgn");

// --- helpers
function li(role, text) {
  const el = document.createElement("li");
  el.className = role;
  el.textContent = toBullets(text);
  return el;
}

// Clean bullet rendering
function toBullets(md) {
  if (!md) return "•";
  let s = String(md)
    .replace(/\r\n/g, "\n")
    .replace(/(\S)\s+•\s+/g, "$1\n• ") // turn inline bullets into new lines
    .replace(/\s+•\s+(\S)/g, "\n• $1");

  const lines = s.split("\n");
  const out = [];
  for (let raw of lines) {
    let ln = raw.trim();
    if (!ln) continue;

    // strip markdown styling but keep text
    ln = ln.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1");
    ln = ln.replace(/^>\s?/, "").replace(/^\d+\.\s+/, "");

    // headings like "Definition:" shouldn't be bullets
    const head = ln.match(/^([^:]+):\s*(.*)$/);
    if (head && head[1].length <= 24 && /^[A-Z]/.test(head[1])) {
      out.push(`${head[1].trim()}:`);
      if (head[2]) out.push(`• ${head[2].trim()}`);
      continue;
    }

    // handle existing bullet markers
    if (/^[-*•]\s+/.test(ln)) ln = ln.replace(/^[-*•]\s+/, "");
    out.push(`• ${ln}`);
  }
  return out.join("\n");
}

async function start() {
  const r = await fetch("/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "guest" }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  sessionId = j.sessionId;
  cap = j.cap;
  used = 0;
  capEl.textContent = `Session ${sessionId.slice(0, 8)}… • ${used}/${cap}`;
}

async function send(message) {
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  used = j.used;
  capEl.textContent = `Session ${sessionId.slice(0, 8)}… • ${used}/${cap}`;
  return j.reply;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !sessionId) return;
  msgs.appendChild(li("user", text));
  input.value = "";
  try {
    const reply = await send(text);
    msgs.appendChild(li("assistant", reply));
    msgs.scrollTop = msgs.scrollHeight;
  } catch (err) {
    msgs.appendChild(li("error", err.message));
  }
});

makeIndexBtn?.addEventListener("click", async () => {
  if (!sessionId) return alert("Start a session first");
  const r = await fetch(
    `/api/ai-index?sessionId=${encodeURIComponent(sessionId)}`,
  );
  const j = await r.json();
  if (j.error) return alert(j.error);
  if (j.url) window.open(j.url, "_blank");
});

// Submit flow
submitBtn?.addEventListener("click", () => {
  if (!sessionId) return alert("Start a session first");
  declBackdrop.classList.add("show");
});

declCancel?.addEventListener("click", () => {
  declBackdrop.classList.remove("show");
});

let submitting = false;
declConfirm?.addEventListener("click", async () => {
  if (submitting) return;
  if (
    !d_onlyWorksy.checked ||
    !d_noGhost.checked ||
    !d_independent.checked ||
    !d_understand.checked
  ) {
    alert("Please tick all declaration boxes.");
    return;
  }
  const assignmentId = d_assgn.value.trim();
  if (!assignmentId) return alert("Please enter your Assignment ID.");

  const declaration = {
    onlyWorksy: true,
    noGhost: true,
    independent: true,
    understand: true,
    assignmentId,
    version: "2025-10-27",
  };

  try {
    submitting = true;
    declConfirm.disabled = true;
    declConfirm.textContent = "Submitting…";

    const r = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, declaration }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);

    input.disabled = true;
    submitBtn.disabled = true;
    capEl.textContent = `Session ${sessionId.slice(0, 8)}… • LOCKED`;
    msgs.appendChild(
      li(
        "assistant",
        "Session submitted and locked. You can still generate the AI Index.",
      ),
    );
    declBackdrop.classList.remove("show");
  } catch (e) {
    alert(e.message || "Submit failed");
  } finally {
    submitting = false;
    declConfirm.disabled = false;
    declConfirm.textContent = "Submit & Lock";
  }
});

// boot
start().catch((e) =>
  msgs.appendChild(li("error", `Failed to start: ${e.message}`)),
);
