const API = ""; // same-origin
const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  repos: [],
  activeRepo: null,         // { owner, name, full_name, default_branch }
  files: [],                // { path, sha }

  // Tabs:
  // key = `${full_name}::${path}`
  tabs: new Map(),          // key -> { key, path, sha, baseText, model, dirty }
  activeTabKey: null,

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

/* ---------------- Auth / Profile ---------------- */

async function ensureAuth() {
  try {
    const me = await api("/api/me");
    state.me = me;
    $("userBtn").textContent = me.login;
    $("profileUser").textContent = me.login;
    $("profileLink").href = `https://github.com/${encodeURIComponent(me.login)}`;
  } catch {
    location.href = "index.html";
  }
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  location.href = "index.html";
}

/* ---------------- Monaco ---------------- */

function initMonaco() {
  return new Promise((resolve) => {
    require.config({
      paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs" }
    });

    require(["vs/editor/editor.main"], () => {
      state.editor = monaco.editor.create($("editor"), {
        value: "// Open a file from the left\n",
        language: "plaintext",
        theme: "vs-dark",
        automaticLayout: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
        fontSize: 14,
        minimap: { enabled: false },
        scrollBeyondLastLine: false
      });

      // Track dirty state for active tab
      state.editor.onDidChangeModelContent(() => {
        const key = state.activeTabKey;
        if (!key) return;
        const tab = state.tabs.get(key);
        if (!tab) return;

        const current = tab.model.getValue();
        tab.dirty = current !== tab.baseText;

        renderTabs();
        $("commitOpenBtn").disabled = !tab.dirty;
      });

      resolve();
    });
  });
}

function languageFromPath(path) {
  const ext = path.split(".").pop().toLowerCase();
  const map = {
    js: "javascript",
    ts: "typescript",
    html: "html",
    css: "css",
    json: "json",
    md: "markdown",
    py: "python",
    java: "java",
    cpp: "cpp",
    c: "c",
    go: "go",
    rs: "rust",
    php: "php",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml"
  };
  return map[ext] || "plaintext";
}

/* ---------------- Repo Picker Modal ---------------- */

function openModal(id) {
  const el = $(id);
  el.setAttribute("aria-hidden", "false");
  el.classList.add("show");
}

function closeModal(id) {
  const el = $(id);
  el.setAttribute("aria-hidden", "true");
  el.classList.remove("show");
}

function buildRepoList(filter="") {
  const q = filter.trim().toLowerCase();
  const list = $("repoList");
  list.innerHTML = "";

  const items = state.repos
    .filter(r => !q || r.full_name.toLowerCase().includes(q))
    .slice(0, 500);

  for (const r of items) {
    const row = document.createElement("button");
    row.className = "list-row";
    row.type = "button";

    const isActive = state.activeRepo && state.activeRepo.full_name === r.full_name;

    row.innerHTML = `
      <div class="list-main">
        <div class="list-title">${r.full_name}${r.private ? " <span class='muted'>(private)</span>" : ""}</div>
        <div class="muted list-sub">branch: ${r.default_branch}</div>
      </div>
      <div class="muted">${isActive ? "active" : ""}</div>
    `;

    row.addEventListener("click", async () => {
      if (hasDirtyTabs()) {
        const ok = confirm("You have unsaved changes in open tabs. Switching repos will keep tabs open, but commits will go to the selected repo. Continue?");
        if (!ok) return;
      }
      await selectRepo(r.full_name);
      closeModal("repoModal");
    });

    list.appendChild(row);
  }

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.padding = "10px";
    empty.textContent = "No repositories match your search.";
    list.appendChild(empty);
  }
}

async function selectRepo(fullName) {
  const repo = state.repos.find(r => r.full_name === fullName);
  if (!repo) return;

  state.activeRepo = repo;
  $("repoBtn").textContent = repo.full_name;
  $("repoMeta").textContent = `Branch: ${repo.default_branch}`;
  setStatus("Loading files…", repo.full_name);

  // Clear file list UI, but keep tabs (multi-repo tabs are possible, but confusing).
  // Simpler: close tabs when switching repos:
  closeAllTabs();

  await loadTree();
  setStatus("Ready.");
}

/* ---------------- GitHub data ---------------- */

async function loadRepos() {
  setStatus("Loading repos…");
  state.repos = await api("/api/repos");
  if (!state.repos.length) throw new Error("No repos found.");

  // default select first
  await selectRepo(state.repos[0].full_name);
}

