// Apply the saved theme before the first paint, so the page doesn't flash.
// (A file rather than an inline script, so the page's security policy can forbid inline scripts.)
try { const t = localStorage.getItem("theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch {}
