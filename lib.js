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

  return {collect, folderEntries, zipEntries, parseRepo, repoInfo, githubEntries, gitHistory, ghMsg, langOf, ext, functionsOf, lineCount, MAX_TOTAL};
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
    claude: {t: "Claude", s: "Anthropic", url: "https://console.anthropic.com/settings/keys", note: "De pago por uso: unos céntimos por proyecto."},
    openai: {t: "ChatGPT", s: "OpenAI", url: "https://platform.openai.com/api-keys", note: "De pago por uso: unos céntimos por proyecto."},
    gemini: {t: "Gemini", s: "Google", url: "https://aistudio.google.com/apikey", note: "Tiene un uso gratuito con límites diarios."}
  };
  // only for testing on this computer: a local stand-in that answers like Gemini
  const GEMINI = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && (function () { try { return localStorage.getItem("clarea-dev-ai"); } catch (e) { return null; } })()) || "https://generativelanguage.googleapis.com";
  const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
  function cfg() { try { return JSON.parse(localStorage.getItem("clarea-ai")) || {}; } catch (e) { return {}; } }
  function cfgSet(c) { try { localStorage.setItem("clarea-ai", JSON.stringify(c)); } catch (e) {} }
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
      const n = CL.lineCount(c.CODE.files[p]);
      if (n > LIM) { flush(); for (let a = 1; a <= n; a += LIM) jobs.push({id: "code-" + (k++), kind: "code", parts: [{p, from: a, to: Math.min(n, a + LIM - 1)}]}); return; }
      if (curN + n > LIM) flush();
      cur.push({p, from: 1, to: n}); curN += n;
    });
    flush();
    jobs.push({id: "gloss", kind: "gloss"});
    ["facil", "media", "dificil"].forEach(d => jobs.push({id: "exam-" + d, kind: "exam", diff: d}));
    if (c.GIT) jobs.push({id: "git", kind: "git"});
    return jobs;
  }
  function jobTitle(c, j) {
    if (j.kind === "code") return j.parts.length === 1 ? (j.parts[0].from > 1 || j.parts[0].to < CL.lineCount(c.CODE.files[j.parts[0].p]) ? baseName(j.parts[0].p) + " (líneas " + j.parts[0].from + "–" + j.parts[0].to + ")" : baseName(j.parts[0].p)) : j.parts.length + " archivos: " + j.parts.slice(0, 3).map(x => baseName(x.p)).join(", ") + (j.parts.length > 3 ? "…" : "");
    return {gloss: "Glosario", git: "Ramas y pull requests"}[j.kind] || "Exámenes · " + DT[j.diff];
  }
  const jobWhat = j => j.kind === "code" ? "Qué hace cada archivo y cada línea" : j.kind === "gloss" ? "Conceptos con ejemplos de tu código" : j.kind === "git" ? "Para qué es cada rama y cada PR" : "20 preguntas de test y 6 escritas";
  // a code part is done when its lines are explained (whatever size the parts had when they were made)
  function isDone(c, j) {
    if (j.kind !== "code") return !!c.AID.done[j.id];
    return j.parts.every(x => { const F = c.AID.files[x.p], B = F && F.blocks; return !!(B && B.length && B.some(b => b.from <= x.from) && B.some(b => b.to >= x.to)); });
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
    if (j.kind === "gloss") return intro(c) + 'Haz un glosario de los conceptos de programación que aparecen en este proyecto y que el estudiante debe saber explicar (funciones del lenguaje, palabras clave, estructuras, APIs, formatos…). Entre 12 y 24 conceptos, de más a menos importante.\n\n' + JSONONLY + ' Forma exacta:\n{"glossary":[{"term":"nombre corto, por ejemplo fetch() o $_SESSION","cat":"lenguaje o tema: PHP, JavaScript, HTML, CSS, SQL, Java…","easy":"qué es, fácil, 1-2 frases","tech":"explicación técnica, 1-3 frases","code":"1 a 3 líneas copiadas tal cual del proyecto donde se usa","file":"ruta del archivo","line":12}]}\n\nEn español. Nombres de código entre « ».\n\n' + summaries(c) + 'Código:\n\n' + codeBundle(c, 90000);
    if (j.kind === "exam") return intro(c) + 'Escribe preguntas de examen de dificultad ' + DT[j.diff].toUpperCase() + ' sobre este proyecto: ' + DD[j.diff] + '\n\n' + JSONONLY + ' Forma exacta:\n{"questions":[{"type":"mc","q":"pregunta","options":["opción a","opción b","opción c","opción d"],"answer":0,"why":"por qué es la correcta, 1-2 frases","wrong":["por qué la a no es (vacío si es la correcta)","…b","…c","…d"],"file":"ruta","line":12},{"type":"written","q":"pregunta para responder en 2-5 frases","model":"respuesta modelo de 2-5 frases","keyTerms":["3 a 6 conceptos o nombres que una buena respuesta debe decir"],"wrong":["0 a 3 ideas falsas típicas"],"file":"ruta","line":12}]}\n\nReglas:\n- Exactamente 20 de tipo "mc" y 6 de tipo "written".\n- Tratan sobre ESTE código: qué hace una función, qué pasa si…, por qué se usa…, qué devuelve…, en qué archivo está….\n- En las de test solo una opción es correcta y las otras son creíbles; reparte la correcta entre a, b, c y d.\n- "answer" es la posición de la correcta: 0 = a, 1 = b, 2 = c, 3 = d.\n- "file" y "line" señalan dónde se ve la respuesta en el código.\n- En español. Nombres de código entre « ».\n\n' + summaries(c) + 'Código:\n\n' + codeBundle(c, 90000);
    const G = c.GIT;
    return intro(c) + 'Explícale el historial de Git del proyecto.\n\n' + JSONONLY + ' Forma exacta:\n{"summary":"cómo está organizado el trabajo en el repositorio, 2-3 frases","branches":{"NOMBRE DE LA RAMA":{"why":"para qué se creó, 1-2 frases","changed":"qué se cambió en ella, 1-2 frases"}},"prs":{"NÚMERO":{"what":"qué aporta este pull request, 1-2 frases"}}}\n\nEn español. Incluye todas las ramas y todos los pull requests.\n\nRama principal: ' + G.def + '\nRamas: ' + G.branches.join(", ") + '\n\nCommits (fecha · rama · mensaje):\n' + G.commits.map(x => x.d.slice(0, 10) + " · " + x.b + " · " + x.m).join("\n") + '\n\nPull requests:\n' + G.prs.map(p => "#" + p.n + " " + p.t + " (" + p.from + " → " + p.to + ", " + stLabel(p.st) + ")" + (p.body ? "\n  " + p.body.slice(0, 300).replace(/\n/g, " ") : "") + "\n  archivos: " + p.f.map(f => f[0]).join(", ")).join("\n");
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
      const G = (data && data.glossary || []).filter(g => g && g.term).map(g => ({term: String(g.term).slice(0, 60), cat: String(g.cat || "General").slice(0, 30), easy: String(g.easy || "").slice(0, 400), tech: String(g.tech || "").slice(0, 600), code: String(g.code || "").slice(0, 300), file: fix(g.file ? String(g.file) : ""), line: +g.line || 0}));
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
    if (prov === "claude") {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {headers: {"x-api-key": key, "anthropic-version": "2026-10-21", "anthropic-dangerous-direct-browser-access": "true"}});
      if (!r.ok) throw await apiErr(r, prov);
      const ids = ((await r.json()).data || []).map(m => m.id);
      return CLAUDE_MODELS.filter(m => ids.includes(m)).concat(ids.filter(m => !CLAUDE_MODELS.includes(m)));
    }
    if (prov === "openai") {
      const r = await fetch("https://api.openai.com/v1/models", {headers: {Authorization: "Bearer " + key}});
      if (!r.ok) throw await apiErr(r, prov);
      return ((await r.json()).data || []).map(m => m.id).filter(id => /^(gpt-|o\d|chatgpt)/.test(id) && !/(audio|realtime|image|tts|transcribe|search|embedding|instruct|moderation)/.test(id)).sort().reverse();
    }
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=" + encodeURIComponent(key));
    if (!r.ok) throw await apiErr(r, prov);
    return ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent") && /gemini/.test(m.name) && !/(image|tts|audio|embedding|live)/.test(m.name)).map(m => m.name.replace(/^models\//, "")).sort().reverse();
  }
  function pickModel(prov, list) {
    if (prov === "claude") return list.includes("claude-opus-5-5") ? "claude-opus-5-5" : list[0];
    if (prov === "openai") return list.find(m => /^gpt-\d+(\.\d+)?$/.test(m)) || list.find(m => /^gpt-/.test(m)) || list[0];
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
  async function callOnce(text, wantJSON) {
    const c = cfg(), prov = c.prov, key = c.keys[prov], model = c.models[prov];
    let r;
    try {
      if (prov === "claude") {
        const body = {model, max_tokens: 32000, stream: true, messages: [{role: "user", content: text}]};
        const h = {"content-type": "application/json", "x-api-key": key, "anthropic-version": "2026-10-21", "anthropic-dangerous-direct-browser-access": "true"};
        // if a safety check declines, the API retries on a fallback model by itself
        if (/^claude-(opus-5|sonnet-5-5|fable)/.test(model)) { body.fallbacks = "default"; h["anthropic-beta"] = "server-side-fallback-2026-07-01"; }
        r = await fetch("https://api.anthropic.com/v1/messages", {method: "POST", headers: h, body: JSON.stringify(body)});
        if (!r.ok) throw await apiErr(r, prov);
        // read the stream: text pieces come in "content_block_delta" events
        const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "", out = "", stop = "";
        for (;;) {
          const {done, value} = await rd.read(); if (done) break;
          buf += dec.decode(value, {stream: true});
          let i; while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
            if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") out += ev.delta.text;
            else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
            else if (ev.type === "error") { const er = new Error("Claude: " + ((ev.error && ev.error.message) || "error")); er.retry = /overloaded/i.test(JSON.stringify(ev.error || "")); throw er; }
          }
        }
        if (stop === "refusal") throw new Error("Claude no ha querido responder a esta parte.");
        if (stop === "max_tokens") throw new Error("La respuesta era demasiado larga y se ha cortado.");
        return out;
      }
      if (prov === "openai") {
        const body = {model, messages: [{role: "user", content: text}]}; if (wantJSON) body.response_format = {type: "json_object"};
        r = await fetch("https://api.openai.com/v1/chat/completions", {method: "POST", headers: {"Content-Type": "application/json", Authorization: "Bearer " + key}, body: JSON.stringify(body)});
        if (!r.ok) throw await apiErr(r, prov);
        const j = await r.json(), ch = j.choices && j.choices[0];
        if (ch && ch.finish_reason === "length") throw new Error("La respuesta era demasiado larga y se ha cortado.");
        return (ch && ch.message && ch.message.content) || "";
      }
      const body = {contents: [{role: "user", parts: [{text}]}]}; if (wantJSON) body.generationConfig = {responseMimeType: "application/json"};
      r = await fetch(GEMINI + "/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key), {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
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
  async function callAI(text, wantJSON, onWait) {
    const waits = [10, 30, 60];
    for (let a = 0; ; a++) {
      try { return await callOnce(text, wantJSON); }
      catch (e) { if (!e.retry || a >= waits.length) throw e; const w = e.wait || waits[a]; if (onWait) onWait(w, e); await sleep(w * 1000); if (onWait) onWait(0, null); }
    }
  }

  /* ---------- the queue: saved on this device, so it survives moving between pages ---------- */
  const QK = () => "clarea-aiq/" + (window.PJ6USER || "_");
  // the project of the queue was deleted (here or on another device): the queue goes with it
  const gone = q => { const l = lget("clarea-projs"); return !!(q && l && Array.isArray(l.list) && !l.list.some(x => x.id === q.pid)); };
  const qGet = () => { let q; try { q = JSON.parse(localStorage.getItem(QK())); } catch (e) { return null; } if (gone(q)) { try { localStorage.removeItem(QK()); } catch (e) {} return null; } return q; };
  const qSet = q => { try { if (q) localStorage.setItem(QK(), JSON.stringify(q)); else localStorage.removeItem(QK()); } catch (e) {} };
  let runningHere = false, beatT = 0;
  const fresh = q => q && q.beat && Date.now() - q.beat < 20000;
  const emit = () => { try { window.dispatchEvent(new CustomEvent("clarea-ai", {detail: qGet()})); } catch (e) {} paintPill(); };
  // is a generation going on (here or in another open page of Clarea)?
  const busy = () => { const q = qGet(); return !!(q && !q.finished && (runningHere || fresh(q))); };
  function start(pid, ids) {
    const c = ctx(pid); if (!c) return;
    const all = buildJobs(c), todo = ids && ids.length ? ids : all.filter(j => !isDone(c, j)).map(j => j.id);
    if (!todo.length) return;
    askNotify();
    qSet({pid, name: c.P.name, subj: c.P.subj, ids: todo, all: todo.slice(), total: todo.length, ok: 0, err: {}, cur: null, wait: null, started: Date.now(), beat: 0});
    run();
  }
  function stop() { const q = qGet(); if (q) { q.stop = true; qSet(q); } emit(); }
  function dismiss() { qSet(null); emit(); }
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
    await toLite();
    if (fresh(q)) return;                     // another open page of Clarea is already doing it
    runningHere = true; q.paused = null; q.beat = Date.now(); qSet(q); emit();
    clearInterval(beatT); beatT = setInterval(() => { const x = qGet(); if (x && !x.finished) { x.beat = Date.now(); qSet(x); } }, 5000);
    try {
      while (true) {
        q = qGet(); if (!q || q.stop) break;
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
          q.err[id] = e.message || String(e);
          if (e.quotaKind) { q.fatal = q.err[id]; q.fatalKind = e.quotaKind; delete q.err[id]; qSet(q); break; }    // the part is not wrong: it can be done with another model
          if (/clave|saldo/.test(q.err[id])) { q.fatal = q.err[id]; qSet(q); break; }
          qSet(q);
        }
        emit();
      }
    } finally {
      clearInterval(beatT); runningHere = false;
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
  async function switchModel(pid) {
    const c = cfg(), prov = c.prov; if (prov !== "gemini" || !c.keys || !c.keys[prov]) throw new Error("Cambia el modelo en la pestaña IA.");
    const q = qGet(), tried = ((q && q.tried) || []).concat([c.models[prov]]);
    const list = await listModels(prov, c.keys[prov]);
    const ok = m => !tried.includes(m) && !/(preview|exp|thinking|image|tts|live|audio|embedding|computer)/.test(m);
    const next = list.find(m => ok(m) && /flash$/.test(m)) || list.find(m => ok(m) && /flash/.test(m)) || list.find(ok);   // «flash» models have free use (the full one before «lite»)
    if (!next) throw new Error("No quedan más modelos gratis de Gemini para probar hoy. Vuelve mañana.");
    c.models[prov] = next; cfgSet(c);
    const pidNow = pid || (q && q.pid);
    start(pidNow);
    const nq = qGet(); if (nq) { nq.tried = tried; qSet(nq); }
    return next;
  }
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
  function finishedNotice(q) {
    const nErr = Object.keys(q.err).length, url = "proyecto.html?id=" + encodeURIComponent(q.pid);
    if (q.stop) return;
    const title = q.fatal ? "No se ha podido terminar" : nErr ? "Generado con avisos" : "✓ Proyecto generado";
    const body = q.fatal ? q.fatal : "«" + q.name + "» de " + q.subj + (nErr ? ": " + q.ok + " partes hechas y " + nErr + " con error." : " ya tiene sus explicaciones, glosario y exámenes.");
    systemNotify(title, body, url);
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
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && window.PJ6USER) resume(); });
  window.addEventListener("online", () => { if (window.PJ6USER) resume(); });
  window.addEventListener("storage", e => { if (e.key === QK()) paintPill(); });
  // (the home page may load this after the page is ready)
  const boot = () => setTimeout(() => { if (window.PJ6USER) resume(); }, 1200);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

  return {PROV, CLAUDE_MODELS, cfg, cfgSet, ready, ctx, buildJobs, jobTitle, jobWhat, status, prompt, parseJSON, applyResult,
          listModels, pickModel, callAI, isDone, switchModel, intro, JSONONLY, waitText, start, stop, dismiss, resume, busy, queue: qGet, runningHere: () => runningHere};
})();

