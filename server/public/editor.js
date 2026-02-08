const Editor = (() => {
  const keywords = new Set([
    "const","let","var","function","return","if","else","for","while","do","switch","case","break","continue",
    "class","new","try","catch","finally","throw","import","from","export","default","async","await",
    "true","false","null","undefined","typeof","instanceof","in","of","extends","super"
  ]);

  function escapeHtml(s) {
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function highlightText(src) {
    let s = escapeHtml(src);

    // block comments
    s = s.replace(/\/\*[\s\S]*?\*\//g, m => `<span class="t-c">${m}</span>`);
    // line comments
    s = s.replace(/(^|[^:])\/\/.*$/gm, m => `<span class="t-c">${m}</span>`);

    // template strings then normal strings
    s = s.replace(/`([^`\\]|\\.)*`/g, m => `<span class="t-s">${m}</span>`);
    s = s.replace(/"([^"\\]|\\.)*"/g, m => `<span class="t-s">${m}</span>`);
    s = s.replace(/'([^'\\]|\\.)*'/g, m => `<span class="t-s">${m}</span>`);

    // numbers
    s = s.replace(/\b(\d+(\.\d+)?)\b/g, `<span class="t-n">$1</span>`);

    // function-ish: word before (
    s = s.replace(/\b([A-Za-z_$][\w$]*)\s*(?=\()/g, (m, w) => {
      if (keywords.has(w)) return `<span class="t-k">${w}</span>`;
      return `<span class="t-f">${w}</span>`;
    });

    // keywords
    s = s.replace(/\b([A-Za-z_$][\w$]*)\b/g, (m, w) => {
      if (keywords.has(w)) return `<span class="t-k">${w}</span>`;
      return w;
    });

    return s;
  }

  function updateGutter(gutterEl, text) {
    const lines = text.split("\n").length || 1;
    let out = "";
    for (let i = 1; i <= lines; i++) out += i + "\n";
    gutterEl.textContent = out.trimEnd();
  }

  function install({ textarea, highlightEl, gutterEl, surfaceEl, onChange }) {
    let last = "";

    function render() {
      const val = textarea.value;
      if (val === last) return;
      last = val;

      updateGutter(gutterEl, val);
      highlightEl.innerHTML = highlightText(val) + "\n";
      if (onChange) onChange(val);
    }

    // Keep scroll synced
    surfaceEl.addEventListener("scroll", () => {
      const { scrollTop, scrollLeft } = surfaceEl;
      textarea.scrollTop = scrollTop;
      textarea.scrollLeft = scrollLeft;
    });

    textarea.addEventListener("input", render);

    textarea.addEventListener("keydown", (e) => {
      // Tab indent/outdent
      if (e.key === "Tab") {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const v = textarea.value;

        if (e.shiftKey) {
          // outdent selection line(s)
          const before = v.slice(0, start);
          const sel = v.slice(start, end);
          const after = v.slice(end);

          const lines = (sel.length ? sel : "").split("\n");
          const out = lines.map(line => {
            if (line.startsWith("  ")) return line.slice(2);
            if (line.startsWith("\t")) return line.slice(1);
            return line;
          });

          const joined = out.join("\n");
          textarea.value = before + joined + after;
          textarea.selectionStart = start;
          textarea.selectionEnd = start + joined.length;
        } else {
          const insert = "  ";
          textarea.value = v.slice(0, start) + insert + v.slice(end);
          textarea.selectionStart = textarea.selectionEnd = start + insert.length;
        }
        render();
        return;
      }

      // Basic auto-close
      const pairs = { "(": ")", "[": "]", "{": "}", "\"": "\"", "'": "'", "`": "`" };
      if (pairs[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const v = textarea.value;
        const open = e.key;
        const close = pairs[e.key];

        if (start !== end) {
          e.preventDefault();
          const sel = v.slice(start, end);
          textarea.value = v.slice(0, start) + open + sel + close + v.slice(end);
          textarea.selectionStart = start + 1;
          textarea.selectionEnd = end + 1;
          render();
          return;
        }

        e.preventDefault();
        textarea.value = v.slice(0, start) + open + close + v.slice(end);
        textarea.selectionStart = textarea.selectionEnd = start + 1;
        render();
      }
    });

    render();

    return {
      setValue(v) { textarea.value = v ?? ""; render(); },
      getValue() { return textarea.value; },
      focus() { textarea.focus(); }
    };
  }

  return { install };
})();
