/* ══════════════════════════════════════════════════════════════
   자동 저장 · GitHub 비공개 저장소 동기화
   - 편집 즉시 기기(localStorage)에 저장
   - debounceMs 뒤 GitHub Contents API로 커밋 (sha 기반 낙관적 잠금)
   - 다른 기기에서 바뀐 경우: 내 변경이 없으면 받아오고, 있으면 충돌로 멈춰 사용자에게 묻는다
   외부 의존(fetch·저장소·시계·타이머)은 주입받는다 → 테스트 가능
   ══════════════════════════════════════════════════════════════ */

function createSync(opt){
  opt = opt || {};
  var fetchFn  = opt.fetch;
  var store    = opt.storage;
  var now      = opt.now || function(){ return Date.now(); };
  var setT     = opt.setTimeout || setTimeout;
  var clearT   = opt.clearTimeout || clearTimeout;
  var DEBOUNCE = opt.debounceMs == null ? 4000 : opt.debounceMs;
  function DEVNAME(){
    var d = typeof opt.deviceName === "function" ? opt.deviceName() : opt.deviceName;
    return String(d || "기기").slice(0, 40);
  }
  var onStatus   = opt.onStatus   || function(){};
  var onRemote   = opt.onRemote   || function(){};
  var onConflict = opt.onConflict || function(){};
  var flush      = opt.flush      || function(){};   // 화면에 입력만 되고 아직 저장 안 된 값을 먼저 저장시키는 훅

  var K_DOC = "nw.doc", K_CFG = "nw.sync";
  var API = "https://api.github.com";

  var st = { state: "local", message: "이 기기에만 저장 중", at: null };
  var timer = null, retryTimer = null, conflict = null;
  var chain = Promise.resolve();
  var storageOk = true;

  /* ── 저장소 안전 접근 ─────────────────────────── */
  function sget(k){ try{ return store ? store.getItem(k) : null; }catch(e){ storageOk = false; return null; } }
  function sset(k, v){ try{ if(store) store.setItem(k, v); return true; }catch(e){ storageOk = false; return false; } }
  function sdel(k){ try{ if(store) store.removeItem(k); }catch(e){} }

  function readDoc(){
    var raw = sget(K_DOC);
    if(!raw) return null;
    try{ var d = JSON.parse(raw); return (d && typeof d === "object" && "data" in d) ? d : null; }
    catch(e){ return null; }
  }
  var mem = readDoc() || { data: null, meta: { rev: 0, updatedAt: 0, baseSha: null, dirty: false, lastSyncAt: 0 } };
  function writeDoc(){ sset(K_DOC, JSON.stringify(mem)); }

  function readCfg(){
    try{ var c = JSON.parse(sget(K_CFG) || "null"); return c && c.token && c.owner && c.repo ? c : null; }
    catch(e){ return null; }
  }
  var cfg = readCfg();

  /* ── 상태 ─────────────────────────────────────── */
  function setStatus(state, message){
    st = { state: state, message: message || "", at: now() };
    try{ onStatus(st); }catch(e){}
  }
  function idleStatus(){
    if(!cfg) setStatus("local", storageOk ? "이 기기에만 저장 중 (동기화 미설정)" : "이 브라우저는 기기 저장을 막고 있습니다 — 파일로 백업하십시오");
    else if(mem.meta.dirty) setStatus("pending", "전송 대기");
    else setStatus("synced", "동기화 완료");
  }

  /* ── 인코딩 ───────────────────────────────────── */
  function b64enc(str){
    var bytes = new TextEncoder().encode(str), bin = "";
    for(var i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64dec(b64){
    var bin = atob(String(b64 || "").replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for(var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ── HTTP ─────────────────────────────────────── */
  function url(withPath){
    var base = API + "/repos/" + encodeURIComponent(cfg.owner) + "/" + encodeURIComponent(cfg.repo);
    if(!withPath) return base;
    var p = String(cfg.path || "data.json").split("/").map(encodeURIComponent).join("/");
    return base + "/contents/" + p;
  }
  function headers(){
    return { "Authorization": "Bearer " + cfg.token, "Accept": "application/vnd.github+json",
             "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" };
  }
  async function classify(res){
    var body = {};
    try{ body = await res.json(); }catch(e){}
    var msg = String((body && body.message) || "");
    var rem = res.headers && res.headers.get ? res.headers.get("x-ratelimit-remaining") : null;
    if(res.status === 401) return { kind: "auth",  retry: 0, msg: "토큰이 올바르지 않거나 만료됐습니다. 설정에서 토큰을 다시 입력하십시오." };
    if(res.status === 403 && (rem === "0" || /rate limit/i.test(msg)))
                           return { kind: "rate",  retry: 60000, msg: "GitHub 요청 한도 초과 — 1분 뒤 자동으로 다시 보냅니다." };
    if(res.status === 403) return { kind: "perm",  retry: 0, msg: "토큰에 이 저장소 쓰기 권한이 없습니다. Contents 권한을 Read and write로 발급하십시오." };
    if(res.status === 404) return { kind: "notfound", retry: 0, msg: "저장소를 찾을 수 없습니다. 저장소 이름과 토큰의 접근 저장소 범위를 확인하십시오." };
    if(res.status === 409 || (res.status === 422 && /sha/i.test(msg))) return { kind: "conflict", retry: 0, msg: "" };
    return { kind: "http", retry: 60000, msg: "동기화 오류 (HTTP " + res.status + ") — 1분 뒤 다시 시도합니다." };
  }
  function offline(){
    setStatus("offline", "오프라인 — 이 기기에 저장됨. 연결되면 자동 전송");
    scheduleRetry(30000);
  }
  function fail(e){
    setStatus("error", e.msg);
    if(e.retry) scheduleRetry(e.retry);
  }
  function scheduleRetry(ms){
    if(retryTimer) clearT(retryTimer);
    retryTimer = setT(function(){ retryTimer = null; return run(function(){ return mem.meta.dirty ? _push() : _pull(); }); }, ms);
  }

  /* 네트워크 작업은 한 번에 하나씩 */
  function run(fn){
    var call = function(){ return fn(); };        // 이전 작업 결과를 인자로 넘기지 않는다 (depth 오염 방지)
    var p = chain.then(call, call);
    chain = p.catch(function(){});
    return p;
  }

  function targetKey(){ return cfg ? [cfg.owner, cfg.repo, cfg.path || "data.json", cfg.branch || "main"].join("|") : null; }

  /* ── 로컬 ─────────────────────────────────────── */
  function loadLocal(){ return mem.data == null ? null : JSON.parse(JSON.stringify(mem.data)); }

  function saveLocal(data){
    var next = JSON.stringify(data);
    if(mem.data != null && JSON.stringify(mem.data) === next) return false;   // 내용 동일 → 변경 아님
    mem.data = JSON.parse(next);
    mem.meta.rev++; mem.meta.updatedAt = now(); mem.meta.dirty = true;
    writeDoc();
    if(cfg && st.state !== "conflict"){
      if(st.state !== "error" && st.state !== "offline") setStatus("pending", "전송 대기");
      if(timer) clearT(timer);
      timer = setT(function(){ timer = null; return run(_push); }, DEBOUNCE);
    }else if(!cfg) idleStatus();
    return true;
  }

  /* 새 기기의 기본 틀 — 기기에 데이터가 없을 때만 심고, 사용자 수정으로 치지 않는다.
     그래야 두 번째 기기를 연결할 때 원격 데이터를 충돌 없이 받는다. */
  function seedLocal(data){
    if(mem.data != null) return false;
    mem.data = JSON.parse(JSON.stringify(data));
    mem.meta.rev = 0; mem.meta.dirty = false; mem.meta.baseSha = null; mem.meta.updatedAt = 0;
    writeDoc();
    return true;
  }

  function adopt(data, sha){
    mem.data = data; mem.meta.baseSha = sha; mem.meta.dirty = false; mem.meta.target = targetKey();
    mem.meta.lastSyncAt = now(); mem.meta.updatedAt = now();
    writeDoc();
    conflict = null;
    setStatus("synced", "다른 기기의 최신본을 받았습니다");
    try{ onRemote(loadLocal()); }catch(e){}
    return { action: "adopted" };
  }

  /* ── 원격 ─────────────────────────────────────── */
  async function getRemote(){
    var res;
    try{ res = await fetchFn(url(true) + "?ref=" + encodeURIComponent(cfg.branch || "main"),
                             { method: "GET", headers: headers(), cache: "no-store" }); }
    catch(e){ return { net: true }; }
    if(res.status === 404) return { missing: true };
    if(!res.ok) return { err: await classify(res) };
    var body = await res.json();
    var payload;
    try{ payload = JSON.parse(b64dec(body.content)); }
    catch(e){ return { err: { kind: "bad", retry: 0, msg: "저장소의 데이터 파일이 손상됐습니다. 기기 데이터는 그대로 두었습니다." } }; }
    if(!payload || payload.app !== "networth" || !payload.data || typeof payload.data !== "object")
      return { err: { kind: "bad", retry: 0, msg: "저장소의 파일이 자산현황 형식이 아닙니다. 기기 데이터는 그대로 두었습니다." } };
    return { sha: body.sha, payload: payload };
  }

  async function repoCheck(){
    var res;
    try{ res = await fetchFn(url(false), { method: "GET", headers: headers(), cache: "no-store" }); }
    catch(e){ return { net: true }; }
    if(!res.ok) return { err: await classify(res) };
    return { ok: true };
  }

  async function putRemote(sha){
    var sentRev = mem.meta.rev;
    var payload = { app: "networth", schema: 2, savedAt: new Date(now()).toISOString(), device: DEVNAME(), data: mem.data };
    var body = { message: "자동 저장 · " + DEVNAME() + " · " + new Date(now()).toISOString().slice(0, 16).replace("T", " "),
                 content: b64enc(JSON.stringify(payload, null, 1)), branch: cfg.branch || "main" };
    if(sha) body.sha = sha;
    var res;
    try{ res = await fetchFn(url(true), { method: "PUT", headers: headers(), body: JSON.stringify(body) }); }
    catch(e){ return { net: true }; }
    if(!res.ok) return { err: await classify(res) };
    var out = await res.json();
    mem.meta.baseSha = out.content.sha;
    mem.meta.target = targetKey();
    mem.meta.lastSyncAt = now();
    if(mem.meta.rev === sentRev) mem.meta.dirty = false;      // 전송 중 새 편집이 있었으면 변경 유지
    writeDoc();
    return { ok: true, again: mem.meta.dirty };
  }

  var LOOP_MSG = { kind: "http", retry: 60000, msg: "저장소가 변경을 계속 거절합니다 — 1분 뒤 다시 시도합니다." };
  async function _push(depth){
    depth = depth || 0;
    if(!cfg || !mem.meta.dirty || mem.data == null || conflict) return { action: "none" };
    if(mem.meta.target && mem.meta.target !== targetKey()) return _pull(depth);   // 대상이 바뀌었으면 먼저 확인
    setStatus("syncing", "전송 중");
    var r = await putRemote(mem.meta.baseSha);
    if(r.net){ offline(); return { action: "offline" }; }
    if(r.err){
      if(r.err.kind === "conflict"){                           // 다른 기기가 먼저 바꿈 → 확인 (1회만)
        if(depth >= 1){ fail(LOOP_MSG); return { action: "error" }; }
        return _pull(depth + 1);
      }
      fail(r.err); return { action: "error" };
    }
    if(r.again){
      setStatus("pending", "전송 대기");
      if(timer) clearT(timer);
      timer = setT(function(){ timer = null; return run(_push); }, DEBOUNCE);
    }else setStatus("synced", "동기화 완료");
    return { action: "pushed" };
  }

  async function _pull(depth){
    depth = depth || 0;
    if(!cfg) return { action: "none" };
    setStatus("syncing", "확인 중");
    var r = await getRemote();
    try{ flush(); }catch(e){}                                   // 판단 직전, 화면의 미저장 입력을 먼저 저장
    if(mem.data != null && mem.meta.target && mem.meta.target !== targetKey()){
      // 마지막으로 맞춘 곳과 다른 저장소·경로 — 그쪽 파일로 조용히 덮지 않도록 현재 데이터를 '수정됨'으로 둔다
      mem.meta.dirty = true; mem.meta.baseSha = null; mem.meta.target = null; writeDoc();
    }
    if(r.net){ offline(); return { action: "offline" }; }
    if(r.err){ fail(r.err); return { action: "error" }; }
    if(r.missing){
      var rp = await repoCheck();                               // 404는 '파일 없음'과 '저장소 없음/권한 없음'이 같다
      if(rp.net){ offline(); return { action: "offline" }; }
      if(rp.err){ fail(rp.err); return { action: "error" }; }
      if(mem.data == null){ idleStatus(); return { action: "none" }; }
      mem.meta.dirty = true; mem.meta.baseSha = null; writeDoc();
      return _push(depth);
    }
    if(r.sha === mem.meta.baseSha){
      if(mem.meta.dirty){
        if(depth >= 1){ fail(LOOP_MSG); return { action: "error" }; }
        return _push(depth);
      }
      setStatus("synced", "동기화 완료");
      return { action: "none" };
    }
    if(!mem.meta.dirty || mem.data == null) return adopt(r.payload.data, r.sha);
    conflict = { remote: r.payload.data, remoteSha: r.sha,
                 remoteSavedAt: r.payload.savedAt || null, remoteDevice: r.payload.device || "" };
    setStatus("conflict", "다른 기기에서도 수정됨 — 어느 쪽을 남길지 선택하십시오");
    try{ onConflict(pendingConflict()); }catch(e){}
    return { action: "conflict" };
  }

  /* 충돌 정보는 열 때마다 현재 기기 내용으로 만든다 — '나중에' 이후 편집도 반영 */
  function pendingConflict(){
    if(!conflict) return null;
    var c = JSON.parse(JSON.stringify(conflict));
    c.local = loadLocal();
    return c;
  }

  async function _resolve(which){
    if(!conflict) return { action: "none" };
    var c = conflict;
    if(which === "theirs") return adopt(c.remote, c.remoteSha);
    conflict = null;
    mem.meta.baseSha = c.remoteSha; mem.meta.dirty = true; writeDoc();
    return _push();
  }

  async function _test(){
    if(!cfg) return { ok: false, message: "저장소와 토큰을 먼저 입력하십시오." };
    var res;
    try{ res = await fetchFn(url(false), { method: "GET", headers: headers(), cache: "no-store" }); }
    catch(e){ return { ok: false, message: "인터넷에 연결되어 있지 않습니다." }; }
    if(!res.ok){ var e = await classify(res); return { ok: false, message: e.msg }; }
    var b = {}; try{ b = await res.json(); }catch(x){}
    if(b && b.permissions && b.permissions.push === false)
      return { ok: false, message: "읽기만 가능한 토큰입니다. Contents 권한을 Read and write로 발급하십시오." };
    if(b && b.private === false)
      return { ok: true, warn: true, message: "연결됐지만 이 저장소는 공개(Public)입니다. 자산 데이터는 비공개 저장소에 두십시오." };
    return { ok: true, message: "연결 확인 — 비공개 저장소 " + cfg.owner + "/" + cfg.repo };
  }

  /* ── 공개 API ─────────────────────────────────── */
  function configure(c){
    var prevToken = cfg && cfg.token;
    cfg = { owner: String(c.owner || "").trim(), repo: String(c.repo || "").trim(),
            path: String(c.path || "data.json").trim() || "data.json",
            branch: String(c.branch || "main").trim() || "main", token: String(c.token || "").trim() };
    if(!cfg.token && prevToken) cfg.token = prevToken;          // 토큰 칸을 비우면 기존 토큰 유지
    if(!cfg.owner || !cfg.repo || !cfg.token){ cfg = null; idleStatus(); return false; }
    sset(K_CFG, JSON.stringify(cfg));
    conflict = null;
    idleStatus();
    return true;
  }
  function disconnect(){
    sdel(K_CFG); cfg = null; conflict = null;
    if(timer){ clearT(timer); timer = null; }
    if(retryTimer){ clearT(retryTimer); retryTimer = null; }
    idleStatus();
  }
  function publicConfig(){
    return cfg ? { owner: cfg.owner, repo: cfg.repo, path: cfg.path, branch: cfg.branch, hasToken: !!cfg.token }
               : { owner: "", repo: "", path: "data.json", branch: "main", hasToken: false };
  }

  idleStatus();

  var api = {
    loadLocal: loadLocal,
    saveLocal: saveLocal,
    seedLocal: seedLocal,
    configure: configure,
    disconnect: disconnect,
    isConfigured: function(){ return !!cfg; },
    publicConfig: publicConfig,
    status: function(){ return { state: st.state, message: st.message, at: st.at }; },
    meta: function(){ return JSON.parse(JSON.stringify(mem.meta)); },
    pull: function(){ return run(_pull); },
    pushNow: function(){ if(timer){ clearT(timer); timer = null; } return run(_push); },
    resolve: function(w){ return run(function(){ return _resolve(w); }); },
    testConnection: function(){ return run(_test); },
    onOnline: function(){ return run(function(){ return mem.meta.dirty ? _push() : _pull(); }); },
    pendingConflict: pendingConflict,
    _storage: store
  };
  return api;
}

if(typeof module !== "undefined") module.exports = { createSync: createSync };
