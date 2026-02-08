const API = ""; // same-origin
const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  repos: [],
  activeRepo: null,
  files: [],
  activeFile: null,
  editor: null,
  dirty: false
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

/* ---------------- Monaco Setup ---------------- */

function initMonaco() {
  return new Promise((resolve) => {
    require.config({
      paths: {
        vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs"
      }
    });

    require(["vs/editor/editor.main"], () => {
      state.editor = monaco.editor.create($("editor"), {
        value: "// Open a file from the left\n",
        language: "javascript",
        theme: "vs-dark",
        automaticLayout: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
        fontSize: 14,
        minimap: { enabled: false },
        scrollBeyondLastLine: false
      });

      state.editor.onDidChangeModelContent(() => {
        if (!state.activeFile) return;
        const current = state.editor.getValue();
        state.dirty = current !== (state.activeFile.contentText || "");
        $("saveBtn").disabled = !state.dirty;
      });

      resolve();
    });
  });
}

function setLanguageFromPath(path) {
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
  const lang = map[ext] || "plaintext";
  monaco.editor.setModelLanguage(state.editor.getModel(), lang);
}

/* ---------------- GitHub Data ---------------- */

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

    el.onclick = async () => {
      if (state.dirty && !confirm("Discard unsaved changes?")) return;
      await openFile(f.path);
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

async function loadTree() {
  const { owner, name, default_branch } = state.activeRepo;
  setStatus("Loading files…");
  const data = await api(`/api/tree?owner=${owner}&repo=${name}&branch=${default_branch}`);
  state.files = data.files || [];
  renderTree();
}

async function openFile(filePath) {
  const { owner, name, default_branch } = state.activeRepo;
  setStatus("Opening…", filePath);

  const data = await api(
    `/api/file?owner=${owner}&repo=${name}&path=${encodeURIComponent(filePath)}&ref=${default_branch}`
  );

  state.activeFile = data;
  state.dirty = false;
  $("saveBtn").disabled = true;
  $("activePath").textContent = filePath;

  state.editor.setValue(data.contentText || "");
  setLanguageFromPath(filePath);

  setStatus("Opened.", `SHA: ${data.sha.slice(0,7)}`);
}

async function saveFile() {
  const msg = $("commitMsg").value.trim();
  if (!msg) return alert("Commit message required.");

  const { owner, name, default_branch } = state.activeRepo;

  setStatus("Committing…");

  const out = await api("/api/file", {
    method: "PUT",
    body: JSON.stringify({
      owner,
      repo: name,
      branch: default_branch,
      path: state.activeFile.path,
      sha: state.activeFile.sha,
      message: msg,
      contentText: state.editor.getValue()
    })
  });

  state.activeFile.sha = out.newSha;
  state.activeFile.contentText = state.editor.getValue();
  state.dirty = false;
  $("saveBtn").disabled = true;
  $("commitMsg").value = "";

  setStatus("Pushed.", out.newSha.slice(0,7));
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" });
  location.href = "index.html";
}

/* ---------------- Main ---------------- */

async function main() {
  await ensureAuth();
  await initMonaco();
  await loadRepos();
  await loadTree();

  $("refreshBtn").onclick = async () => {
    await loadRepos();
    await loadTree();
  };

  $("repoSelect").onchange = async (e) => {
    state.activeRepo = state.repos.find(r => r.full_name === e.target.value);
    state.activeFile = null;
    state.dirty = false;
    $("saveBtn").disabled = true;
    $("activePath").textContent = "No file open";
    state.editor.setValue("");
    $("repoMeta").textContent = `Branch: ${state.activeRepo.default_branch}`;
    await loadTree();
  };

  $("saveBtn").onclick = saveFile;
  $("logoutBtn").onclick = logout;

  setStatus("Ready.");
}

main();
