/* Clarea · projects: reading code (folder, .zip, GitHub), GitHub history and simple code analysis.
   Shared by the home page (creating a project) and the project page. */
window.CL = (function () {
  "use strict";
  const TEXT_EXT = new Set(("html htm css scss sass less js mjs cjs ts tsx jsx json php java kt kts py rb go rs c h cpp hpp cc cs swift sql md txt xml yml yaml sh bat ps1 vue svelte twig ini toml gradle properties csv env").split(" "));
  const SKIP_DIR = /(^|\/)(node_modules|vendor|\.git|dist|build|out|target|\.next|\.nuxt|__pycache__|\.idea|\.vscode|coverage|\.gradle|bin|obj|\.venv|venv|__MACOSX)\//i;
  const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|\.DS_Store|Thumbs\.db)$|\.min\.(js|css)$|\.map$/i;
  const NAMED = /^(dockerfile|makefile|readme|license|\.htaccess|\.gitignore|\.env\.example|\.editorconfig)$/i;
  const MAX_FILE = 200 * 1024, MAX_TOTAL = 700 * 1024, MAX_FILES = 400;

  const ext = p => { const b = p.split("/").pop().toLowerCase(); return b.includes(".") ? b.split(".").pop() : b; };
  function keepPath(p) {
    const b = p.split("/").pop();
    if (SKIP_DIR.test(p) || SKIP_FILE.test(p) || b.startsWith("._")) return false;
    return TEXT_EXT.has(ext(p)) || NAMED.test(b);
  }
  function commonRoot(paths) {
    if (!paths.length) return "";
    const first = paths[0].split("/");
    if (first.length < 2) return "";
    return paths.every(p => p.startsWith(first[0] + "/")) ? first[0] : "";
  }
  /* entries: [{path, size, read: async () => text}] → {files: {path: text}, skipped: [[path, why]], ignored, total, root} */
  async function collect(entries, onProgress) {
    entries = entries.filter(e => e.path && !e.path.endsWith("/"));
    const root = commonRoot(entries.map(e => e.path));
    const wanted = [], skipped = [];
    let ignored = 0;
    entries.forEach(e => {
      const p = root ? e.path.slice(root.length + 1) : e.path;
      if (!keepPath(p)) { ignored++; return; }
      if (e.size > MAX_FILE) { skipped.push([p, "ocupa más de 200 KB"]); return; }
      wanted.push({p, e});
    });
    wanted.sort((a, b) => a.p.localeCompare(b.p));
    const texts = new Array(wanted.length);
    let done = 0, next = 0;
    async function worker() {
      while (next < wanted.length) {
        const i = next++;
        try { texts[i] = await wanted[i].e.read(); } catch (x) { texts[i] = null; }
        done++; if (onProgress) onProgress(done, wanted.length);
      }
    }
    await Promise.all(Array.from({length: Math.min(8, wanted.length)}, worker));
    const files = {};
    let total = 0, count = 0;
    wanted.forEach((w, i) => {
      let t = texts[i];
      if (t === null || t === undefined) { skipped.push([w.p, "no se pudo leer"]); return; }
      if (t.indexOf("\u0000") >= 0) { ignored++; return; }
      t = t.replace(/\r\n?/g, "\n");
      if (count >= MAX_FILES) { skipped.push([w.p, "hay demasiados archivos (máximo " + MAX_FILES + ")"]); return; }
      if (total + t.length > MAX_TOTAL) { skipped.push([w.p, "el proyecto ya ocupa el máximo (700 KB de código)"]); return; }
      files[w.p] = t; total += t.length; count++;
    });
    return {files, skipped, ignored, total, root};
  }

  /* ----- sources ----- */
  function folderEntries(fileList) {
    return Array.from(fileList).map(f => ({path: (f.webkitRelativePath || f.name).replace(/\\/g, "/"), size: f.size, read: () => f.text()}));
  }
  async function zipEntries(file) {
    const buf = await file.arrayBuffer(), dv = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder("utf-8");
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw {code: "NOZIP"};
    const n = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const fnl = dv.getUint16(p + 28, true), exl = dv.getUint16(p + 30, true), cml = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + fnl)).replace(/\\/g, "/");
      p += 46 + fnl + exl + cml;
      if (name.endsWith("/")) continue;
      out.push({path: name, size: usize, read: async () => {
        const ln = dv.getUint16(lho + 26, true), le = dv.getUint16(lho + 28, true), start = lho + 30 + ln + le;
        const data = u8.subarray(start, start + csize);
        if (method === 0) return dec.decode(data);
        if (method !== 8 || typeof DecompressionStream === "undefined") throw new Error("METHOD");
        return dec.decode(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      }});
    }
    return out;
  }

  /* ----- GitHub (public repositories, no account: 60 requests per hour) ----- */
  function parseRepo(s) {
    s = String(s || "").trim();
    const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[\/#?].*)?$/i) || s.match(/^([\w.-]+)\/([\w.-]+)$/);
    return m ? m[1] + "/" + m[2] : null;
  }
  let ghLeft = null;
  async function gh(path) {
    let r;
    try { r = await fetch("https://api.github.com" + path, {headers: {Accept: "application/vnd.github+json"}}); }
    catch (e) { throw {code: "NET"}; }
    ghLeft = r.headers.get("x-ratelimit-remaining");
    if ((r.status === 403 || r.status === 429) && ghLeft === "0") throw {code: "RATE", reset: +r.headers.get("x-ratelimit-reset") * 1000};
    if (r.status === 404) throw {code: "404"};
    if (!r.ok) throw {code: "HTTP" + r.status};
    return r.json();
  }
  function ghMsg(e) {
    if (!e) return "Error desconocido.";
    if (e.code === "NET") return "Sin conexión: para usar GitHub hace falta internet.";
    if (e.code === "404") return "No se encuentra el repositorio. Revisa el enlace: tiene que existir y ser público.";
    if (e.code === "PRIVATE") return "El repositorio es privado. Tiene que ser público.";
    if (e.code === "RATE") return "GitHub solo deja 60 consultas por hora sin cuenta. Vuelve a probar a las " + new Date(e.reset).toLocaleTimeString("es-ES", {hour: "2-digit", minute: "2-digit"}) + ".";
    return "GitHub ha respondido con un error (" + e.code + ").";
  }
  async function repoInfo(full) {
    const j = await gh("/repos/" + full);
    if (j.private) throw {code: "PRIVATE"};
    return {full: j.full_name, def: j.default_branch, desc: j.description || "", name: j.name};
  }
  async function githubEntries(full, branch) {
    const t = await gh("/repos/" + full + "/git/trees/" + encodeURIComponent(branch) + "?recursive=1");
    return t.tree.filter(x => x.type === "blob").map(b => ({path: b.path, size: b.size || 0, read: async () => {
      const r = await fetch("https://raw.githubusercontent.com/" + full + "/" + encodeURIComponent(branch) + "/" + b.path.split("/").map(encodeURIComponent).join("/"));
      if (!r.ok) throw new Error("raw");
      return r.text();
    }}));
  }
  /* branches, commits and pull requests, kept small enough to sync */
  async function gitHistory(full, def, onProgress) {
    const say = t => onProgress && onProgress(t);
    say("Ramas…");
    const branches = await gh("/repos/" + full + "/branches?per_page=100");
    const commits = new Map(), inBranch = {}, size = {};
    for (const b of branches.slice(0, 25)) {
      say("Commits de " + b.name + "…");
      const list = await gh("/repos/" + full + "/commits?sha=" + encodeURIComponent(b.name) + "&per_page=100");
      size[b.name] = list.length;
      if (b.name === def && list[0]) size.__tip = list[0].sha;
      list.forEach(c => {
        if (!commits.has(c.sha)) commits.set(c.sha, {s: c.sha, m: c.commit.message || "", d: (c.commit.author && c.commit.author.date) || (c.commit.committer && c.commit.committer.date) || "", a: (c.author && c.author.login) || (c.commit.author && c.commit.author.name) || "", p: (c.parents || []).map(x => x.sha)});
        (inBranch[c.sha] = inBranch[c.sha] || []).push(b.name);
      });
    }
    say("Pull requests…");
    const pulls = await gh("/repos/" + full + "/pulls?state=all&per_page=100");
    const prs = [];
    for (const p of pulls.slice(0, 15)) {
      say("Pull request #" + p.number + "…");
      const pf = await gh("/repos/" + full + "/pulls/" + p.number + "/files?per_page=100");
      prs.push({n: p.number, t: p.title || "", body: (p.body || "").slice(0, 1200), st: p.merged_at ? "merged" : p.state, from: p.head && p.head.ref, to: p.base && p.base.ref,
        d: p.merged_at || p.closed_at || p.created_at, c: [], f: pf.map(x => [x.filename, x.additions, x.deletions]), merge: p.merge_commit_sha || ""});
    }
    /* which branch each commit was made on (the same idea git uses):
       - the main line of the main branch (from its newest commit, always following the first parent) is the main branch;
       - any other commit belongs to the smallest branch that has it: a feature branch holds its own commits plus what it started from */
    const mergeOf = {}, prByBranch = {}, mainLine = new Set();
    prs.forEach(p => { if (p.st === "merged" && p.merge) mergeOf[p.merge] = p.n; if (!prByBranch[p.from]) prByBranch[p.from] = p; });
    for (let s = size.__tip; s && commits.has(s) && !mainLine.has(s); s = commits.get(s).p[0]) mainLine.add(s);
    const list = [...commits.values()].map(c => {
      const others = (inBranch[c.s] || []).filter(b => b !== def).sort((a, b) => size[a] - size[b]);
      const b = mainLine.has(c.s) || !others.length ? def : others[0];
      const pr = b !== def ? prByBranch[b] : null;
      const lines = c.m.split("\n");
      return {s: c.s.slice(0, 7), m: lines[0].slice(0, 200), body: lines.slice(1).join("\n").trim().slice(0, 500), d: c.d, a: c.a,
        b, merge: mergeOf[c.s] || (c.p.length > 1 ? (+((c.m.match(/pull request #(\d+)/i) || [])[1]) || -1) : 0), pr: pr ? pr.n : 0};
    }).sort((x, y) => x.d < y.d ? -1 : x.d > y.d ? 1 : 0);
    // a pull request's commits are the ones made on its branch
    prs.forEach(p => { p.c = list.filter(c => c.b === p.from && !c.merge).map(c => c.s); p.merge = p.merge ? p.merge.slice(0, 7) : ""; });
    return {t: Date.now(), full, def, branches: branches.map(b => b.name), commits: list, prs: prs.sort((a, b) => a.n - b.n)};
  }

  /* ----- code analysis ----- */
  const LANG = {js: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", jsx: "js", vue: "js", svelte: "js", php: "php", py: "py", java: "java", kt: "java", kts: "java", cs: "java", swift: "java",
    go: "go", rb: "rb", html: "html", htm: "html", twig: "html", xml: "html", css: "css", scss: "css", sass: "css", less: "css", json: "json", md: "md", sql: "sql", sh: "sh", bat: "sh", ps1: "sh",
    yml: "cfg", yaml: "cfg", ini: "cfg", toml: "cfg", env: "cfg", properties: "cfg", gradle: "cfg", htaccess: "cfg", gitignore: "cfg", c: "c", h: "c", cpp: "c", hpp: "c", cc: "c", rs: "c"};
  const langOf = p => LANG[ext(p)] || "txt";
  const FN_RE = {
    js: [/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
         /^[ \t]*(?:async\s+|static\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b|function\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm],
    php: [/\bfunction\s+&?\s*([A-Za-z_]\w*)\s*\(/g],
    py: [/^\s*def\s+([A-Za-z_]\w*)\s*\(/gm],
    java: [/^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|override|async|virtual|internal|open|suspend|fun)\s+)+[\w<>\[\],.?\s]*?([A-Za-z_]\w*)\s*\([^;{]*\)\s*(?::\s*[\w<>?,\s]+)?(?:throws\s+[\w.,\s]+)?\{/gm],
    go: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm],
    rb: [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/gm],
    c: [/^[\w\s\*&<>:]+?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm]
  };
  function lineOf(text, index) { let n = 1; for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++; return n; }
  function functionsOf(files) {
    const defs = [];
    Object.keys(files).forEach(p => {
      const res = FN_RE[langOf(p)]; if (!res) return;
      const t = files[p], seen = new Set();
      res.forEach(re => {
        re.lastIndex = 0; let m;
        while ((m = re.exec(t))) {
          const name = m[1];
          if (!name || seen.has(name) || name.length < 2) continue;
          seen.add(name);
          defs.push({name, path: p, line: lineOf(t, m.index + m[0].lastIndexOf(name))});
        }
      });
    });
    const split = {};
    Object.keys(files).forEach(p => split[p] = files[p].split("\n"));
    defs.forEach(d => {
      const re = new RegExp("(^|[^\\w$])" + d.name.replace(/[$]/g, "\\$") + "\\s*\\(");
      d.uses = [];
      Object.keys(split).forEach(p => split[p].forEach((l, i) => {
        if (d.uses.length >= 25 || (p === d.path && i + 1 === d.line)) return;
        if (re.test(l)) d.uses.push({path: p, line: i + 1, code: l.trim().slice(0, 140)});
      }));
    });
    return defs.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }
  const lineCount = t => t === "" ? 0 : t.split("\n").length - (t.endsWith("\n") ? 1 : 0);

  /* ----- a new version of a file: the explained blocks whose lines did not change, moved to where they are now ----- */
  // blocks: [{from, to, …}] of the old text → {blocks: the ones kept (with new line numbers), gaps: [[from, to]] of new lines without explanation}
  function carryBlocks(oldText, newText, blocks) {
    const split = t => { const a = t.split("\n"); if (t.endsWith("\n")) a.pop(); return a; };
    const O = split(oldText), N = split(newText), at = {};
    N.forEach((l, i) => { (at[l] = at[l] || []).push(i); });
    const kept = []; let min = 0, shift = 0;
    (blocks || []).slice().sort((a, b) => a.from - b.from).forEach(b => {
      // the block without its blank lines at the edges: blank lines are free to move
      let s = b.from - 1, e = b.to - 1;
      while (s <= e && !(O[s] || "").trim()) s++;
      while (e >= s && !(O[e] || "").trim()) e--;
      if (s > e) return;
      const seq = O.slice(s, e + 1), want = s + shift;
      let best = -1;
      (at[seq[0]] || []).forEach(i => {
        if (i < min || i + seq.length > N.length) return;
        for (let k = 1; k < seq.length; k++) if (N[i + k] !== seq[k]) return;
        if (best < 0 || Math.abs(i - want) < Math.abs(best - want)) best = i;
      });
      if (best < 0) return;
      kept.push(Object.assign({}, b, {from: best + 1, to: best + seq.length}));
      min = best + seq.length; shift = best - s;
    });
    // the new lines not covered by a kept block (blank lines don't need an explanation)
    const cov = new Uint8Array(N.length);
    kept.forEach(b => { for (let i = b.from - 1; i < b.to; i++) cov[i] = 1; });
    const gaps = []; let g = -1;
    for (let i = 0; i <= N.length; i++) {
      const open = i < N.length && !cov[i];
      if (open && g < 0) g = i;
      if (!open && g >= 0) { if (N.slice(g, i).some(l => l.trim())) gaps.push([g + 1, i]); g = -1; }
    }
    return {blocks: kept, gaps};
  }

  /* ----- things that look like passwords or keys (before sharing the code) ----- */
  // each rule: what it is, and a pattern whose group 1 is the secret itself
  const SECRET_RULES = [
    ["Clave privada", /(-----BEGIN [A-Z ]*PRIVATE KEY-----)/],
    ["Clave de Google", /\b(AIza[0-9A-Za-z_-]{35})\b/],
    ["Clave de AWS", /\b(AKIA[0-9A-Z]{16})\b/],
    ["Token de GitHub", /\b((?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,})\b/],
    ["Clave de API", /\b((?:sk|pk|rk)[-_](?:live[-_]|test[-_]|proj[-_]|ant[-_])?[A-Za-z0-9_-]{20,})\b/],
    ["Contraseña en un enlace", /\b(?:mongodb(?:\+srv)?|mysql|postgres(?:ql)?|redis|amqp|ftp|smtp):\/\/[^:\s"'\/]+:([^@\s"'\/]{3,})@/i],
    ["Contraseña de la base de datos", /\b(?:mysqli_connect|new\s+mysqli|mysqli|mysql_connect)\s*\(\s*["'][^"']*["']\s*,\s*["'][^"']*["']\s*,\s*["']([^"']{3,})["']/i],
    ["Contraseña o clave", /(?:pass(?:word|wd)?|pwd|contrase(?:ñ|n)a|clave|secret|secreto|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|token|private[_-]?key)["']?\s*(?:=>|:=|[:=])\s*["'`]([^"'`\s]{4,})["'`]/i],
    ["Contraseña o clave", /^\s*(?:export\s+)?[A-Z0-9_]*(?:PASS(?:WORD)?|PWD|SECRET|API_?KEY|TOKEN|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*["']?([^"'\s#]{4,})/]
  ];
  // examples and blanks that are fine to share
  const SECRET_FAKE = /^(?:\*+|x+|\.+|-+|change_?me|your[_-]?\S*|tu[_-]?\S*|mi[_-]?(?:clave|contrase(?:ñ|n)a)|example|ejemplo|placeholder|password|contrase(?:ñ|n)a|secret|null|none|undefined|true|false|\$\{?\w+\}?|process\.env\.\w+|<[^>]*>|\{\{.*\}\})$/i;
  function secretsOf(files) {
    const out = [];
    Object.keys(files).sort().forEach(p => {
      const name = p.split("/").pop().toLowerCase(), isEnv = /^\.env(\..+)?$/.test(name);
      if (/example|sample|template|\.dist$/.test(name)) return;                      // files made to show what goes where
      files[p].split("\n").forEach((l, i) => {
        if (l.length > 2000) return;
        for (const [what, re] of SECRET_RULES) {
          const m = l.match(re), v = m && m[1];
          if (!v || SECRET_FAKE.test(v)) continue;
          out.push({path: p, line: i + 1, what: isEnv ? "En un archivo .env" : what, val: v}); return;
        }
      });
    });
    return out.slice(0, 200);
  }
  // a copy of anything (code, explanations, glossary…) with those secrets replaced by •••
  function maskSecrets(obj, vals) {
    let s = JSON.stringify(obj);
    [...new Set(vals)].filter(v => v && v.length >= 3).sort((a, b) => b.length - a.length)
      .forEach(v => { s = s.split(JSON.stringify(v).slice(1, -1)).join("•••"); });
    return JSON.parse(s);
  }

  return {collect, folderEntries, zipEntries, parseRepo, repoInfo, githubEntries, gitHistory, ghMsg, langOf, ext, functionsOf, lineCount, carryBlocks, secretsOf, maskSecrets, MAX_TOTAL};
})();

;
/* Clarea · AI engine for projects, shared by every page.
   The list of parts to generate is saved on this device, so generating keeps going while you move around Clarea
   (home, calendar, other projects) and carries on by itself when the app is opened again.
   When everything is done you get a notice inside Clarea and, if allowed, a system notification. */
window.CLAI = (function () {
  "use strict";
  const U = () => "u/" + (window.PJ6USER || "_") + "/";
  const lget = k => { try { return JSON.parse(localStorage.getItem(U() + k)); } catch (e) { return null; } };
  const lset = (k, v) => { try { localStorage.setItem(U() + k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const esc = s => String(s === undefined || s === null ? "" : s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
  const baseName = p => p.split("/").pop();

  /* ---------- providers and the key (the key lives only on this device) ---------- */
  const PROV = {
    gemini: {t: "Gemini", s: "Google", url: "https://aistudio.google.com/apikey", note: "Tiene un uso gratuito con límites diarios."}
  };
  // only for testing on this computer: a local stand-in that answers like Gemini
  const GEMINI = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && (function () { try { return localStorage.getItem("clarea-dev-ai"); } catch (e) { return null; } })()) || "https://generativelanguage.googleapis.com";
  // the AI settings (keys, models, the default AI) go with the account: synced to every device
  function cfg() {
    try {
      const own = JSON.parse(localStorage.getItem(U() + "clarea-ai"));
      if (own) { own.prov = "gemini"; return own; }          // Clarea only offers Gemini as «your AI» now
      const old = JSON.parse(localStorage.getItem("clarea-ai"));            // before: kept only on this device
      if (old && window.PJ6USER) { old.t = Date.now(); localStorage.setItem(U() + "clarea-ai", JSON.stringify(old)); localStorage.removeItem("clarea-ai"); }
      return old || {};
    } catch (e) { return {}; }
  }
  function cfgSet(c) { try { c.t = Date.now(); localStorage.setItem(U() + "clarea-ai", JSON.stringify(c)); } catch (e) {} }
  const ready = () => { const c = cfg(); return !!(c.prov && c.keys && c.keys[c.prov] && c.models && c.models[c.prov] && c.ok && c.ok[c.prov] === c.keys[c.prov]); };

  /* ---------- a project, read fresh from storage ---------- */
  const DT = {facil: "Fácil", media: "Media", dificil: "Difícil"};
  const DD = {facil: "Qué hace cada archivo y conceptos básicos.", media: "Cómo funcionan las partes y cómo se comunican.", dificil: "Detalles, casos límite, seguridad y por qué está hecho así."};
  function ctx(pid) {
    const P = ((lget("clarea-projs") || {}).list || []).find(x => x.id === pid), CODE = lget("clarea-pcode-" + pid);
    if (!P || !CODE) return null;
    const AID = lget("clarea-pai-" + pid) || {};
    AID.files = AID.files || {}; AID.exams = AID.exams || {}; AID.done = AID.done || {}; AID.glossary = AID.glossary || [];
    const paths = Object.keys(CODE.files).sort((a, b) => a.localeCompare(b));
    const lines = p => { const t = CODE.files[p]; const a = t.split("\n"); if (t.endsWith("\n")) a.pop(); return a; };
    return {pid, P, CODE, AID, GIT: lget("clarea-pgit-" + pid), paths, lines, save: () => { AID.t = Date.now(); return lset("clarea-pai-" + pid, AID); }};
  }

  /* ---------- the parts to generate ---------- */
  // lines of code per part: with a key the AI reads big parts (far fewer requests, so the free limits last);
  // copied by hand into a chat they stay small, because chats cut long answers
  const LIM_KEY = 1500, LIM_PASTE = 450;
  const explainable = (c, p) => !["md", "txt", "cfg"].includes(CL.langOf(p)) && CL.lineCount(c.CODE.files[p]) > 0 && !(CL.langOf(p) === "json" && CL.lineCount(c.CODE.files[p]) > 300);
  function buildJobs(c, opt) {
    const LIM = opt && opt.paste ? LIM_PASTE : LIM_KEY;
    const jobs = []; let cur = [], curN = 0, k = 0;
    const flush = () => { if (cur.length) { jobs.push({id: "code-" + (k++), kind: "code", parts: cur}); cur = []; curN = 0; } };
    c.paths.filter(p => explainable(c, p)).forEach(p => {
      const n = CL.lineCount(c.CODE.files[p]), F = c.AID.files[p];
      // after updating the code, a file that changed a little is explained only where it changed (its «gaps»)
      const ranges = F && Array.isArray(F.gaps) && F.gaps.length ? F.gaps.map(g => [Math.max(1, +g[0]), Math.min(n, +g[1])]).filter(g => g[0] <= g[1]) : [[1, n]];
      ranges.forEach(([a0, z]) => {
        const len = z - a0 + 1;
        if (len > LIM) { flush(); for (let a = a0; a <= z; a += LIM) jobs.push({id: "code-" + (k++), kind: "code", parts: [{p, from: a, to: Math.min(z, a + LIM - 1)}]}); return; }
        if (curN + len > LIM) flush();
        cur.push({p, from: a0, to: z}); curN += len;
      });
    });
    flush();
    jobs.push({id: "gloss", kind: "gloss"});
    ["facil", "media", "dificil"].forEach(d => jobs.push({id: "exam-" + d, kind: "exam", diff: d}));
    if (c.GIT) jobs.push({id: "git", kind: "git"});
    return jobs;
  }
  function jobTitle(c, j) {
    if (j.kind === "code") return j.parts.length === 1 ? (j.parts[0].from > 1 || j.parts[0].to < CL.lineCount(c.CODE.files[j.parts[0].p]) ? baseName(j.parts[0].p) + " (líneas " + j.parts[0].from + "–" + j.parts[0].to + ")" : baseName(j.parts[0].p)) : ((u => u.length === 1 ? u[0] + " (partes que cambian)" : u.length + " archivos: " + u.slice(0, 3).join(", ") + (u.length > 3 ? "…" : ""))([...new Set(j.parts.map(x => baseName(x.p)))]));
    return {gloss: "Glosario", git: "Ramas y pull requests"}[j.kind] || "Exámenes · " + DT[j.diff];
  }
  const jobWhat = j => j.kind === "code" ? "Qué hace cada archivo y cada línea" : j.kind === "gloss" ? "Conceptos con ejemplos de tu código" : j.kind === "git" ? "Para qué es cada rama y cada PR" : "20 preguntas de test y 6 escritas";
  // a code part is done when its lines are explained (whatever size the parts had when they were made)
  function isDone(c, j) {
    if (j.kind !== "code") return !!c.AID.done[j.id];
    // every line of the part with code in it is inside an explained block (blank lines don't count)
    return j.parts.every(x => {
      const F = c.AID.files[x.p], B = F && F.blocks; if (!B || !B.length) return false;
      const ls = c.lines(x.p), cov = new Uint8Array(x.to - x.from + 1);
      B.forEach(b => { for (let i = Math.max(b.from, x.from); i <= Math.min(b.to, x.to); i++) cov[i - x.from] = 1; });
      for (let i = x.from; i <= x.to; i++) if (!cov[i - x.from] && (ls[i - 1] || "").trim()) return false;
      return true;
    });
  }
  function status(c, opt) { const js = buildJobs(c, opt); return {total: js.length, done: js.filter(j => isDone(c, j)).length, jobs: js}; }

  /* ---------- the instructions sent to the AI ---------- */
  const numbered = (c, p, from, to) => c.lines(p).slice(from - 1, to).map((t, i) => (from + i) + "| " + t).join("\n");
  function codeBundle(c, limit) {
    // the whole project, numbered; if it is too long, each file is cut so everything fits
    const tot = c.paths.reduce((s, p) => s + c.CODE.files[p].length, 0), ratio = Math.min(1, limit / Math.max(1, tot));
    return c.paths.map(p => { const ls = c.lines(p), keep = ratio >= 1 ? ls.length : Math.max(15, Math.floor(ls.length * ratio)); return "=== " + p + " (" + ls.length + " líneas" + (keep < ls.length ? ", recortado a las primeras " + keep : "") + ") ===\n" + numbered(c, p, 1, Math.min(keep, ls.length)); }).join("\n\n");
  }
  function summaries(c) { const s = c.paths.filter(p => c.AID.files[p] && c.AID.files[p].what).map(p => "- " + p + ": " + c.AID.files[p].what); return s.length ? "Resumen de cada archivo:\n" + s.join("\n") + "\n\n" : ""; }
  const intro = c => 'Eres profesor de Desarrollo de Aplicaciones Web. Un estudiante tiene un examen sobre el código de su proyecto «' + c.P.name + '»' + (c.P.desc ? ' (' + c.P.desc + ')' : '') + ', de la asignatura ' + c.P.subj + '. ';
  const JSONONLY = 'Responde SOLO con un objeto JSON válido, sin texto antes ni después y sin ```.';
  const stLabel = s => s === "merged" ? "Merged" : s === "open" ? "Abierto" : "Cerrado";
  function prompt(c, j) {
    if (j.kind === "code") return intro(c) + 'Explícale este código para que lo entienda y sepa explicarlo en el examen.\n\n' + JSONONLY + ' Forma exacta:\n{"files":{"RUTA":{"role":"tipo de archivo en 2-5 palabras","what":"qué hace el archivo y para qué sirve en el proyecto, 2-3 frases","blocks":[{"from":1,"to":8,"imp":3,"easy":"explicación sencilla, 1-2 frases","tech":"explicación técnica y precisa, 1-3 frases"}]}}}\n\nReglas:\n- En "files" van exactamente estos archivos, con la ruta tal cual: ' + j.parts.map(x => x.p).join(", ") + '.\n- "blocks" cubre TODAS las líneas indicadas de cada archivo, en orden y sin huecos ni repeticiones: el primer bloque empieza en la primera línea indicada, cada bloque empieza en la línea siguiente al anterior y el último acaba en la última línea indicada.\n- Cada bloque agrupa de 1 a 15 líneas que van juntas (una función corta, un if, un formulario…). Las líneas en blanco van con el bloque de al lado.\n- "imp" es la importancia para el examen: 3 = clave (lógica principal, comunicación cliente-servidor, seguridad, datos), 2 = importante, 1 = normal, 0 = secundario (estructura, estilos, cosas repetidas).\n- En español. Los nombres de código van entre « » (por ejemplo «fetch», «$_POST»). No copies el código en las explicaciones.\n\nCódigo (cada línea empieza por su número):\n\n' + j.parts.map(x => { const n = CL.lineCount(c.CODE.files[x.p]); return "=== " + x.p + " (líneas " + x.from + "-" + x.to + " de " + n + ") ===\n" + numbered(c, x.p, x.from, x.to); }).join("\n\n");
    if (j.kind === "gloss") return intro(c) + 'Haz un glosario de los conceptos de programación que aparecen en este proyecto y que el estudiante debe saber explicar (funciones del lenguaje, palabras clave, estructuras, APIs, formatos…). Entre 12 y 24 conceptos, de más a menos importante.\n\n' + JSONONLY + ' Forma exacta:\n{"glossary":[{"term":"nombre corto, por ejemplo fetch() o $_SESSION","cat":"lenguaje o tema: PHP, JavaScript, HTML, CSS, SQL, Java…","easy":"qué es, en una frase corta","easyLong":"explicado fácil para alguien que empieza, con una comparación de la vida real, 2-3 frases","tech":"explicación técnica, 1-3 frases","code":"1 a 3 líneas copiadas tal cual del proyecto donde se usa","file":"ruta del archivo","line":12}]}\n\nEn español. Nombres de código entre « ».\n\n' + summaries(c) + 'Código:\n\n' + codeBundle(c, 90000);
    if (j.kind === "exam") return intro(c) + 'Escribe preguntas de examen de dificultad ' + DT[j.diff].toUpperCase() + ' sobre este proyecto: ' + DD[j.diff] + '\n\n' + JSONONLY + ' Forma exacta:\n{"questions":[{"type":"mc","q":"pregunta","options":["opción a","opción b","opción c","opción d"],"answer":0,"why":"por qué es la correcta, 1-2 frases","wrong":["por qué la a no es (vacío si es la correcta)","…b","…c","…d"],"file":"ruta","line":12},{"type":"written","q":"pregunta para responder en 2-5 frases","model":"respuesta modelo de 2-5 frases","keyTerms":["3 a 6 conceptos o nombres que una buena respuesta debe decir"],"wrong":["0 a 3 ideas falsas típicas"],"file":"ruta","line":12}]}\n\nReglas:\n- Exactamente 20 de tipo "mc" y 6 de tipo "written".\n- Tratan sobre ESTE código: qué hace una función, qué pasa si…, por qué se usa…, qué devuelve…, en qué archivo está….\n- En las de test solo una opción es correcta y las otras son creíbles; reparte la correcta entre a, b, c y d.\n- "answer" es la posición de la correcta: 0 = a, 1 = b, 2 = c, 3 = d.\n- "file" y "line" señalan dónde se ve la respuesta en el código.\n- En español. Nombres de código entre « ».\n\n' + summaries(c) + 'Código:\n\n' + codeBundle(c, 90000);
    const G = c.GIT;
    return intro(c) + 'Explícale el historial de Git del proyecto.\n\n' + JSONONLY + ' Forma exacta:\n{"summary":"cómo está organizado el trabajo en el repositorio, 2-3 frases","branches":{"NOMBRE DE LA RAMA":{"why":"para qué se creó, 1-2 frases","changed":"qué se cambió en ella, 1-2 frases"}},"prs":{"NÚMERO":{"what":"qué aporta este pull request, 1-2 frases"}}}\n\nEn español. Incluye todas las ramas y todos los pull requests.\n\nRama principal: ' + G.def + '\nRamas: ' + G.branches.join(", ") + '\n\nCommits (fecha · rama · mensaje):\n' + G.commits.map(x => x.d.slice(0, 10) + " · " + x.b + " · " + x.m).join("\n") + '\n\nPull requests:\n' + G.prs.map(p => "#" + p.n + " " + p.t + " (" + p.from + " → " + p.to + ", " + stLabel(p.st) + ")" + (p.body ? "\n  " + p.body.slice(0, 300).replace(/\n/g, " ") : "") + "\n  archivos: " + p.f.map(f => f[0]).join(", ")).join("\n");
  }
  /* every complete JSON object in a chat answer (it may have several, or be cut at the end).
     If the last one is cut, the complete objects inside it are kept too (as {__partial: [...]}) */
  function jsonBlocks(text) {
    const out = [], t = String(text || ""); let depth = 0, start = -1, inS = false, esc = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (inS) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inS = false; continue; }
      if (ch === '"') { if (depth > 0) inS = true; continue; }
      if (ch === "{") { if (depth === 0) start = i; depth++; }
      else if (ch === "}" && depth > 0) { depth--; if (depth === 0) { try { out.push(JSON.parse(t.slice(start, i + 1))); } catch (e) {} start = -1; } }
    }
    if (depth > 0 && start >= 0) { const inner = jsonBlocks(t.slice(start + 1)); if (inner.length) out.push({__partial: inner}); }
    return out;
  }
  // one part's instructions without the code (the code goes once, at the end)
  function partText(c, j) {
    let t = prompt(c, j).slice(intro(c).length);
    if (j.kind !== "git") { const k = t.search(/\n\nCódigo/); if (k > 0) t = t.slice(0, k); }
    t = t.split(JSONONLY).join("Su objeto JSON.");
    if (j.kind === "code") t += "\nArchivos de esta parte (están en el código del final): " + j.parts.map(x => x.p + " (líneas " + x.from + "-" + x.to + ")").join(", ") + ".";
    return t;
  }
  /* ---------- the Clarea connector for Claude: Claude works with the student's own subscription ---------- */
  const mcpKey = () => (cfg().mcp || {}).k || "";
  const mcpOn = () => /^[A-Za-z0-9_-]{32}$/.test(mcpKey());
  const mcpUrl = () => PUSHURL() + "/mcp/" + mcpKey();
  const randKey = () => btoa(String.fromCharCode.apply(null, crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, "-").replace(/\//g, "_");
  async function mcpPost(path, body) {
    const r = await fetch(PUSHURL() + path, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(Object.assign({k: mcpKey()}, body))});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 413 ? "Es demasiado grande para enviarlo a Claude." : (r.status === 404 || (r.status === 400 && j.error === "key")) ? "El servidor de Clarea aún no tiene el conector (falta desplegarlo)." : "No se ha podido (" + (j.error || r.status) + ").");
    return j;
  }
  async function mcpConnect() { const c = cfg(); c.mcp = {k: randKey(), t: Date.now()}; cfgSet(c); await mcpPost("/mcp-hello", {}); return mcpUrl(); }
  async function mcpDisconnect() { try { await mcpPost("/mcp-forget", {}); } catch (e) {} const c = cfg(); delete c.mcp; cfgSet(c); }
  // with the task goes this device's notice address (if notices are on): the server tells the phone when Claude finishes
  async function mcpPush(task) {
    let pk = null; try { pk = window.clareaPushK ? await window.clareaPushK() : null; } catch (e) {}
    return mcpPost("/mcp-push", {task: Object.assign({url: (location.pathname.slice(new URL(document.baseURI).pathname.length) || "./") + location.search}, task), pk});
  }
  const mcpDrop = id => mcpPost("/mcp-drop", {id}).catch(() => {});
  const mcpApplied = {}, MST = {}, MTITLES = {};
  const escH = t => String(t == null ? "" : t).replace(/[&<>"]/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[ch]));
  const agoTxt = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "ahora mismo" : m === 1 ? "hace 1 minuto" : m < 60 ? "hace " + m + " minutos" : "hace " + Math.round(m / 60) + " h"; };
  const minsTxt = ms => { const m = Math.max(1, Math.round(ms / 60000)); return m === 1 ? "1 minuto" : m + " minutos"; };
  function mcpCss() {
    if (document.getElementById("mcppcss")) return;
    const st = document.createElement("style"); st.id = "mcppcss";
    st.textContent = '.mcpprog{display:flex;flex-direction:column;gap:10px;margin:6px 0 4px}'
      + '.mcpp{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}'
      + '.mcpp li{display:flex;gap:10px;align-items:flex-start;margin:0}'
      + '.mcpp li>i{flex:none;width:20px;height:20px;border-radius:50%;border:2px solid var(--line);box-sizing:border-box;margin-top:1px;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:11px;font-weight:900;color:#fff}'
      + '.mcpp li.ok>i{background:#2e9d5b;border-color:#2e9d5b}.mcpp li.ok>i::after{content:"✓"}'
      + '.mcpp li.now>i{border-color:var(--accent);border-top-color:transparent;animation:mcpspin 1s linear infinite}'
      + '@keyframes mcpspin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion: reduce){.mcpp li.now>i{animation:none;border-top-color:var(--accent)}}'
      + '.mcpp li>span{display:flex;flex-direction:column;gap:1px;min-width:0}.mcpp b{font-size:14px;font-weight:700}.mcpp small{font-size:12.5px;color:var(--muted)}'
      + '.mcpp li:not(.ok):not(.now) b{color:var(--muted);font-weight:600}'
      + '.mcpbar{height:6px;border-radius:3px;background:var(--line);overflow:hidden}.mcpbar>i{display:block;height:100%;background:#2e9d5b;transition:width .4s}'
      + '.mcpparts{display:flex;flex-wrap:wrap;gap:6px}.mcpparts span{font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}.mcpparts span.ok{color:var(--fg);border-color:#2e9d5b}'
      + '.mcpwarn{margin:0;font-size:13px;line-height:1.45;padding:8px 10px;border-radius:10px;border:1px solid rgba(214,138,28,.5);background:rgba(214,138,28,.10)}';
    document.head.appendChild(st);
  }
  /* how a task sent to Claude is going: sent → Claude opened it → parts saved (how many, about how long is left) → ready.
     titles: [[partId, title], …] of the parts that were sent */
  function mcpProgressHtml(id, titles, sentAt) {
    mcpCss(); if (titles) MTITLES[id] = titles; titles = MTITLES[id] || [];
    const st = MST[id] || {}, saved = st.saved || [], total = titles.length || st.total || 1, read = st.read || 0, sent = st.sent || sentAt || Date.now();
    const n = saved.length, done = n >= total;
    let eta = "";
    if (n && !done) { const ts = Object.values(st.times || {}); const last = ts.length ? Math.max.apply(null, ts) : Date.now(); const left = Math.max(1, Math.round((last - (read || sent)) / n * (total - n) / 60000)); eta = left === 1 ? "queda 1 minuto, más o menos" : "quedan unos " + left + " minutos"; }
    else if (!n) eta = total > 1 ? "suele tardar 1-2 minutos por parte" : "suele tardar 1-2 minutos";
    const li = (cls, b, sm) => '<li class="' + cls + '"><i aria-hidden="true"></i><span><b>' + b + '</b>' + (sm ? '<small>' + sm + '</small>' : '') + '</span></li>';
    let h = '<ol class="mcpp">'
      + li("ok", "Enviado a Claude", agoTxt(sent))
      + li(read || n ? "ok" : "now", read || n ? "Claude lo ha abierto" : "En Claude, pulsa enviar", read ? agoTxt(read) : n ? "" : "El mensaje ya está escrito. Esperando a Claude…")
      + li(done ? "ok" : read || n ? "now" : "", "Claude prepara y guarda " + (total > 1 ? "cada parte" : "la hoja"), (total > 1 ? n + " de " + total + " partes" : n ? "guardada" : "aún no") + (eta ? " · " + eta : ""))
      + li(done ? "ok" : "", "Listo en Clarea", done ? "¡Ya lo tienes!" : "Aparecerá aquí solo, sin hacer nada")
      + '</ol>';
    if (total > 1) h += '<div class="mcpbar" role="progressbar" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + n + '" aria-label="Partes guardadas"><i style="width:' + Math.round(n / total * 100) + '%"></i></div>'
      + '<div class="mcpparts">' + titles.map(x => '<span class="' + (saved.includes(x[0]) ? 'ok' : '') + '">' + (saved.includes(x[0]) ? '✓ ' : '') + escH(x[1]) + '</span>').join("") + '</div>';
    if (!read && !n && Date.now() - sent > 3 * 60000) h += '<p class="mcpwarn">¿No pasa nada? En Claude, toca <b>«+» → Conectores</b> y comprueba que <b>Clarea</b> está activado; luego toca «Abrir Claude otra vez» y pulsa enviar. La primera vez, dale a <b>«Permitir siempre»</b>.</p>';
    return '<div class="mcpprog" data-mcpprog="' + escH(id) + '" aria-live="polite">' + h + '</div>';
  }
  function mcpPaint(id) { document.querySelectorAll('[data-mcpprog="' + id + '"]').forEach(el => { el.outerHTML = mcpProgressHtml(id); }); }
  // what Claude saved: each new part goes through applyPart(partId, data); says how far it is
  async function mcpCollect(id, applyPart) {
    const A = mcpApplied[id] || (mcpApplied[id] = new Set()), r = await mcpPost("/mcp-res", {id, have: [...A]});
    if (r.gone) return {gone: true};
    MST[id] = {saved: r.saved || [], total: r.total || 0, read: r.read || 0, times: r.times || {}, sent: r.sent || 0}; mcpPaint(id);
    let n = 0, bad = [];
    Object.keys(r.parts || {}).forEach(p => { try { applyPart(p, r.parts[p]); n++; } catch (e) { bad.push(p); } A.add(p); });
    return {n, bad, saved: (r.saved || []).length, total: r.total || 0, done: (r.saved || []).length >= (r.total || 1)};
  }
  const MCP_SAY = "Prepara lo que tengo pendiente en Clarea";
  // Claude opens with the message already written: the student only taps «send» (Claude doesn't let a link send it)
  const MCP_URL = "https://claude.ai/new?q=" + encodeURIComponent(MCP_SAY);
  const MCP_APP = "claude://claude.ai/new?q=" + encodeURIComponent(MCP_SAY);
  const onPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function openLink(u) { const a = document.createElement("a"); a.href = u; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); }
  /* open Claude with the message already written: the app if this device has it, if not the web.
     Phone: claude.ai/new is one of the links the Claude app takes, so the system opens the app if it is installed (if not, the web).
     Computer: the app answers «claude://»; if nothing takes it in a moment, the web opens (and this device remembers it for a week) */
  function mcpOpenClaude(msg) {
    const WEB = msg ? "https://claude.ai/new?q=" + encodeURIComponent(msg.slice(0, 12000)) : MCP_URL, APP = msg ? "claude://claude.ai/new?q=" + encodeURIComponent(msg.slice(0, 12000)) : MCP_APP;
    if (onPhone()) { openLink(WEB); return; }
    let web = 0; try { web = +localStorage.getItem("clarea-claudeweb") || 0; } catch (e) {}
    if (Date.now() - web < 7 * 864e5) { openLink(WEB); return; }
    let left = false; const went = () => { left = true; };
    window.addEventListener("blur", went); document.addEventListener("visibilitychange", went);
    if (/Firefox\//.test(navigator.userAgent)) { const f = document.createElement("iframe"); f.style.display = "none"; f.src = APP; document.body.appendChild(f); setTimeout(() => f.remove(), 3000); }
    else location.href = APP;
    setTimeout(() => {
      window.removeEventListener("blur", went); document.removeEventListener("visibilitychange", went);
      if (left) return;                                                       // the app (or the browser asking to open it) took it
      try { localStorage.setItem("clarea-claudeweb", String(Date.now())); } catch (e) {}
      openLink(WEB);
    }, 1500);
  }
  /* «Enviar a Claude»: a notice first (unless the student said not to ask again), then Claude opens and the task goes */
  async function mcpGo(what, run, msg) {
    const c = cfg();
    if (!c.mcpNoAsk && window.clareaConfirm) {
      let never = false;
      const yes = await window.clareaConfirm({info: true, title: "Vas a abrir Claude", ok: "Abrir Claude", cancel: "Cancelar",
        html: "Clarea envía " + escH(what) + " a Claude y lo abre " + (onPhone() ? "(la app, si la tienes)" : "(la app, si la tienes; si no, la web)") + " con el mensaje ya escrito. Allí solo tienes que <b>pulsar enviar</b>. " + (msg ? "Claude te responde allí, y la respuesta también llegará aquí." : "Luego vuelve a Clarea: lo verás llegar."),
        check: "No volver a preguntar", onCheck: v => { never = v; }});
      if (!yes) return false;
      if (never) { const x = cfg(); x.mcpNoAsk = true; cfgSet(x); }
    }
    mcpOpenClaude(msg); run(); return true;
  }
  // a project as a task for Claude: the parts still to do, and the code once
  function mcpProjectTask(c, jobs) {
    return {id: "p-" + c.pid, kind: "proyecto", title: c.P.name + " (" + c.P.subj + ")",
      intro: intro(c) + "Vas a prepararle el repaso de su proyecto por partes. Para cada parte, crea el objeto JSON exacto que piden sus instrucciones y guárdalo con clarea_guardar. En español; los nombres de código entre « ».",
      parts: jobs.map(j => ({id: j.id, title: jobTitle(c, j), instructions: partText(c, j)})),
      context: "### CÓDIGO DEL PROYECTO (cada línea empieza por su número)\n" + summaries(c) + codeBundle(c, 600000)};
  }
  /* the whole project in ONE message, for a chat (Claude Pro, ChatGPT Plus…): the code once, then every part */
  function promptAll(c, jobs) {
    const tasks = jobs.map(j => {
      let t = prompt(c, j).slice(intro(c).length);
      if (j.kind !== "git") { const k = t.search(/\n\nCódigo/); if (k > 0) t = t.slice(0, k); }
      t = t.split(JSONONLY).join("Su objeto JSON.");
      if (j.kind === "code") t += "\nArchivos de esta parte (están en el código del final): " + j.parts.map(x => x.p + " (líneas " + x.from + "-" + x.to + ")").join(", ") + ".";
      return "### TAREA " + j.id + " · " + jobTitle(c, j) + "\n" + t;
    });
    return intro(c) + "Vas a prepararle el repaso completo de su proyecto, en " + jobs.length + " partes.\n\n"
      + "CÓMO RESPONDER (muy importante: una app lee tu respuesta automáticamente):\n"
      + "- Para cada tarea escribe una línea «### PARTE: ID» (el ID tal cual: " + jobs.map(j => j.id).join(", ") + ") y debajo SOLO su objeto JSON válido, sin ``` ni explicaciones.\n"
      + "- Hazlas en orden. Si no te caben todas en un mensaje, acaba la parte que estés escribiendo, para y escribe «SIGUE». Cuando el estudiante te escriba «sigue», continúa con la parte siguiente, sin repetir ninguna.\n\n"
      + tasks.join("\n\n") + "\n\n### CÓDIGO DEL PROYECTO (cada línea empieza por su número)\n" + summaries(c) + codeBundle(c, 600000);
  }
  // a chat answer to promptAll: saves every part it brings; says which ones came and which could not be read
  function applyAll(c, jobs, text) {
    const saved = [], bad = [];
    String(text || "").split(/^[ \t]*#{1,4}[ \t]*PARTE:?[ \t]*/mi).slice(1).forEach(seg => {
      const id = (seg.match(/^[\w-]+/) || [""])[0], j = jobs.find(x => x.id === id); if (!j) return;
      const data = jsonBlocks(seg.slice(id.length)).find(o => !o.__partial);
      if (!data) { bad.push(id); return; }
      try { applyResult(c, j, data); saved.push(id); } catch (e) { bad.push(id); }
    });
    return {saved, bad};
  }
  function parseJSON(text) {
    let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("No hay ningún objeto JSON en la respuesta.");
    t = t.slice(a, b + 1);
    try { return JSON.parse(t); } catch (e) { return JSON.parse(t.replace(/,\s*([}\]])/g, "$1")); }
  }
  // take the AI's answer for one part and save it; throws with a clear message if it is not usable
  function applyResult(c, j, data) {
    const AID = c.AID, files = c.CODE.files, fix = f => !f || files[f] ? f : (c.paths.find(p => p.endsWith(f) || baseName(p) === baseName(f)) || "");
    if (j.kind === "code") {
      const F = data && data.files; if (!F || typeof F !== "object") throw new Error("Falta «files» en la respuesta.");
      let got = 0;
      j.parts.forEach(x => {
        const key = Object.keys(F).find(k => k === x.p) || Object.keys(F).find(k => k.endsWith("/" + baseName(x.p)) || k === baseName(x.p) || x.p.endsWith(k));
        const r = key && F[key]; if (!r) return; got++;
        const A = AID.files[x.p] = AID.files[x.p] || {blocks: []};
        if (r.role && (x.from === 1 || !A.role)) A.role = String(r.role).slice(0, 60);
        if (r.what && (x.from === 1 || !A.what)) A.what = String(r.what).slice(0, 800);
        // blocks: in order, inside the range, no gaps, no overlaps
        const bs = (Array.isArray(r.blocks) ? r.blocks : []).map(b => ({from: +b.from, to: +b.to, imp: Math.max(0, Math.min(3, Math.round(+b.imp) || 0)), easy: String(b.easy || "").slice(0, 500), tech: String(b.tech || "").slice(0, 800)}))
          .filter(b => b.from && b.to && b.to >= b.from && b.to >= x.from && b.from <= x.to).sort((a, b) => a.from - b.from);
        const ls = c.lines(x.p), blank = (a, z) => ls.slice(a - 1, z).every(l => !l.trim());
        const out = []; let cur = x.from;
        // a gap made only of blank lines joins the block before it (or the next one); a real gap gets its own block
        const gap = (a, z, next) => { if (blank(a, z)) { if (out.length) out[out.length - 1].to = z; else if (next) next.from = a; else out.push({from: a, to: z, imp: 0, easy: "", tech: ""}); } else out.push({from: a, to: z, imp: 1, easy: "", tech: ""}); };
        bs.forEach(b => { b.from = Math.max(b.from, cur); b.to = Math.min(b.to, x.to); if (b.to < b.from) return; if (b.from > cur) gap(cur, b.from - 1, b); out.push(b); cur = b.to + 1; });
        if (cur <= x.to) gap(cur, x.to, null);
        A.blocks = (A.blocks || []).filter(b => b.to < x.from || b.from > x.to).concat(out).sort((a, b) => a.from - b.from);
      });
      if (!got) throw new Error("La respuesta no tiene ninguno de los archivos pedidos.");
    } else if (j.kind === "gloss") {
      const G = (data && data.glossary || []).filter(g => g && g.term).map(g => ({term: String(g.term).slice(0, 60), cat: String(g.cat || "General").slice(0, 30), easy: String(g.easy || "").slice(0, 400), easyLong: String(g.easyLong || "").slice(0, 700), tech: String(g.tech || "").slice(0, 600), code: String(g.code || "").slice(0, 300), file: fix(g.file ? String(g.file) : ""), line: +g.line || 0}));
      if (G.length < 3) throw new Error("El glosario de la respuesta está vacío.");
      AID.glossary = G;
    } else if (j.kind === "exam") {
      const Q = (data && data.questions || []).map(q => {
        if (!q || !q.q) return null;
        const base = {q: String(q.q).slice(0, 600), file: fix(q.file ? String(q.file) : ""), line: +q.line || 0};
        if (q.type === "mc") { if (!Array.isArray(q.options) || q.options.length !== 4 || !(+q.answer >= 0 && +q.answer <= 3)) return null; return Object.assign(base, {type: "mc", options: q.options.map(o => String(o).slice(0, 300)), answer: +q.answer, why: String(q.why || "").slice(0, 600), wrong: Array.isArray(q.wrong) ? q.wrong.map(w => String(w || "").slice(0, 400)) : []}); }
        if (q.type === "written") { if (!q.model) return null; return Object.assign(base, {type: "written", model: String(q.model).slice(0, 1200), keyTerms: (Array.isArray(q.keyTerms) ? q.keyTerms : []).map(String).slice(0, 8), wrong: (Array.isArray(q.wrong) ? q.wrong : []).map(String).slice(0, 4)}); }
        return null;
      }).filter(Boolean);
      if (Q.filter(q => q.type === "mc").length < 6 || !Q.some(q => q.type === "written")) throw new Error("La respuesta tiene muy pocas preguntas válidas.");
      AID.exams[j.diff] = Q;
    } else {
      if (!data || (!data.branches && !data.prs)) throw new Error("Faltan «branches» y «prs» en la respuesta.");
      AID.git = {summary: String(data.summary || "").slice(0, 800), branches: data.branches || {}, prs: data.prs || {}};
    }
    AID.done[j.id] = Date.now();
    if (!c.save()) throw new Error("No queda espacio en este dispositivo.");
  }

  /* ---------- calling the user's own AI (straight from the browser, with their key) ---------- */
  async function listModels(prov, key) {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=" + encodeURIComponent(key));
    if (!r.ok) throw await apiErr(r, prov);
    return ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent") && /gemini/.test(m.name) && !/(image|tts|audio|embedding|live)/.test(m.name)).map(m => m.name.replace(/^models\//, "")).sort().reverse();
  }
  function pickModel(prov, list) {
    // Gemini: «Flash-Lite» first. Its free use is much bigger (about 500 requests a day, against about 20 for «Flash»)
    const ok = m => !/(preview|exp|thinking|image|tts|live|audio|embedding|computer)/.test(m);
    return list.find(m => ok(m) && /^gemini-[\d.]+-flash-lite$/.test(m)) || list.find(m => ok(m) && /flash-lite/.test(m))
      || list.find(m => ok(m) && /^gemini-[\d.]+-flash$/.test(m)) || list.find(m => /flash/.test(m)) || list[0];
  }
  async function apiErr(r, prov) {
    let m = "", why = "", quota = "", after = 0;
    try {
      const j = await r.json(), det = (j.error && j.error.details) || [];
      m = (j.error && (j.error.message || j.error.status)) || j.message || "";
      why = det.map(d => d.reason || "").join(" ");
      quota = det.map(d => (d.violations || []).map(v => v.quotaId || v.quotaMetric || "").join(" ")).join(" ");
      det.forEach(d => { if (d.retryDelay) after = Math.ceil(parseFloat(d.retryDelay) || 0); });
    } catch (e) {}
    const model = (cfg().models || {})[prov] || "";
    // Gemini, too many requests: it can be a limit per minute (wait), per day (tomorrow) or a model with no free use at all
    if (prov === "gemini" && r.status === 429) {
      let q;
      if (/limit:\s*0\b/.test(m)) { q = new Error("Tu clave gratis no puede usar el modelo «" + model + "»: Google no da uso gratis de ese modelo. Cambia a otro modelo y sigue."); q.retry = false; q.quotaKind = "model"; }
      else if (/PerDay/i.test(quota) || /per day|daily/i.test(m)) { q = new Error("Has gastado el uso gratis de hoy de tu clave de Gemini con «" + model + "». Se renueva cada día: sigue mañana o cambia a otro modelo, que tiene su propio límite. Lo ya hecho se queda guardado."); q.retry = false; q.quotaKind = "day"; }
      else { q = new Error("Gemini: has llegado al límite por minuto del uso gratis."); q.retry = true; q.wait = Math.min(Math.max(after || 60, 15), 120); q.why = "Límite por minuto del uso gratis de Gemini"; }
      q.status = 429; q.detail = m; return q;
    }
    let e;
    // Gemini says exactly what is wrong with the key: tell it in plain words, with what to do
    const G = prov === "gemini" ? (
      /API_KEY_INVALID/.test(why) || /API key not valid/i.test(m) ? "Google no reconoce esta clave: puede que la hayas borrado o cambiado, o que no se copiara entera. Crea una nueva en Google AI Studio (aistudio.google.com/apikey), cópiala con el botón de copiar y pégala aquí otra vez."
      : /API_KEY_EXPIRED/.test(why) || /expired/i.test(m) ? "Esta clave ha caducado. Crea una nueva en Google AI Studio (aistudio.google.com/apikey) y pégala aquí."
      : /HTTP_REFERRER_BLOCKED|REFERER/i.test(why + m) ? "Tu clave solo funciona en ciertas webs. En Google Cloud, en las restricciones de la clave, añade clarea.dev o quita la restricción."
      : /SERVICE_BLOCKED/.test(why) ? "Tu clave tiene restringidas las APIs y no incluye la de Gemini («Generative Language API»). Cambia la restricción en Google Cloud o crea una clave nueva en Google AI Studio."
      : /SERVICE_DISABLED|has not been used|is disabled/i.test(why + m) ? "La API de Gemini no está activada en el proyecto de esta clave. Lo más fácil: crea la clave desde Google AI Studio (aistudio.google.com/apikey), que la activa sola."
      : /location is not supported/i.test(m) ? "Gemini no está disponible desde tu ubicación con esta cuenta."
      : "") : "";
    if (G) e = new Error(G);
    else if (r.status === 401 || r.status === 403) e = new Error("La clave no es válida o no tiene permiso (" + r.status + ").");
    else if (r.status === 429) e = new Error("Has llegado al límite de uso de " + PROV[prov].t + ". Espera un poco o revisa tu saldo." + (m ? " (" + m + ")" : ""));
    else if (r.status === 402) e = new Error("No tienes saldo en tu cuenta de " + PROV[prov].t + ".");
    else e = new Error(PROV[prov].t + " ha respondido con un error " + r.status + (m ? ": " + m : "."));
    e.status = r.status; e.detail = m;
    if (r.status === 503 || r.status === 529 || /overloaded|high demand/i.test(m)) e.why = PROV[prov].t + " está saturada ahora mismo (mucha gente usándola)";
    else if (r.status === 429) e.why = "Límite de uso de " + PROV[prov].t;
    else if (r.status >= 500) e.why = PROV[prov].t + " ha tenido un fallo momentáneo";
    if (after) e.wait = Math.min(after, 120);
    // busy or a short limit: worth trying again in a moment
    e.retry = r.status === 429 || r.status === 500 || r.status === 502 || r.status === 503 || r.status === 504 || r.status === 529;
    return e;
  }
  /* files (photos and PDFs) go with the text: [{mime, b64, name}]. Gemini reads images and PDFs */
  async function callOnce(text, wantJSON, files, opt) {
    opt = opt || {};
    const c = cfg(), prov = c.prov, key = c.keys[prov], model = opt.model || c.models[prov], signal = opt.signal;
    files = files || [];
    let r;
    try {
      const body = {contents: [{role: "user", parts: files.map(f => ({inline_data: {mime_type: f.mime, data: f.b64}})).concat([{text}])}]}; if (wantJSON) body.generationConfig = {responseMimeType: "application/json"};
      r = await fetch(GEMINI + "/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key), {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body), signal});
      if (!r.ok) throw await apiErr(r, prov);
      const j = await r.json(), cand = j.candidates && j.candidates[0];
      if (!cand) throw new Error("Gemini no ha devuelto respuesta" + (j.promptFeedback && j.promptFeedback.blockReason ? " (" + j.promptFeedback.blockReason + ")." : "."));
      if (cand.finishReason === "MAX_TOKENS") throw new Error("La respuesta era demasiado larga y se ha cortado.");
      return ((cand.content && cand.content.parts) || []).map(p => p.text || "").join("");
    } catch (e) {
      if (e instanceof TypeError) { const er = new Error("No se ha podido conectar con " + PROV[prov].t + ". ¿Hay internet?"); er.offline = true; throw er; }
      throw e;
    }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // busy servers (like Gemini's "high demand" 503) are tried again a few times, waiting longer each time
  async function callAI(text, wantJSON, onWait, files, opt) {
    opt = opt || {};
    const waits = opt.waits || [10, 30, 60], stopped = () => opt.signal && opt.signal.aborted;
    for (let a = 0; ; a++) {
      if (stopped()) throw abortErr();
      try { return await callOnce(text, wantJSON, files, opt); }
      catch (e) { if (stopped()) throw abortErr(); if (!e.retry || a >= waits.length) throw e; const w = e.wait || waits[a]; if (onWait) onWait(w, e); await sleep(w * 1000); if (onWait) onWait(0, null); }
    }
  }
  const abortErr = () => { const e = new Error("Cancelado."); e.aborted = true; return e; };
  /* one call that doesn't get stuck: if the model is saturated, one short retry and then another model of the SAME AI
     (never another AI). The default model in Configuración doesn't change. o: {onWait, onSwitch(model), files, signal} */
  async function callSmart(text, wantJSON, o) {
    o = o || {};
    const c = cfg(), prov = c.prov, tried = [c.models[prov]]; let model = c.models[prov];
    for (let round = 0; round < 4; round++) {
      try { return await callAI(text, wantJSON, o.onWait, o.files, {model, signal: o.signal, waits: [8]}); }
      catch (e) {
        if (e.aborted || (o.signal && o.signal.aborted)) throw abortErr();
        if (!e.retry) throw e;
        const next = await nextModel(tried).catch(() => null);
        if (!next) throw e;
        tried.push(next); if (o.onSwitch) o.onSwitch(next, model); model = next;
      }
    }
    throw new Error("Tu IA está saturada ahora mismo. Prueba en unos minutos o hazlo con tu chat de IA.");
  }
  const modelNow = () => { const c = cfg(); return c.prov && c.models ? c.models[c.prov] || "" : ""; };

  /* ---------- the queue: saved on this device, so it survives moving between pages ---------- */
  const QK = () => "clarea-aiq/" + (window.PJ6USER || "_");
  // the project of the queue was deleted (here or on another device): the queue goes with it
  const gone = q => { const l = lget("clarea-projs"); return !!(q && l && Array.isArray(l.list) && !l.list.some(x => x.id === q.pid)); };
  /* the queue lives on the device that runs it; a copy goes with the account ("clarea-aiqs"), so every device sees it.
     In the cloud any device can collect it; run here, the others only show it. */
  const DEV = (() => { try { let d = localStorage.getItem("clarea-device"); if (!d) { d = Math.random().toString(36).slice(2, 10); localStorage.setItem("clarea-device", d); } return d; } catch (e) { return "x"; } })();
  const MK = () => U() + "clarea-aiqs";
  let lastMirror = null;
  function mirror(q) {
    try {
      const m = q ? Object.assign({}, q, {dev: q.dev || DEV, beat: undefined, wait: undefined, waitUntil: undefined, waitWhy: undefined, lastErr: undefined, remote: undefined}) : null;
      const sig = JSON.stringify(m); if (sig === lastMirror) return; lastMirror = sig;
      localStorage.setItem(MK(), JSON.stringify({t: Date.now(), q: m}));
    } catch (e) {}
  }
  const mirrorGet = () => { try { const x = JSON.parse(localStorage.getItem(MK())); return x && x.q; } catch (e) { return null; } };
  const qGet = () => {
    let q; try { q = JSON.parse(localStorage.getItem(QK())); } catch (e) { return null; }
    if (!q) {
      const m = mirrorGet();
      if (m && m.dev !== DEV && !gone(m)) {
        if (m.cloud && !m.finished) { q = Object.assign({}, m); try { localStorage.setItem(QK(), JSON.stringify(q)); } catch (e) {} }   // the cloud: collect it here too
        else return Object.assign({}, m, {remote: true});
      }
    }
    if (q && gone(q)) { try { localStorage.removeItem(QK()); } catch (e) {} mirror(null); return null; }
    return q;
  };
  const qSet = q => { try { if (q && q.remote) { mirror(q); return; } if (q) localStorage.setItem(QK(), JSON.stringify(q)); else localStorage.removeItem(QK()); } catch (e) {} mirror(q); };
  let runningHere = false, beatT = 0;
  /* the screen stays on while this page generates (if the phone locks itself, the generation pauses) */
  let wake = null;
  const wakeSupported = () => "wakeLock" in navigator;
  const wakeWanted = () => { try { const x = JSON.parse(localStorage.getItem(U() + "clarea-wake")); return x ? x.v !== false : localStorage.getItem("clarea-wake") !== "0"; } catch (e) { return true; } };
  async function wakeOn() {
    if (!wakeSupported() || !wakeWanted() || wake || document.visibilityState !== "visible") return;
    try { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => { wake = null; }); } catch (e) { wake = null; }
  }
  function wakeOff() { if (wake) { try { wake.release(); } catch (e) {} wake = null; } }
  function wakeSet(on) { try { localStorage.setItem(U() + "clarea-wake", JSON.stringify({t: Date.now(), v: !!on})); localStorage.removeItem("clarea-wake"); } catch (e) {} if (on && runningHere) wakeOn(); else if (!on) wakeOff(); }
  const fresh = q => q && q.beat && Date.now() - q.beat < 20000;
  const emit = () => { try { window.dispatchEvent(new CustomEvent("clarea-ai", {detail: qGet()})); } catch (e) {} paintPill(); };
  // is a generation going on (here or in another open page of Clarea)?
  const busy = () => { const q = qGet(); return !!(q && !q.finished && (q.cloud || q.remote || runningHere || fresh(q))); };
  function start(pid, ids) {
    const c = ctx(pid); if (!c) return;
    const all = buildJobs(c), todo = ids && ids.length ? ids : all.filter(j => !isDone(c, j)).map(j => j.id);
    if (!todo.length) return;
    askNotify();
    qSet({pid, name: c.P.name, subj: c.P.subj, ids: todo, all: todo.slice(), total: todo.length, ok: 0, err: {}, cur: null, wait: null, started: Date.now(), beat: 0});
    if (cloudOn()) cloudStart(); else run();
  }
  function stop() {
    const q = qGet(); if (q && q.remote) { q.stopReq = true; qSet(q); emit(); return; }
    if (q) { q.stop = true; if (q.cloud) { cloudCancel(q.cloud); q.finished = Date.now(); } qSet(q); }
    emit();
  }

  /* ---------- in the cloud: the Clarea server generates with Clarea closed, and this collects the results ---------- */
  const PUSHURL = () => ((window.CLAREA_PUSH || {}).url || "").replace(/\/$/, "");
  const cloudOn = () => cfg().cloud !== false && !!PUSHURL();          // on by default
  /* the same cloud job for anything (projects, exam questions): parts = [{id, text}] */
  async function cloudSubmit(o) {
    const cf = cfg(), prov = cf.prov;
    await toLite();
    let alts = []; try { const list = await listModels(prov, cf.keys[prov]); const now = cfg().models[prov];
      alts = list.filter(m => m !== now && /flash/.test(m) && !/(preview|exp|thinking|image|tts|live|audio|embedding|computer)/.test(m)).slice(0, 2); } catch (e) {}
    const k = window.clareaPushK ? await window.clareaPushK() : null;
    const r = await fetch(PUSHURL() + "/gen", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({prov, model: cfg().models[prov], alts, key: cf.keys[prov], k, title: o.title, url: o.url, parts: o.parts})});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 413 ? "Es demasiado grande para la nube." : "error " + r.status);
    return {id: j.id, s: j.secret, push: !!k, at: Date.now()};
  }
  // errors that come back from the cloud, in plain Spanish
  function errEs(m) {
    m = String(m || "");
    if (/API key not valid|API_KEY_INVALID|invalid x-api-key|Incorrect API key|No auth credentials|User not found/i.test(m)) return "Tu IA no reconoce la clave: revísala en Configuración.";
    if (/expired/i.test(m)) return "La clave ha caducado: pon una nueva en Configuración.";
    if (/quota|limit|per day|rate/i.test(m)) return "Se ha gastado el uso gratis de tu IA por ahora. Prueba más tarde o mañana.";
    if (/high demand|overloaded|unavailable|503/i.test(m)) return "Tu IA estaba saturada y no ha respondido.";
    if (/tardado demasiado|timeout/i.test(m)) return "Tu IA ha tardado demasiado en responder.";
    return m;
  }
  async function cloudFetch(cl, have) {
    const r = await fetch(PUSHURL() + "/gen/" + cl.id + "?s=" + encodeURIComponent(cl.s) + "&have=" + encodeURIComponent((have || []).join(",")));
    if (r.status === 404) return {gone: true};
    if (!r.ok) throw new Error("error " + r.status);
    return r.json();
  }
  async function cloudStart() {
    let q = qGet(); const c = ctx(q.pid), cf = cfg(), prov = cf.prov, jobs = buildJobs(c);
    try {
      await toLite();
      const parts = q.ids.map(id => { const j = jobs.find(x => x.id === id); return {id, text: prompt(c, j)}; });
      // other models of the SAME AI, in case the chosen one is saturated (never another AI)
      let alts = []; try { const list = await listModels(prov, cf.keys[prov]); const now = cfg().models[prov];
        alts = list.filter(m => m !== now && /flash/.test(m) && !/(preview|exp|thinking|image|tts|live|audio|embedding|computer)/.test(m)).slice(0, 2); } catch (e) {}
      const k = window.clareaPushK ? await window.clareaPushK() : null;
      const r = await fetch(PUSHURL() + "/gen", {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({prov, model: cfg().models[prov], alts, key: cf.keys[prov], k, title: q.name, url: "proyecto.html?id=" + encodeURIComponent(q.pid), parts})});
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.status === 413 ? "El proyecto es demasiado grande para generarlo en la nube." : "error " + r.status);
      q = qGet(); if (!q) return;
      q.cloud = {id: j.id, s: j.secret}; q.cloudAt = Date.now(); q.push = !!k; qSet(q); emit();
      if (window.clareaToast) window.clareaToast(k ? "Generando en la nube: ya puedes cerrar Clarea. Te avisaremos al terminar." : "Generando en la nube: puedes cerrar Clarea (activa los avisos para saber cuándo acaba).");
      cloudPoll();
    } catch (e) {
      // the server could not take it: it is done here, as always
      q = qGet(); if (q) { q.cloudFail = e.message || String(e); qSet(q); }
      if (window.clareaToast) window.clareaToast("No se ha podido generar en la nube; se hace aquí, con Clarea abierta.");
      run();
    }
  }
  function cloudCancel(cl) { try { fetch(PUSHURL() + "/gen/" + cl.id + "/cancel", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({s: cl.s})}); } catch (e) {} }
  let pollT = 0, polling = false;
  async function cloudPoll() {
    clearTimeout(pollT);
    let q = qGet(); if (!q || !q.cloud || q.finished || polling) return;
    polling = true;
    try {
      const c = ctx(q.pid); if (!c) return;
      const jobs = buildJobs(c), have = q.all.filter(id => { const j = jobs.find(x => x.id === id); return j && isDone(c, j); });
      const r = await fetch(PUSHURL() + "/gen/" + q.cloud.id + "?s=" + encodeURIComponent(q.cloud.s) + "&have=" + encodeURIComponent(have.join(",")));
      if (r.status === 404) { q = qGet(); q.fatal = "El trabajo en la nube ya no existe. Vuelve a generar lo que falta."; q.finished = Date.now(); qSet(q); emit(); return; }
      const g = await r.json();
      for (const x of g.parts) {
        const j = jobs.find(y => y.id === x.id); if (!j) continue;
        if (x.res) { try { applyResult(ctx(q.pid), j, parseJSON(x.res)); } catch (e) { q = qGet(); q.err[x.id] = "La respuesta de la IA no era válida: " + (e.message || e); qSet(q); } }
        else if (x.st === "err" || x.st === "stop") { q = qGet(); q.err[x.id] = errEs(x.err) || "No se ha podido generar."; qSet(q); }
      }
      q = qGet(); const c2 = ctx(q.pid), jobs2 = buildJobs(c2);
      q.ids = q.all.filter(id => { const j = jobs2.find(x => x.id === id); return j && !isDone(c2, j); });
      q.ok = q.total - q.ids.length; q.ids = q.ids.filter(id => !q.err[id]).concat(q.ids.filter(id => q.err[id]));
      const run_ = g.parts.find(x => x.st === "wait");
      q.cur = run_ ? run_.id : null; q.curTitle = run_ ? jobTitle(c2, jobs2.find(x => x.id === run_.id) || {kind: "gloss"}) : null;
      q.waitWhy = run_ && run_.err ? "En la nube: la IA no ha respondido bien, se reintentará" : null; q.wait = null;
      if (g.switched) q.switched = g.switched;
      if (g.fatal) q.fatal = g.fatal;
      if (g.done) { q.finished = Date.now(); qSet(q); cloudCancel(q.cloud); finishedNotice(q, true); }
      else qSet(q);
      if (typeof window.clareaRefresh === "function") try { window.clareaRefresh(); } catch (e) {}
      emit();
    } catch (e) { /* no internet: try again later */ }
    finally { polling = false; q = qGet(); if (q && q.cloud && !q.finished) pollT = setTimeout(cloudPoll, 20000); }
  }
  function dismiss() { try { localStorage.removeItem(QK()); } catch (e) {} mirror(null); emit(); }
  async function toLite() {
    const c = cfg(); if (c.liteMoved || c.prov !== "gemini" || !c.models || !/^gemini-[\d.]+-flash$/.test(c.models.gemini || "")) return;
    c.liteMoved = true;
    try { const list = await listModels("gemini", c.keys.gemini), lite = pickModel("gemini", list); if (/flash-lite/.test(lite)) c.models.gemini = lite; } catch (e) {}
    cfgSet(Object.assign(cfg(), {liteMoved: true, models: c.models}));
  }
  async function run() {
    if (runningHere) return;
    let q = qGet();
    if (!q || q.finished || q.stop || !ready()) return;
    if (q.remote) return;
    if (q.cloud) { cloudPoll(); return; }
    await toLite();
    if (fresh(q)) return;                     // another open page of Clarea is already doing it
    runningHere = true; wakeOn(); q.paused = null; q.beat = Date.now(); qSet(q); emit();
    clearInterval(beatT); beatT = setInterval(() => { const x = qGet(); if (x && !x.finished) { x.beat = Date.now(); qSet(x); } }, 5000);
    try {
      while (true) {
        q = qGet(); if (!q || q.stop) break;
        { const m = mirrorGet(); if (m && m.stopReq) { q.stop = true; qSet(q); break; } }     // stopped from another device
        const id = q.ids.find(i => !q.err[i]); if (!id) break;
        const c = ctx(q.pid); if (!c) { q.err[id] = "El proyecto ya no existe."; qSet(q); continue; }
        const job = buildJobs(c).find(j => j.id === id);
        if (!job) { q.ids = q.ids.filter(i => i !== id); qSet(q); continue; }
        q.cur = id; q.curTitle = jobTitle(c, job); q.wait = null; q.waitUntil = null; q.waitWhy = null; q.beat = Date.now(); qSet(q); emit();
        try {
          const text = await callAI(prompt(c, job), true, (s, er) => { const x = qGet(); if (x) { x.wait = s || null; x.waitUntil = s ? Date.now() + s * 1000 : null; x.waitWhy = er ? (er.why || "La IA no ha respondido bien") : null; x.lastErr = er ? (er.detail || er.message || "") : x.lastErr; x.beat = Date.now(); qSet(x); emit(); } });
          applyResult(ctx(q.pid), job, parseJSON(text));     // read again: something may have changed meanwhile
          q = qGet(); q.ids = q.ids.filter(i => i !== id); q.ok++; q.cur = null; q.wait = null; q.waitUntil = null; q.waitWhy = null; q.lastErr = null; qSet(q);
          if (typeof window.clareaRefresh === "function") try { window.clareaRefresh(); } catch (e) {}
        } catch (e) {
          q = qGet(); if (!q) break;          // the project was deleted meanwhile
          q.cur = null; q.wait = null;
          if (e.offline) { q.paused = "offline"; qSet(q); break; }      // carries on when internet comes back
          const busyAI = e.status === 503 || e.status === 529 || (e.status === 429 && !e.quotaKind) || /saturad|overloaded|high demand|muy solicitado/i.test((e.why || "") + " " + (e.detail || "") + " " + e.message);
          if (busyAI && (q.autoSw || 0) < 2) {
            const cf = cfg(), from = cf.models && cf.models[cf.prov];
            let next = null; try { next = await nextModel(((q.tried || []).concat([from]))); } catch (x) {}
            if (next) {
              cf.models[cf.prov] = next; cfgSet(cf);
              q = qGet(); if (!q) break;
              q.autoSw = (q.autoSw || 0) + 1; q.tried = (q.tried || []).concat([from]); q.switched = {from, to: next, at: Date.now()}; q.lastErr = null; qSet(q);
              const t = PROV[cf.prov].t + " estaba saturada", b = "Clarea ha cambiado de «" + from + "» a «" + next + "» para seguir generando «" + q.name + "».";
              if (window.clareaNotify) window.clareaNotify({kind: "info", title: t, body: b, url: "proyecto.html?id=" + encodeURIComponent(q.pid) + "&tab=ia"});
              if (window.clareaToast) window.clareaToast(t + ": sigo con «" + next + "».");
              emit(); continue;                                            // the same part, with the new model
            }
          }
          q.err[id] = e.message || String(e);
          if (e.quotaKind) { q.fatal = q.err[id]; q.fatalKind = e.quotaKind; delete q.err[id]; qSet(q); break; }    // the part is not wrong: it can be done with another model
          if (/clave|saldo/.test(q.err[id])) { q.fatal = q.err[id]; qSet(q); break; }
          qSet(q);
        }
        emit();
      }
    } finally {
      clearInterval(beatT); runningHere = false; wakeOff();
      q = qGet();
      if (q && !q.paused && (q.stop || q.fatal || !q.ids.some(i => !q.err[i]))) { q.finished = Date.now(); q.beat = 0; qSet(q); finishedNotice(q); }
      else if (q) { q.beat = 0; qSet(q); }
      emit();
    }
  }
  let resumeT = 0;
  function resume() {
    const q = qGet();
    if (!q || q.finished || q.stop) { paintPill(); return; }
    if (q.remote) { paintPill(); return; }
    if (q.cloud) { cloudPoll(); return; }
    // the page that was generating was just closed: its "still alive" mark fades in a few seconds, then this page takes over
    if (fresh(q) && !runningHere) { paintPill(); clearTimeout(resumeT); resumeT = setTimeout(resume, Math.max(1000, 21000 - (Date.now() - q.beat))); return; }
    run();
  }

  // «Gemini está saturada… reintento en 23 s» with the seconds left
  function waitText(q) {
    if (!q || !q.wait) return "";
    const left = q.waitUntil ? Math.max(0, Math.ceil((q.waitUntil - Date.now()) / 1000)) : q.wait;
    return (q.waitWhy || "La IA está saturada") + ": " + (left ? "vuelvo a intentarlo en " + left + " s" : "volviendo a intentarlo…");
  }
  // «Seguir con otro modelo»: the next «flash» model not tried yet, and the generation goes on where it stopped
  async function nextModel(tried) {
    const c = cfg(), prov = c.prov; if (prov !== "gemini" || !c.keys || !c.keys[prov]) return null;
    const list = await listModels(prov, c.keys[prov]);
    const ok = m => !tried.includes(m) && !/(preview|exp|thinking|image|tts|live|audio|embedding|computer)/.test(m);
    // «flash» models have free use: the full one first, then «lite», then anything else
    return list.find(m => ok(m) && /flash$/.test(m)) || list.find(m => ok(m) && /flash/.test(m)) || list.find(ok) || null;
  }
  async function switchModel(pid) {
    const c = cfg(), prov = c.prov; if (prov !== "gemini" || !c.keys || !c.keys[prov]) throw new Error("Cambia el modelo en la pestaña IA.");
    const q = qGet(), tried = ((q && q.tried) || []).concat([c.models[prov]]);
    const next = await nextModel(tried);
    if (!next) throw new Error("No quedan más modelos gratis de " + PROV[prov].t + " para probar hoy. Vuelve mañana.");
    c.models[prov] = next; cfgSet(c);
    const pidNow = pid || (q && q.pid);
    start(pidNow);
    const nq = qGet(); if (nq) { nq.tried = tried; qSet(nq); }
    return next;
  }
  /* ---------- «Pregúntale a tu IA»: a chat about a project or an exam question (kept with the account) ---------- */
  function projectContext(pid) {
    const c = ctx(pid); if (!c) return "";
    return intro(c) + "Te va a hacer preguntas sobre su código. " + summaries(c) + "Código:\n\n" + codeBundle(c, 60000);
  }
  const chatFmt = t => esc(t).replace(/```[a-z]*\n?([\s\S]*?)```/g, (m, x) => "<pre>" + x + "</pre>").replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/«(.+?)»/g, "<code>$1</code>").replace(/\n/g, "<br>");
  function openChat(o) {
    if (document.querySelector(".chatw")) return;
    const K = "clarea-chat-" + o.key, load_ = () => (lget(K) || {msgs: []}).msgs || [];
    let msgs = load_(), busyNow = false;
    // with the Clarea connector, the question can go to Claude (the student's account): it answers there, and the answer comes here too
    const TID = "c-" + String(o.key).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60);
    const viaClaude = () => mcpOn() && (cfg().chatVia === "claude" || (cfg().chatVia !== "gemini") || !ready());
    let pend = (lget(K) || {}).pending || null, pollT = 0;
    const w = document.createElement("div"); w.className = "chatw"; w.setAttribute("role", "dialog"); w.setAttribute("aria-modal", "true"); w.setAttribute("aria-label", "Pregúntale a tu IA");
    w.innerHTML = '<div class="chatp"><div class="chath"><div><b>Pregúntale a tu IA</b><small>' + esc(o.title) + '</small></div><button type="button" class="topx chatx" aria-label="Cerrar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>'
      + '<div class="chatvia" role="group" aria-label="Quién responde" hidden><span>Responde:</span><button type="button" data-via="claude">Claude</button><button type="button" data-via="gemini">Gemini</button></div>'
      + '<div class="chatm" aria-live="polite"></div><form class="chatf"><textarea rows="2" placeholder="' + esc(o.placeholder || "Pregunta lo que no entiendas…") + '" aria-label="Tu pregunta"></textarea><button class="btn" type="submit">Enviar</button></form></div>';
    const box = w.querySelector(".chatm"), form = w.querySelector("form"), ta = form.querySelector("textarea");
    const via = w.querySelector(".chatvia");
    const paintVia = () => { if (!via) return; via.hidden = !(mcpOn() && ready()); via.querySelectorAll("[data-via]").forEach(b => { const on = (b.dataset.via === "claude") === viaClaude(); b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); }); };
    const paint = () => {
      paintVia();
      box.innerHTML = (msgs.length ? "" : '<p class="chathint">' + esc(o.hint || "Pregunta lo que quieras: tu IA responde con este contenido delante.") + (ready() || mcpOn() ? "" : " <b>Primero conecta Claude o pon tu clave de Gemini en Mi cuenta → Configuración.</b>") + '</p>')
        + msgs.map(m => '<div class="chatb ' + (m.r === "u" ? "me" : "ai") + '">' + (m.r === "u" ? esc(m.t).replace(/\n/g, "<br>") : chatFmt(m.t)) + '</div>').join("")
        + (busyNow ? '<div class="chatb ai wait"><i></i><i></i><i></i></div>' : "")
        + (pend ? '<div class="chatb ai claude"><b>Pregunta enviada a Claude.</b> Pulsa enviar en Claude: te responde allí, y su respuesta aparecerá aquí también. <button type="button" class="chatreopen">Abrir Claude otra vez</button> <button type="button" class="chatnopend">Dejar de esperar</button></div>' : "")
        + (msgs.length ? '<button type="button" class="chatclear">Borrar la conversación</button>' : "");
      box.scrollTop = box.scrollHeight;
    };
    const save = () => lset(K, {t: Date.now(), msgs: msgs.slice(-40), pending: pend});
    // Claude's answer, when it saves it with clarea_guardar
    const poll = async () => {
      clearTimeout(pollT); if (!pend || !document.body.contains(w)) return;
      try {
        const st = await mcpCollect(pend.id, (p, data) => { const t = data && (data.texto || data.text || data.respuesta); if (t) msgs.push({r: "a", t: String(t).slice(0, 8000), by: "claude"}); });
        if (st.n || st.done || st.gone) { if (st.done) mcpDrop(pend.id); pend = null; save(); paint(); return; }
      } catch (e) {}
      pollT = setTimeout(poll, 4000);
    };
    const close = () => { w.classList.add("closing"); setTimeout(() => w.remove(), 160); };
    w.addEventListener("click", ev => {
      if (ev.target === w || ev.target.closest(".chatx")) close();
      else if (ev.target.closest(".chatclear")) { msgs = []; pend = null; save(); paint(); }
      else if (ev.target.closest(".chatreopen") && pend) mcpOpenClaude(pend.msg);
      else if (ev.target.closest(".chatnopend")) { if (pend) mcpDrop(pend.id); pend = null; save(); paint(); }
      else { const v = ev.target.closest("[data-via]"); if (v) { const c = cfg(); c.chatVia = v.dataset.via; cfgSet(c); paint(); } }
    });
    ta.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.shiftKey && !/Android|iPhone|iPad/.test(navigator.userAgent)) { ev.preventDefault(); form.requestSubmit(); } });
    form.addEventListener("submit", async ev => {
      ev.preventDefault(); const q = ta.value.trim(); if (!q || busyNow) return;
      if (viaClaude()) {
        const hist0 = msgs.slice(-8).map(m => (m.r === "u" ? "Estudiante: " : "Respuesta: ") + m.t).join("\n\n");
        const msg = q + "\n\n(Pregunta desde Clarea: lee su contexto con la herramienta clarea_leer, tarea «" + TID + "».)";
        await mcpGo("tu pregunta", () => {
          msgs.push({r: "u", t: q}); ta.value = ""; pend = {id: TID, msg, t: Date.now()}; save(); paint();
          mcpPush({id: TID, kind: "pregunta", title: "Pregunta: " + o.title,
            intro: "El estudiante te ha hecho una pregunta desde Clarea, sobre este contenido. Respóndele en el chat, en español, claro y breve, como un profesor que le ayuda a preparar el examen; con ejemplos del contenido cuando sirva. Después guarda tu respuesta con clarea_guardar (parte «respuesta», resultado {\"texto\": \"tu respuesta\"}) para que también la vea en Clarea.",
            parts: [{id: "respuesta", title: "Respuesta", instructions: "Pregunta: " + q + (hist0 ? "\n\nConversación anterior:\n" + hist0 : "")}], context: String(o.context || "").slice(0, 400000)})
            .then(poll, x => { pend = null; msgs.push({r: "a", t: "No se ha podido enviar a Claude: " + (x.message || x)}); save(); paint(); });
        }, msg);
        return;
      }
      if (!ready()) { welcome(); return; }
      msgs.push({r: "u", t: q}); ta.value = ""; busyNow = true; save(); paint();
      const hist = msgs.slice(-10).map(m => (m.r === "u" ? "Estudiante: " : "Tú: ") + m.t).join("\n\n");
      const text = o.context + "\n\n---\nResponde en español, claro y breve (como un profesor que ayuda a preparar el examen), con ejemplos del contenido de arriba cuando sirva. Pon el código entre ``` y los nombres de código entre « ».\n\nConversación:\n" + hist + "\n\nTú:";
      try { msgs.push({r: "a", t: String(await callAI(text, false)).trim()}); }
      catch (x) { msgs.push({r: "a", t: "No he podido responder: " + (errEs ? errEs(x.message || x) : (x.message || x))}); }
      busyNow = false; msgs = msgs.slice(-40); save(); paint();
    });
    document.body.appendChild(w); paint(); ta.focus(); if (pend) poll();
    if (!document.getElementById("chatviacss")) { const st = document.createElement("style"); st.id = "chatviacss";
      st.textContent = '.chatvia{display:flex;align-items:center;gap:6px;padding:0 14px 8px;font-size:13px;color:var(--muted)}.chatvia[hidden]{display:none}.chatvia button{font:inherit;font-size:13px;font-weight:700;color:var(--fg);background:var(--surface);border:1.5px solid var(--line);border-radius:999px;padding:5px 12px;cursor:pointer}.chatvia button.on{background:var(--accent);border-color:var(--accent);color:#fff}'
        + '.chatb.claude{border:1.5px dashed var(--accent)}.chatb.claude button{font:inherit;font-size:13px;font-weight:700;color:var(--accent-ink,var(--accent));background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;margin-right:8px}';
      document.head.appendChild(st); }
  }

  /* ---------- the two ways to use the AI: Gemini (free key, by itself) or the student's Claude account (connector) ---------- */
  function pickCss() {
    if (document.getElementById("aipickcss")) return;
    const st = document.createElement("style"); st.id = "aipickcss";
    st.textContent = '.aipick{display:grid;grid-template-columns:1fr;gap:10px}@media (min-width:620px){.aipick{grid-template-columns:1fr 1fr}}'
      + '.aipc{display:flex;flex-direction:column;gap:6px;background:var(--surface);border:1.5px solid var(--line);border-radius:14px;padding:14px}'
      + '.aipc b{font-size:15.5px}.aipc span{font-size:13.5px;line-height:1.45;color:var(--muted)}.aipc .qa{margin-top:4px}'
      + '.aipc em{align-self:flex-start;font-style:normal;font-size:11.5px;font-weight:800;letter-spacing:.02em;padding:2px 8px;border-radius:999px;background:var(--accent-soft,rgba(31,95,191,.12));color:var(--fg)}'
      + '.aimore{background:var(--surface);border:1px solid var(--line);border-radius:14px}'
      + '.aimore>summary{list-style:none;cursor:pointer;padding:12px 14px;display:flex;align-items:center;gap:10px}'
      + '.aimore>summary::-webkit-details-marker{display:none}'
      + '.aimore>summary>span{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}.aimore>summary b{font-size:14.5px}.aimore>summary small{font-size:12.5px;color:var(--muted)}'
      + '.aimore>summary::after{content:"";flex:none;width:8px;height:8px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(45deg);margin:-4px 4px 0 0}'
      + '.aimore[open]>summary::after{transform:rotate(-135deg);margin-top:4px}'
      + '.aimoreb{padding:0 12px 12px;display:flex;flex-direction:column;gap:12px}'
      + '.aiwel{position:fixed;inset:0;z-index:1000;background:rgba(10,14,24,.55);display:flex;align-items:flex-end;justify-content:center}'
      + '.aiwel>div{position:relative;background:var(--bg);color:var(--fg);width:100%;max-width:560px;max-height:92vh;overflow:auto;border-radius:20px 20px 0 0;padding:22px 16px calc(18px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:12px}'
      + '@media (min-width:620px){.aiwel{align-items:center}.aiwel>div{border-radius:20px}}'
      + '.aiwel h3{margin:0;padding-right:44px;font-size:19px}.aiwel p{margin:0;font-size:14px;line-height:1.45;color:var(--muted)}'
      + '.aiwel .topx{position:absolute;top:12px;right:12px}';
    document.head.appendChild(st);
  }
  // the two cards: shown in the ✦ IA tab while nothing is set up, and in the welcome
  function chooseHtml() {
    pickCss();
    return '<div class="aipick">'
      + '<div class="aipc"><em>Gratis</em><b>Gemini</b><span>Con una clave gratis de Google. Clarea lo prepara todo sola, en la nube: puedes cerrarla y te avisa.</span><div class="qa"><button type="button" class="btn" data-aipick="gemini">Usar Gemini</button></div></div>'
      + '<div class="aipc"><em>Tu cuenta</em><b>Claude</b><span>Con tu cuenta de Claude (gratis, Pro o Max), sin clave. Clarea abre Claude con el mensaje escrito y tú solo pulsas enviar.</span><div class="qa"><button type="button" class="btn" data-aipick="claude">Usar Claude</button></div></div>'
      + '</div>';
  }
  // «Otras formas»: copying and pasting into any chat, folded away
  function moreHtml(inner, open) {
    pickCss();
    return '<details class="aimore"' + (open ? ' open' : '') + '><summary><span><b>Otras formas</b><small>Copiar y pegar en tu chat de IA (ChatGPT, Claude, Gemini…)</small></span></summary><div class="aimoreb">' + inner + '</div></details>';
  }
  function goConfig() {
    const a = document.createElement("a"); a.href = "configuracion"; a.setAttribute("data-go", "#/configuracion");
    document.body.appendChild(a); a.click(); a.remove();
  }
  // the first time the AI is used with nothing set up: choose Gemini or Claude
  function welcome() {
    if (document.querySelector(".aiwel")) return;
    const c = cfg(); c.welcomed = true; cfgSet(c);
    const w = document.createElement("div"); w.className = "aiwel";
    w.innerHTML = '<div role="dialog" aria-modal="true" aria-labelledby="aiwelt"><button type="button" class="topx" data-aiwelx aria-label="Cerrar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'
      + '<h3 id="aiwelt">¿Con qué IA quieres estudiar?</h3><p>Elige una. Puedes cambiarlo cuando quieras en Configuración.</p>' + chooseHtml() + '</div>';
    const close = () => { document.removeEventListener("keydown", key); w.remove(); };
    const key = e => { if (e.key === "Escape") close(); };
    w.addEventListener("click", e => { if (e.target === w || e.target.closest("[data-aiwelx]")) close(); });
    document.addEventListener("keydown", key);
    document.body.appendChild(w);
    setTimeout(() => { const b = w.querySelector("[data-aipick]"); if (b) b.focus(); }, 30);
  }
  // nothing set up yet and never asked: show the welcome (once per account)
  function welcomeOnce() { if (!ready() && !mcpOn() && !cfg().welcomed) { welcome(); return true; } return false; }
  async function pick(k, btn) {
    const c = cfg(); c.pick = k; c.welcomed = true; cfgSet(c);
    if (k === "claude" && !mcpOn()) {
      btn.disabled = true; btn.textContent = "Conectando…";
      try { await mcpConnect(); }
      catch (x) { const d = cfg(); delete d.mcp; cfgSet(d); btn.disabled = false; btn.textContent = "Usar Claude"; if (window.clareaToast) window.clareaToast(x instanceof TypeError ? "No se ha podido conectar. ¿Hay internet?" : x.message); return; }
    }
    const wl = document.querySelector(".aiwel"); if (wl) wl.remove();
    goConfig();
  }
  document.addEventListener("click", e => { const b = e.target.closest("[data-aipick]"); if (b && !b.disabled) { e.preventDefault(); pick(b.dataset.aipick, b); } });

  /* ---------- notices ---------- */
  function askNotify() {
    try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch (e) {}
  }
  function systemNotify(title, body, url) {
    try {
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      const opts = {body, icon: "icon-192.png", badge: "icon-192.png", tag: "clarea-ai", data: {url}};
      if (navigator.serviceWorker && navigator.serviceWorker.ready) navigator.serviceWorker.ready.then(r => r.showNotification(title, opts)).catch(() => { try { new Notification(title, opts); } catch (e) {} });
      else new Notification(title, opts);
    } catch (e) {}
  }
  function finishedNotice(q, cloud) {
    const nErr = Object.keys(q.err).length, url = "proyecto.html?id=" + encodeURIComponent(q.pid);
    if (q.stop) return;
    const title = q.fatal ? "No se ha podido terminar" : nErr ? "Generado con avisos" : "✓ Proyecto generado";
    const body = q.fatal ? q.fatal : "«" + q.name + "» de " + q.subj + (nErr ? ": " + q.ok + " partes hechas y " + nErr + " con error." : " ya tiene sus explicaciones, glosario y exámenes.");
    if (!(cloud && q.push)) systemNotify(title, body, url);
    if (window.clareaNotify) window.clareaNotify({kind: q.fatal || (nErr && !q.ok) ? "bad" : nErr ? "warn" : "ok", title: title.replace(/^✓ /, ""), body, url});
    if (window.clareaToast) window.clareaToast(q.fatal ? "No se ha podido terminar «" + q.name + "»." : "«" + q.name + "» ya está generado.");
  }
  /* no floating bar: the account button shows that something is going on, and the details are in the menu, under «Tareas en segundo plano» */
  function paintPill() {
    const old = document.querySelector(".aipill"); if (old) old.remove();
    if (typeof window.clareaPaintBadge === "function") try { window.clareaPaintBadge(); } catch (e) {}
  }
  document.addEventListener("click", e => { if (e.target.closest("[data-aiseen]")) { const q = qGet(); if (q && q.finished) { q.seen = true; qSet(q); paintPill(); } } });
  // carry on when the app comes back, when internet returns, and after the user logs in
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && window.PJ6USER) { resume(); if (runningHere) wakeOn(); } });
  window.addEventListener("online", () => { if (window.PJ6USER) resume(); });
  window.addEventListener("storage", e => { if (e.key === QK()) paintPill(); });
  // (the home page may load this after the page is ready)
  const boot = () => setTimeout(() => { if (window.PJ6USER) resume(); }, 1200);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

  /* step by step: how to get a key for each AI (open by default while there is no key) */
  const KEYGUIDE = {
    gemini: {free: "Gratis, sin tarjeta.", steps: [
      'Abre <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> e inicia sesión con tu cuenta de Google (la de Gmail).',
      'Si es la primera vez, acepta las condiciones de Google AI Studio.',
      'Toca <b>«Crear clave de API»</b> (en inglés, <i>Create API key</i>). Si te pregunta por un proyecto, elige el que te propone o toca «Crear proyecto».',
      'Cuando aparezca la clave, toca el <b>botón de copiar</b> que hay a su lado. No la selecciones a mano: es muy fácil dejarse un trozo.',
      'Vuelve a Clarea, pégala en <b>«Clave de Gemini»</b> y toca <b>«Comprobar la clave»</b>.'],
      tips: ['Si Clarea dice que Google no reconoce la clave, normalmente es que se borró o no se copió entera: vuelve al paso 3 y crea otra.', 'Clarea usa el modelo «Flash-Lite», que tiene mucho más uso gratis (unas 500 peticiones al día) que «Flash» (unas 20). Si se acaba, espera a mañana o toca «Seguir con otro modelo».']}
  };
  function keyGuide(prov, hasKey){
    const g = KEYGUIDE[prov]; if (!g) return "";
    return '<details class="kguide"' + (hasKey ? '' : ' open') + '><summary>Cómo conseguir tu clave de ' + PROV[prov].t + ', paso a paso<small>' + g.free + '</small></summary>'
      + '<ol>' + g.steps.map(x => '<li><span>' + x + '</span></li>').join("") + '</ol>'
      + '<div class="kgtips"><b>Importante</b><ul><li>No compartas la clave ni la enseñes en capturas: quien la tenga puede usarla con tu cuenta.</li><li>Se guarda en tu cuenta: la tendrás en todos tus dispositivos.</li>' + g.tips.map(x => '<li>' + x + '</li>').join("") + '</ul></div></details>';
  }
  return {chooseHtml, moreHtml, welcome, welcomeOnce, KEYGUIDE, keyGuide, PROV, cfg, cfgSet, ready, ctx, buildJobs, jobTitle, jobWhat, status, prompt, parseJSON, applyResult,
          listModels, pickModel, callAI, callSmart, modelNow, mcpOn, mcpUrl, mcpConnect, mcpProgressHtml, mcpPaint, mcpDisconnect, mcpPush, mcpDrop, mcpCollect, mcpProjectTask, MCP_SAY, MCP_URL, mcpOpenClaude, mcpGo, jsonBlocks, promptAll, applyAll, openChat, projectContext, isDone, switchModel, nextModel, errEs, cloudOn, cloudSubmit, cloudFetch, cloudCancel, wakeSupported, wakeWanted, wakeSet, wakeOn: () => !!wake, intro, JSONONLY, waitText, start, stop, dismiss, resume, busy, queue: qGet, runningHere: () => runningHere};
})();

