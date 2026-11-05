import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.ADMIN_QA_PORT || 4186);
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon" };

createServer(async (req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const suffix = pathname.endsWith("/") ? pathname + "index.html" : pathname;
  const relativePath = suffix.startsWith("/admin/") ? "apps" + suffix
    : suffix.startsWith("/player/") ? "apps" + suffix
    : suffix === "/index.html" ? "index.html"
    : suffix.startsWith("/packages/") || suffix.startsWith("/static/") ? suffix.slice(1)
    : null;
  if (!relativePath) {
    res.writeHead(404); res.end("Not found"); return;
  }
  const target = resolve(root, relativePath);
  if (relative(root, target).startsWith("..")) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  try {
    const bytes = await readFile(target);
    res.writeHead(200, { "Content-Type": (mime[extname(target)] || "application/octet-stream") + ([".html", ".js", ".mjs", ".css", ".json"].includes(extname(target)) ? "; charset=utf-8" : ""), "Cache-Control": "no-store" });
    res.end(bytes);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}).listen(port, "127.0.0.1", () => process.stdout.write(`Admin mock asset server ready on ${port}\n`));