async function loadTree() {
  const { owner, name, default_branch } = state.activeRepo;
  const data = await api(`/api/tree?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(name)}&branch=${encodeURIComponent(default_branch)}`);
  state.files = data.files || [];
  renderTree();
}

function renderTree() {
  const root = $("fileTree");
  root.innerHTML = "";

  const sorted = [...state.files].sort((a, b) => a.path.localeCompare(b.path));

  for (const f of sorted) {
    const depth = f.path.split("/").length - 1;
    const fileName = f.path.split("/").pop();
    const folder = f.path.includes("/") ? f.path.split("/").slice(0, -1).join("/") : "(root)";

    const el = document.createElement("div");
    el.className = "item";
    el.dataset.path = f.path;

    const indents = Array.from({ length: Math.min(depth, 8) })
      .map(() => `<span class="indent"></span>`).join("");

    el.innerHTML = `
      ${indents}
      <span>·</span>
      <span class="tree-file">
        <span class="tree-name">${fileName}</span>
        <span class="tree-folder muted">${folder}</span>
      </span>
    `;
    el.title = f.path;

    el.onclick = async () => {
      await openFileInTab(f.path);
      highlightActive(f.path);
    };

    root.appendChild(el);
  }
}

function highlightActive(path) {
  document.querySelectorAll(".tree .item").forEach(el => {
    el.classList.toggle("active", el.dataset.path === path);
  });
}

/* ---------------- Tabs + Files ---------------- */

function tabKeyFor(path) {
  return `${state.activeRepo.full_name}::${path}`;
}

function setActivePathUI(path) {
  if (!path) {
    $("activePath").textContent = "No file open";
    return;
  }
  const folder = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "(root)";
  const file = path.split("/").pop();
  $("activePath").textContent = `${state.activeRepo.full_name} / ${folder} / ${file}`;
}

async function openFileInTab(path) {
  const key = tabKeyFor(path);

  // already open -> switch
  if (state.tabs.has(key)) {
    setActiveTab(key);
    return;
  }

  // fetch content
  const { owner, name, default_branch } = state.activeRepo;
  setStatus("Opening…", path);

  const data = await api(
    `/api/file?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}&ref=${encodeURIComponent(default_branch)}`
  );

  const lang = languageFromPath(path);
  const model = monaco.editor.createModel(data.contentText || "", lang);

  state.tabs.set(key, {
    key,
    path,
    sha: data.sha,
    baseText: data.contentText || "",
    model,
    dirty: false
  });

  setActiveTab(key);
  renderTabs();
  setStatus("Opened.", `SHA: ${data.sha.slice(0, 7)}`);
}

function setActiveTab(key) {
  const tab = state.tabs.get(key);
  if (!tab) return;

  state.activeTabKey = key;
  state.editor.setModel(tab.model);

  setActivePathUI(tab.path);
  $("commitOpenBtn").disabled = !tab.dirty;

  renderTabs();
}

function renderTabs() {
  const bar = $("tabsBar");
  bar.innerHTML = "";

  if (state.tabs.size === 0) {
    bar.style.display = "none";
    setActivePathUI(null);
    $("commitOpenBtn").disabled = true;
    return;
  }

  bar.style.display = "flex";

  for (const tab of state.tabs.values()) {
    const file = tab.path.split("/").pop();
    const folder = tab.path.includes("/") ? tab.path.split("/").slice(0, -1).join("/") : "(root)";
    const active = tab.key === state.activeTabKey;

    const el = document.createElement("div");
    el.className = "tab" + (active ? " active" : "");

    el.innerHTML = `
      <button class="tab-main" type="button" title="${tab.path}">
        <span class="tab-file">${file}</span>
        <span class="tab-folder muted">${folder}</span>
        ${tab.dirty ? `<span class="tab-dot" title="Unsaved">*</span>` : ""}
      </button>
      <button class="tab-close" type="button" title="Close">×</button>
    `;

    el.querySelector(".tab-main").onclick = () => setActiveTab(tab.key);

    el.querySelector(".tab-close").onclick = () => closeTab(tab.key);

    bar.appendChild(el);
  }
}

