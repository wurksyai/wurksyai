// Worksy AI — Theme + Navigation Cache

const root = document.documentElement;
const key = "worksy-theme";

// ----- Theme -----
function setTheme(mode) {
  root.dataset.theme = mode;
  try {
    localStorage.setItem(key, mode);
  } catch {}
  updateToggleLabel();
}
function getTheme() {
  try {
    return localStorage.getItem(key) || "dark";
  } catch {
    return "dark";
  }
}

// Apply initial theme
setTheme(getTheme());

// Update toggle label/icon
function updateToggleLabel() {
  const btn = document.getElementById("themeToggle");
  if (!btn) return;
  if (root.dataset.theme === "dark") {
    btn.textContent = "☀️ Light";
    btn.title = "Switch to light mode";
  } else {
    btn.textContent = "🌙 Dark";
    btn.title = "Switch to dark mode";
  }
}

// Listen for theme toggle click
addEventListener("click", (e) => {
  const t = e.target.closest("#themeToggle, [data-theme-toggle]");
  if (!t) return;
  setTheme(root.dataset.theme === "dark" ? "light" : "dark");
});

// Smooth fade when switching
root.style.transition = "background-color .25s ease, color .25s ease";

// ----- Cache-busting nav links using /__version -----
(async function ensureFreshNav() {
  try {
    const r = await fetch("/__version", { cache: "no-store" });
    if (!r.ok) throw new Error("no version");
    const j = await r.json();
    const idx = (j.out || []).find((x) => x.file === "index.html" && x.exists);
    const tag = idx ? (idx.sha256 || "").slice(0, 10) : String(Date.now());

    // Optional build tag display
    const tagEl = document.getElementById("buildTag");
    if (tagEl) tagEl.textContent = `build: ${tag}`;

    // Rewrite /index.html links to include cache tag
    const rewrite = (a) => {
      if (!a) return;
      const u = new URL(a.getAttribute("href") || "/", location.origin);
      if (u.pathname === "/" || u.pathname.endsWith("/index.html")) {
        u.pathname = "/index.html";
        u.searchParams.set("v", tag);
        a.setAttribute("href", u.pathname + "?" + u.searchParams.toString());
      }
    };
    rewrite(document.querySelector('.links a[href="/"]'));
    rewrite(document.querySelector(".brand"));

    // Mark active tab
    const path = location.pathname.replace(/\/+$/, "") || "/index.html";
    document.querySelectorAll(".links a").forEach((a) => {
      const ap = new URL(a.href).pathname.replace(/\/+$/, "");
      a.classList.toggle(
        "active",
        ap === path || (path === "/" && ap === "/index.html"),
      );
    });
  } catch {
    // Fallback: still mark active tab
    const path = location.pathname.replace(/\/+$/, "") || "/index.html";
    document.querySelectorAll(".links a").forEach((a) => {
      const ap = new URL(a.href).pathname.replace(/\/+$/, "");
      a.classList.toggle(
        "active",
        ap === path || (path === "/" && ap === "/index.html"),
      );
    });
  }
})();

// Hard fix for back/forward cache returning stale DOM
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});

// Initialise label once DOM ready
window.addEventListener("DOMContentLoaded", updateToggleLabel);
