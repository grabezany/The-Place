import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

// ---- tiny .env loader for LOCAL dev only (Render uses env vars) ----
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  SESSION_SECRET = "dev-secret",
  NODE_ENV = "development",
  PORT = 8787
} = process.env;

if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
  console.error("Missing GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET in environment variables.");
  process.exit(1);
}

const app = express();

// Important for Render / reverse proxies
app.set("trust proxy", 1);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Serve frontend from /public (same origin)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// ---------------- Session Store (in-memory) ----------------
// NOTE: On Render free instances may sleep/restart. In-memory sessions will be lost.
// For production: store sessions in Redis/DB.
const sessions = new Map(); // sid -> { accessToken, login, createdAt }
const isProd = NODE_ENV === "production";

function newSid() {
  return crypto.randomBytes(24).toString("hex");
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function setSessionCookie(res, sid) {
  const sig = sign(sid);
  res.cookie("theplace_sid", `${sid}.${sig}`, {
    httpOnly: true,
    sameSite: "lax",  // same-origin, perfect
    secure: isProd,   // true on Render (HTTPS)
    maxAge: 1000 * 60 * 60 * 6 // 6 hours
  });
}

function readSession(req) {
  const raw = req.cookies?.theplace_sid;
  if (!raw) return null;
  const [sid, sig] = raw.split(".");
  if (!sid || !sig) return null;
  if (sign(sid) !== sig) return null;
  const data = sessions.get(sid);
  if (!data) return null;
  return { sid, ...data };
}

async function ghFetch(url, accessToken, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Authorization": `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} — ${text}`);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

// ---------------- Auth: GitHub Device Flow ----------------

app.post("/api/auth/device/start", async (req, res) => {
  try {
    const r = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        // repo includes private repo access IF the user approves your OAuth app
        scope: "repo read:user"
      })
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(500).json({ error: "device_start_failed", details: t });
    }

    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "device_start_exception", details: String(e?.message || e) });
  }
});

app.post("/api/auth/device/poll", async (req, res) => {
  try {
    const { device_code } = req.body || {};
    if (!device_code) return res.status(400).json({ error: "missing_device_code" });

    const r = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      })
    });

    const data = await r.json();

    // Possible errors: authorization_pending, slow_down, expired_token, etc.
    if (data.error) return res.json(data);

    // Got token
    const accessToken = data.access_token;

    // Identify user
    const me = await ghFetch("https://api.github.com/user", accessToken);

    // Create session
    const sid = newSid();
    sessions.set(sid, { accessToken, login: me.login, createdAt: Date.now() });
    setSessionCookie(res, sid);

    res.json({ ok: true, login: me.login });
  } catch (e) {
    res.status(500).json({ error: "device_poll_exception", details: String(e?.message || e) });
  }
});

app.post("/api/auth/logout", (req, res) => {
  const s = readSession(req);
  if (s?.sid) sessions.delete(s.sid);
  res.clearCookie("theplace_sid");
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: "not_authenticated" });
  res.json({ login: s.login });
});

// ---------------- GitHub: Repos / Tree / File / Push ----------------

app.get("/api/repos", async (req, res) => {
  try {
    const s = readSession(req);
    if (!s) return res.status(401).json({ error: "not_authenticated" });

    const repos = await ghFetch("https://api.github.com/user/repos?per_page=100&sort=updated", s.accessToken);
    res.json(repos.map(r => ({
      owner: r.owner.login,
      name: r.name,
      full_name: r.full_name,
      private: r.private,
      default_branch: r.default_branch
    })));
  } catch (e) {
    res.status(500).json({ error: "repos_failed", details: String(e?.message || e) });
  }
});

app.get("/api/tree", async (req, res) => {
  try {
    const s = readSession(req);
    if (!s) return res.status(401).json({ error: "not_authenticated" });

    const { owner, repo, branch } = req.query;
    if (!owner || !repo || !branch) return res.status(400).json({ error: "missing_params" });

    const ref = await ghFetch(
      `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      s.accessToken
    );

    const commitSha = ref.object.sha;
    const commit = await ghFetch(
      `https://api.github.com/repos/${owner}/${repo}/git/commits/${commitSha}`,
      s.accessToken
    );

    const treeSha = commit.tree.sha;
    const tree = await ghFetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
      s.accessToken
    );

    const files = (tree.tree || [])
      .filter(n => n.type === "blob")
      .map(n => ({ path: n.path, sha: n.sha }))
      .slice(0, 4000);

    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: "tree_failed", details: String(e?.message || e) });
  }
});

app.get("/api/file", async (req, res) => {
  try {
    const s = readSession(req);
    if (!s) return res.status(401).json({ error: "not_authenticated" });

    const { owner, repo, path: filePath, ref } = req.query;
    if (!owner || !repo || !filePath || !ref) return res.status(400).json({ error: "missing_params" });

    const data = await ghFetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`,
      s.accessToken
    );

    if (Array.isArray(data)) return res.status(400).json({ error: "path_is_directory" });

    const contentB64 = (data.content || "").replace(/\n/g, "");
    const contentText = contentB64 ? Buffer.from(contentB64, "base64").toString("utf8") : "";

    res.json({ path: filePath, sha: data.sha, contentText });
  } catch (e) {
    res.status(500).json({ error: "file_failed", details: String(e?.message || e) });
  }
});

app.put("/api/file", async (req, res) => {
  try {
    const s = readSession(req);
    if (!s) return res.status(401).json({ error: "not_authenticated" });

    const { owner, repo, branch, path: filePath, sha, message, contentText } = req.body || {};
    if (!owner || !repo || !branch || !filePath || !sha || !message) {
      return res.status(400).json({ error: "missing_params" });
    }

    const content = Buffer.from(contentText ?? "", "utf8").toString("base64");

    const data = await ghFetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`,
      s.accessToken,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, content, sha, branch })
      }
    );

    res.json({ ok: true, newSha: data.content?.sha });
  } catch (e) {
    res.status(500).json({ error: "push_failed", details: String(e?.message || e) });
  }
});

// Fallback: serve index.html for root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(Number(PORT), () => {
  console.log(`The Place running on port ${PORT} (${isProd ? "prod" : "dev"})`);
});