function closeTab(key) {
  const tab = state.tabs.get(key);
  if (!tab) return;

  if (tab.dirty) {
    const ok = confirm("This tab has unsaved changes. Close anyway?");
    if (!ok) return;
  }

  // dispose monaco model
  tab.model.dispose();
  state.tabs.delete(key);

  if (state.activeTabKey === key) {
    // pick another tab
    const next = state.tabs.keys().next().value || null;
    state.activeTabKey = next;
    if (next) state.editor.setModel(state.tabs.get(next).model);
  }

  renderTabs();
  if (state.activeTabKey) {
    const activeTab = state.tabs.get(state.activeTabKey);
    setActivePathUI(activeTab.path);
    $("commitOpenBtn").disabled = !activeTab.dirty;
  } else {
    setActivePathUI(null);
    $("commitOpenBtn").disabled = true;
    state.editor.setValue("// Open a file from the left\n");
  }
}

function closeAllTabs() {
  for (const tab of state.tabs.values()) tab.model.dispose();
  state.tabs.clear();
  state.activeTabKey = null;
  renderTabs();
}

function hasDirtyTabs() {
  for (const tab of state.tabs.values()) if (tab.dirty) return true;
  return false;
}

/* ---------------- Commit Modal ---------------- */

function openCommitModal() {
  const tab = state.tabs.get(state.activeTabKey);
  if (!tab || !tab.dirty) return;

  $("commitTitle").value = "";
  $("commitBody").value = "";
  openModal("commitModal");
  setTimeout(() => $("commitTitle").focus(), 0);
}

async function doCommit() {
  const tab = state.tabs.get(state.activeTabKey);
  if (!tab) return;

  const title = $("commitTitle").value.trim();
  const body = $("commitBody").value.trim();

  if (!title) {
    alert("Commit title is required.");
    return;
  }

  // Git commit message: subject + blank line + body
  const message = body ? `${title}\n\n${body}` : title;

  const { owner, name, default_branch } = state.activeRepo;

  setStatus("Committing…", tab.path);

  const out = await api("/api/file", {
    method: "PUT",
    body: JSON.stringify({
      owner,
      repo: name,
      branch: default_branch,
      path: tab.path,
      sha: tab.sha,
      message,
      contentText: tab.model.getValue()
    })
  });

  // update baseline after push
  tab.sha = out.newSha || tab.sha;
  tab.baseText = tab.model.getValue();
  tab.dirty = false;

  $("commitOpenBtn").disabled = true;
  renderTabs();

  closeModal("commitModal");
  setStatus("Pushed.", `New SHA: ${String(tab.sha).slice(0, 7)}`);
}

/* ---------------- Wire UI ---------------- */

function wireModals() {
  // repo modal
  $("repoBtn").onclick = () => {
    buildRepoList($("repoSearch").value || "");
    openModal("repoModal");
    setTimeout(() => $("repoSearch").focus(), 0);
  };
  $("repoCloseBtn").onclick = () => closeModal("repoModal");
  $("repoSearch").oninput = () => buildRepoList($("repoSearch").value);

  // commit modal
  $("commitOpenBtn").onclick = openCommitModal;
  $("commitCloseBtn").onclick = () => closeModal("commitModal");
  $("commitDoBtn").onclick = async () => {
    try { await doCommit(); }
    catch (e) { alert(String(e.message || e)); setStatus("Commit failed."); }
  };

  // profile modal
  $("userBtn").onclick = () => openModal("profileModal");
  $("profileCloseBtn").onclick = () => closeModal("profileModal");
  $("profileLogoutBtn").onclick = logout;

  // close on backdrop click
  for (const id of ["repoModal", "commitModal", "profileModal"]) {
    const back = $(id);
    back.addEventListener("mousedown", (e) => {
      if (e.target === back) closeModal(id);
    });
  }

  // ESC closes top-most (simple)
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const id of ["commitModal", "repoModal", "profileModal"]) {
      const el = $(id);
      if (el.classList.contains("show")) {
        closeModal(id);
        break;
      }
    }
  });
}

async function main() {
  await ensureAuth();
  await initMonaco();
  wireModals();

  $("refreshBtn").onclick = async () => {
    try {
      await loadTree();
      setStatus("Refreshed.");
    } catch (e) {
      alert(String(e.message || e));
    }
  };

  $("logoutBtn").onclick = logout;

  await loadRepos();
  setStatus("Ready.");
}

main().catch((e) => {
  console.error(e);
  alert(String(e.message || e));
  location.href = "index.html";
});
