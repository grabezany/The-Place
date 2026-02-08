const API = ""; // same-origin
const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  repos: [],
  activeRepo: null,
  files: [],
  activeFile: null,
  dirty: false,
  editor: null
};

function setStatus(left, right="") {
  $("statusLeft").textContent = left;
  $("statusRight").textContent = right;
}

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "request_failed");
  return data;
}

async function ensureAuth() {
  try {
    const me = await api("/api/me");
    state.me = me;
    $("whoami").textContent = `Signed in as ${me.login}`;
  } catch {
    location.href = "index.html";
  }
}

async function loadRepos() {
  setStatus("Loading repos…");
  const repos = await api("/api/repos");
  state.repos = repos;

  const sel = $("repoSelect");
  sel.innerHTML = "";
  for (const r of repos) {
    const opt = document.createElement("option");
    opt.value = r.full_name;
    opt.textContent = `${r.full_name}${r.private ? " (private)" : ""}`;
    sel.appendChild(opt);
  }

  if (!repos.length) {
    setStatus("No repos found.");
    return;
  }

  state.activeRepo = repos[0];
  sel.value = state.activeRepo.full_name;
  $("repoMeta").textContent = `Branch: ${state.activeRepo.default_branch}`;
  setStatus("Repos loaded.");
}

function renderTree() {
  const root = $("fileTree");
  root.innerHTML = "";

  const sorted = [...state.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    const depth = f.path.split("/").length - 1;
    const el = document.createElement("div");
    el.className = "item";
    el.dataset.path = f.path;

    const indents = Array.from({ length: Math.min(depth, 8) })
      .map(() => `<span class="indent"></span>`).join("");

    el.innerHTML = `${indents}<span>·</span><span>${f.path.split("/").pop()}</span>`;
    el.title = f.path;

    el.addEventListener("click", async () => {
      if (state.dirty) {
        const ok = confirm("Discard unsaved changes?");
        if (!ok) return;
      }
      await openFile(f.path);
      highlightActive(f.path);
    });

    root.appendChild(el);
  }
}

function highlightActive(path) {
  for (const el of document.querySelectorAll(".tree .item")) {
    el.classList.toggle("active", el.dataset.path === path);
  }
}

async function loadTree() {
  if (!state.activeRepo) return;
  const { owner, name, default_branch } = state.activeRepo;

  setStatus("Loading files…", state.activeRepo.full_name);
  const data = await api(`/api/tree?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(name)}&branch=${encodeURIComponent(default_branch)}`);
  state.files = data.files || [];
  renderTree();
  setStatus("Files ready.", `${state.files.length} files`);
}

async function openFile(filePath) {
  const { owner, name, default_branch } = state.activeRepo;
  setStatus("Opening…", filePath);

  const data = await api(
    `/api/file?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(name)}&path=${encodeURIComponent(filePath)}&ref=${encodeURIComponent(default_branch)}`
  );

  state.activeFile = data;
  state.dirty = false;
  $("saveBtn").disabled = true;
  $("activePath").textContent = filePath;

  state.editor.setValue(data.contentText || "");
  setStatus("Opened.", `SHA: ${(data.sha || "").slice(0, 7)}`);
}

async function saveFile() {
  if (!state.activeRepo || !state.activeFile) return;

  const msg = $("commitMsg").value.trim();
  if (!msg) return alert("Commit message required.");

  const { owner, name, default_branch } = state.activeRepo;

  const payload = {
    owner,
    repo: name,
    branch: default_branch,
    path: state.activeFile.path,
    sha: state.activeFile.sha,
    message: msg,
    contentText: state.editor.getValue()
  };

  setStatus("Committing…", state.activeFile.path);

  const out = await api("/api/file", {
    method: "PUT",
    body: JSON.stringify(payload)
  });

  state.activeFile.sha = out.newSha || state.activeFile.sha;
  state.activeFile.contentText = payload.contentText;
  state.dirty = false;
  $("saveBtn").disabled = true;
  $("commitMsg").value = "";

  setStatus("Pushed.", `New SHA: ${state.activeFile.sha.slice(0, 7)}`);
}

function installFind() {
  const box = $("findBox");

  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = box.value;
    if (!q) return;

    const text = state.editor.getValue();
    const idx = text.indexOf(q);
    setStatus(idx >= 0 ? `Found "${q}"` : `Not found: "${q}"`, idx >= 0 ? `index ${idx}` : "");
  });

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      box.focus();
      box.select();
    }
  });
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  location.href = "index.html";
}

async function main() {
  await ensureAuth();

  state.editor = Editor.install({
    textarea: $("code"),
    highlightEl: $("highlight"),
    gutterEl: $("gutter"),
    surfaceEl: $("surface"),
    onChange: () => {
      if (!state.activeFile) return;
      const cur = state.editor.getValue();
      state.dirty = cur !== (state.activeFile.contentText || "");
      $("saveBtn").disabled = !state.dirty;
    }
  });

  installFind();

  $("refreshBtn").addEventListener("click", async () => {
    try {
      await loadRepos();
      await loadTree();
    } catch (e) {
      console.error(e);
      alert(e.message);
      setStatus("Error.", "See console");
    }
  });

  $("repoSelect").addEventListener("change", async (e) => {
    const full = e.target.value;
    state.activeRepo = state.repos.find(r => r.full_name === full) || null;

    state.activeFile = null;
    state.dirty = false;
    $("saveBtn").disabled = true;
    $("activePath").textContent = "No file open";
    state.editor.setValue("");

    $("repoMeta").textContent = state.activeRepo ? `Branch: ${state.activeRepo.default_branch}` : "—";
    if (state.activeRepo) await loadTree();
  });

  $("saveBtn").addEventListener("click", async () => {
    try {
      await saveFile();
    } catch (e) {
      console.error(e);
      alert(e.message);
      setStatus("Push failed.", "Check permissions");
    }
  });

  $("logoutBtn").addEventListener("click", logout);

  await loadRepos();
  await loadTree();
  setStatus("Ready.");
}

main().catch((e) => {
  console.error(e);
  location.href = "index.html";
});
