/* ══════════════════════════════════════════════════════════════
   자산현황 v2 — 화면 로직
   의존: engine.js · holdings.js · networth.js · sync.js (전역 함수)
   공개 저장소에 올라가는 코드이므로 개인 숫자를 넣지 않는다.
   ══════════════════════════════════════════════════════════════ */
var APP_VERSION = "2.0.0";

var LABEL = { mtong:"마이너스통장 상환", park:"비상자금 적립", loan:"신용대출 조기상환", invest:"투자 납입" };
var PRESET = { A:["mtong","park","loan","invest"], B:["park","mtong","loan","invest"],
               C:["mtong","park","invest","loan"], D:["invest","mtong","park","loan"] };
var PRESET_NAME = { A:"A안 · 마통 → 비상자금 → 대출 → 투자", B:"B안 · 비상자금 → 마통 → 대출 → 투자",
                    C:"C안 · 마통 → 비상자금 → 투자 → 대출", D:"D안 · 투자 최우선" };
var CAT_COLOR = { "현금성":"var(--c1)", "투자":"var(--c2)", "연금":"var(--c3)", "보증금":"var(--c4)",
                  "부동산":"var(--c5)", "실물":"var(--c6)", "기타자산":"var(--c7)" };
var BAND_COLOR = { "즉시":"var(--c1)", "단기":"var(--c2)", "중기":"var(--c6)", "제한":"var(--c3)", "비유동":"var(--c5)" };
var BAND_ORDER = ["즉시","단기","중기","제한","비유동"];
var GROUP_COLORS = ["var(--c2)","var(--c1)","var(--c3)","var(--c4)","var(--c5)","var(--c6)","var(--c7)","#5B6B2E","#9A3C72"];
var ASSET_KEYS = ASSET_CATS.map(function(c){ return c.k; });
var DEBT_KEYS  = DEBT_CATS.map(function(c){ return c.k; });

function currentYm(){ var n = new Date(); return n.getFullYear() + "-" + String(n.getMonth()+1).padStart(2,"0"); }
function currentYear(){ return new Date().getFullYear(); }

/* ── 기본 틀: 금액 전부 0, 개인 정보 없음 ── */
function SIM_BASE(){
  return { months:36, startYm:currentYm(), incomeM:0, expenseM:0, otherAssets:0,
           mtong:{ bal:0, limit:0, rate:0 }, loan:{ bal:0, rate:0, type:"원리금균등", termMonths:0 },
           park:{ bal:0, rate:0, tax:true, target:0 }, invest:{ bal:0, rate:0 },
           events:[], priority:["mtong","park","loan","invest"] };
}
function DEFAULT_DB(){
  return {
    schema:"networth", version:2, fx:0, monthlyExpense:0,
    assets:[
      { id:"a1", cat:"현금성", name:"파킹통장",           ccy:"KRW", amount:0 },
      { id:"a2", cat:"연금",   name:"연금저축",           ccy:"KRW", amount:0 },
      { id:"a3", cat:"보증금", name:"거주 보증금",        ccy:"KRW", amount:0 },
      { id:"a4", cat:"부동산", name:"보유 부동산 (시세)", ccy:"KRW", amount:0 },
      { id:"a5", cat:"실물",   name:"차량",               ccy:"KRW", amount:0 }
    ],
    debts:[
      { id:"d1", cat:"마이너스통장", name:"마이너스통장", ccy:"KRW", amount:0, rate:0, limit:0 },
      { id:"d2", cat:"신용대출",     name:"신용대출",     ccy:"KRW", amount:0, rate:0, term:0 },
      { id:"d3", cat:"임대보증금",   name:"임대보증금 (전세 준 경우)", ccy:"KRW", amount:0, rate:0, term:0 }
    ],
    holdings:[],
    tax:{ year: currentYear(), realized: 0 },
    snapshots:[],
    sim: SIM_BASE()
  };
}

/* ── 정규화 ─────────────────────────────────── */
function fnum(v, d){ var n = Number(v); return (v === "" || v === null || v === undefined || !isFinite(n)) ? (d === undefined ? 0 : d) : n; }
function isPlainObj(x){ return x && typeof x === "object" && !Array.isArray(x); }

function mergeSim(src){
  var base = SIM_BASE();
  if(!isPlainObj(src)) return base;
  Object.keys(base).forEach(function(k){
    var v = src[k];
    if(v === undefined || v === null) return;
    if(Array.isArray(base[k])){
      if(Array.isArray(v)) base[k] = v.filter(function(x){ return isPlainObj(x) || typeof x === "string"; });
    }else if(isPlainObj(base[k])){
      if(isPlainObj(v)) Object.keys(base[k]).forEach(function(k2){ if(v[k2] !== undefined && v[k2] !== null) base[k][k2] = v[k2]; });
    }else base[k] = v;
  });
  base.priority = base.priority.filter(function(k){ return LABEL[k]; })
                    .filter(function(k, i, a){ return a.indexOf(k) === i; });
  ["mtong","park","loan","invest"].forEach(function(k){ if(base.priority.indexOf(k) === -1) base.priority.push(k); });
  base.events = base.events.filter(isPlainObj).map(function(e){
    return { ym: String(e.ym || ""), amt: fnum(e.amt), memo: String(e.memo == null ? "" : e.memo),
             repeat: ["none","yearly","monthly"].indexOf(e.repeat) >= 0 ? e.repeat : "none" };
  });
  ["months","incomeM","expenseM","otherAssets"].forEach(function(k){ base[k] = fnum(base[k]); });
  if(!(base.months > 0)) base.months = 36;
  return base;
}

function cleanRows(list, keys, fallback){
  return (Array.isArray(list) ? list : []).filter(isPlainObj).map(function(x){
    var o = Object.assign({}, x);
    if(keys.indexOf(o.cat) === -1) o.cat = fallback;          // 미지 분류는 기타로 흡수 — 화면 누락 방지
    o.ccy = o.ccy === "USD" ? "USD" : "KRW";
    o.name = (o.name == null || o.name === "") ? "(이름 없음)" : String(o.name);
    o.amount = fnum(o.amount);
    if("rate" in o)  o.rate  = fnum(o.rate);
    if("limit" in o) o.limit = fnum(o.limit);
    if("term" in o)  o.term  = fnum(o.term);
    return o;
  });
}
function cleanHoldings(list){
  return (Array.isArray(list) ? list : []).filter(isPlainObj).map(function(h){
    return { id: h.id, ticker: String(h.ticker == null ? "" : h.ticker), group: String(h.group == null ? "" : h.group),
             shares: fnum(h.shares), price: fnum(h.price), avgUSD: fnum(h.avgUSD), costKRW: fnum(h.costKRW) };
  });
}
function uniqueIds(d){
  var seen = {}, seq = 0;
  [["a", d.assets], ["d", d.debts], ["h", d.holdings]].forEach(function(p){
    p[1].forEach(function(x){
      var ok = typeof x.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(x.id);   // 화면 속성에 들어가므로 형식 강제
      if(!ok || seen[x.id]){ do { seq++; x.id = p[0] + "_" + seq; } while(seen[x.id]); }
      seen[x.id] = 1;
    });
  });
}
function hydrate(o){
  if(isPlainObj(o) && o.app === "networth" && isPlainObj(o.data)) o = o.data;      // 동기화 파일 형식도 수용
  o = isPlainObj(o) ? o : {};
  var base = DEFAULT_DB();
  var d = {
    schema: "networth", version: 2,
    fx: fnum(o.fx), monthlyExpense: fnum(o.monthlyExpense),
    assets:   cleanRows(Array.isArray(o.assets) ? o.assets : base.assets, ASSET_KEYS, "기타자산"),
    debts:    cleanRows(Array.isArray(o.debts)  ? o.debts  : base.debts,  DEBT_KEYS,  "기타부채"),
    holdings: cleanHoldings(o.holdings),
    tax: { year: Math.round(fnum(o.tax && o.tax.year, currentYear())) || currentYear(),
           realized: fnum(o.tax && o.tax.realized) },
    snapshots: (Array.isArray(o.snapshots) ? o.snapshots : [])
      .filter(function(x){ return isPlainObj(x) && /^\d{4}-(0[1-9]|1[0-2])$/.test(String(x.ym || "")); })
      .map(function(x){ return { ym: String(x.ym), fx: fnum(x.fx), totalAssets: fnum(x.totalAssets), totalDebts: fnum(x.totalDebts),
                                 net: fnum(x.net), byCat: isPlainObj(x.byCat) ? x.byCat : {}, byDebt: isPlainObj(x.byDebt) ? x.byDebt : {} }; })
      .reduce(function(acc, x){ return upsertSnapshot(acc, x); }, []),
    sim: mergeSim(o.sim)
  };
  uniqueIds(d);
  return d;
}
function serialize(){
  return { schema:"networth", version:2, fx:DB.fx, monthlyExpense:DB.monthlyExpense,
           assets:DB.assets, debts:DB.debts, holdings:DB.holdings, tax:DB.tax,
           snapshots:DB.snapshots, sim:DB.sim };
}

/* ── 포맷 ─────────────────────────────────────── */
function won(v){
  v = Number(v) || 0;
  var neg = v < 0, n = Math.round(Math.abs(v));
  var eok = Math.floor(n / 10000), man = n % 10000;
  var s = eok ? (eok.toLocaleString("ko-KR") + "억" + (man ? " " + man.toLocaleString("ko-KR") : "")) : n.toLocaleString("ko-KR");
  return (neg && n ? "-" : "") + s;
}
function wonU(v){ return won(v) + "만원"; }
function sgn(v){ return (Math.round(v) > 0 ? "+" : "") + won(v); }
function man1(vWon){                         // 원 → 만원, 소수 1자리
  var m = (Number(vWon) || 0) / 10000, r = Math.round(m * 10) / 10;
  if(r === 0) r = 0;
  return r.toLocaleString("ko-KR", { minimumFractionDigits: 0, maximumFractionDigits: 1 });
}
function man1s(vWon){ var s = man1(vWon); return (Math.round((Number(vWon)||0)/1000) > 0 ? "+" : "") + s; }
function fwon(v){                            // 원 단위 표기
  var r = Math.round(Number(v) || 0);
  return (r < 0 ? "−" : "") + Math.abs(r).toLocaleString("ko-KR") + "원";
}
function fwons(v){ var r = Math.round(Number(v) || 0); return (r > 0 ? "+" : "") + fwon(r); }
function pct(v, d){ return (v == null || !isFinite(v)) ? "-" : v.toFixed(d === undefined ? 1 : d) + "%"; }
function ymKo(ym){ if(!ym) return "-"; var p = String(ym).split("-"); return p[0].slice(2) + "년 " + parseInt(p[1],10) + "월"; }
function monthsBetween(a,b){ return ymIndex(b) - ymIndex(a) + 1; }
function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function $(id){ return document.getElementById(id); }
function uid(p){
  var used = {};
  DB.assets.concat(DB.debts, DB.holdings).forEach(function(x){ used[x.id] = 1; });
  var id; do { id = p + Math.random().toString(36).slice(2,8); } while(used[id]);
  return id;
}
function toast(m){
  var t = $("toast"); t.textContent = m; t.classList.add("on");
  clearTimeout(t._h); t._h = setTimeout(function(){ t.classList.remove("on"); }, 2600);
}
function hhmm(ts){ var d = new Date(ts); return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0"); }
function dtKo(ts){ if(!ts) return "-"; var d = new Date(ts); if(isNaN(d)) return "-";
  return (d.getMonth()+1) + "/" + d.getDate() + " " + hhmm(d.getTime()); }

/* ══════════════════════════════════════════
   01 현황
   ══════════════════════════════════════════ */
var dirty = { p3:true, p4:true };
var CELLS = { conv:{}, sub:{}, total:{}, hold:null, holdn:null };

function optCat(cats, cur){ return cats.map(function(c){ return '<option' + (c.k===cur?' selected':'') + '>' + c.k + '</option>'; }).join(""); }
function amtLabel(ccy){ return ccy === "USD" ? "금액 (USD)" : "금액 (만원)"; }

function rowsFor(list, cats, kind){
  var fx = DB.fx, html = "", grand = 0, isD = (kind === "debts");
  var span = isD ? 5 : 3, cols = isD ? 8 : 6;
  var hm = isD ? 0 : holdingsManwon(DB.holdings, fx), hn = isD ? 0 : DB.holdings.length;

  cats.forEach(function(c){
    var items = list.filter(function(x){ return x.cat === c.k; });
    var withHold = !isD && c.k === "투자" && hn > 0;
    if(!items.length && !withHold) return;
    var sum = withHold ? hm : 0;
    var body = items.map(function(x){
      var v = toManwon(x.amount, x.ccy, fx); sum += v;
      var extra = "";
      if(isD){
        extra = '<td data-label="금리 (%)"><input class="cellin" type="number" inputmode="decimal" step="0.1" data-k="debts" data-id="' + esc(x.id) + '" data-f="rate" value="' + (x.rate||0) + '" aria-label="금리"></td>';
        if(c.k === "마이너스통장")
          extra += '<td data-label="한도 (만원)"><input class="cellin" type="number" inputmode="decimal" step="100" data-k="debts" data-id="' + esc(x.id) + '" data-f="limit" value="' + (x.limit||0) + '" aria-label="한도"></td>';
        else if(c.k === "신용대출" || c.k === "주택담보대출")
          extra += '<td data-label="잔여 (개월)"><input class="cellin" type="number" inputmode="numeric" step="1" data-k="debts" data-id="' + esc(x.id) + '" data-f="term" value="' + (x.term||0) + '" aria-label="잔여 개월"></td>';
        else extra += '<td></td>';
      }
      return '<tr>' +
        '<td class="c-name" data-label="항목"><input class="cellin txt" data-k="' + kind + '" data-id="' + esc(x.id) + '" data-f="name" value="' + esc(x.name) + '" aria-label="항목명"></td>' +
        '<td data-label="분류"><select class="cellin" data-k="' + kind + '" data-id="' + esc(x.id) + '" data-f="cat" aria-label="분류">' + optCat(cats, x.cat) + '</select></td>' +
        '<td data-label="통화"><select class="cellin" data-k="' + kind + '" data-id="' + esc(x.id) + '" data-f="ccy" aria-label="통화">' +
          '<option value="KRW"' + (x.ccy==="KRW"?" selected":"") + '>KRW (만원)</option>' +
          '<option value="USD"' + (x.ccy==="USD"?" selected":"") + '>USD</option></select></td>' +
        '<td data-label="' + amtLabel(x.ccy) + '"><input class="cellin" type="number" inputmode="decimal" step="any" data-k="' + kind + '" data-id="' + esc(x.id) + '" data-f="amount" value="' + x.amount + '" aria-label="금액"></td>' +
        extra +
        '<td class="c-out ' + (isD?"d":"a") + '" data-label="원화 환산 (만원)" data-conv="' + esc(x.id) + '">' + won(v) + '</td>' +
        '<td class="c-del"><button class="xbtn" data-del="' + kind + '" data-id="' + esc(x.id) + '" aria-label="' + esc(x.name) + ' 삭제">✕</button></td></tr>';
    }).join("");
    if(withHold){
      body += '<tr class="ro"><td class="c-name" colspan="' + (span + 1) + '">해외주식 <span data-holdn>' + hn + '</span>종목 ' +
              '<span class="note-s">· 주식 탭에서 편집</span></td>' +
              '<td class="c-out a" data-hold>' + won(hm) + '</td><td></td></tr>';
    }
    grand += sum;
    html += '<tr class="sub"><td>' + c.k + '</td><td colspan="' + span + '"></td>' +
            '<td data-subval="' + c.k + '">' + won(sum) + '</td><td></td></tr>' + body;
  });
  if(!html) html = '<tr><td colspan="' + cols + '" class="empty">항목이 없습니다. 위의 ＋ 버튼으로 추가하십시오.</td></tr>';
  html += '<tr class="tot"><td>' + (isD?"총부채":"총자산") + '</td><td colspan="' + span + '"></td>' +
          '<td class="' + (isD?"d":"a") + '" data-total="' + kind + '">' + won(grand) + '</td><td></td></tr>';
  var head = isD
    ? '<thead><tr><th>항목</th><th>분류</th><th>통화</th><th>입력 금액</th><th>금리 %</th><th>한도 · 잔여</th><th>원화 환산 (만원)</th><th></th></tr></thead>'
    : '<thead><tr><th>항목</th><th>분류</th><th>통화</th><th>입력 금액</th><th>원화 환산 (만원)</th><th></th></tr></thead>';
  return head + '<tbody>' + html + '</tbody>';
}

function buildCellCache(){
  CELLS = { conv:{}, sub:{}, total:{}, hold:null, holdn:null };
  ["tA","tD"].forEach(function(tid){
    var root = $(tid);
    root.querySelectorAll("[data-conv]").forEach(function(el){ CELLS.conv[el.getAttribute("data-conv")] = el; });
    root.querySelectorAll("[data-subval]").forEach(function(el){ CELLS.sub[tid + "|" + el.getAttribute("data-subval")] = el; });
    root.querySelectorAll("[data-total]").forEach(function(el){ CELLS.total[el.getAttribute("data-total")] = el; });
  });
  CELLS.hold = $("tA").querySelector("[data-hold]");
  CELLS.holdn = $("tA").querySelector("[data-holdn]");
}

function renderSheet(){
  var fixed = hydrate(serialize());                 // 어떤 경로로 바뀌었든 렌더 직전 정규화
  DB.assets = fixed.assets; DB.debts = fixed.debts; DB.holdings = fixed.holdings;
  $("tA").innerHTML = rowsFor(DB.assets, ASSET_CATS, "assets");
  $("tD").innerHTML = rowsFor(DB.debts,  DEBT_CATS,  "debts");
  buildCellCache();
  renderKpi();
  dirty.p3 = dirty.p4 = true;
}

/* 값만 갱신 — 입력 중에는 이 경로. DOM을 갈아엎지 않아 포커스 유지 */
function refreshDerived(){
  var fx = DB.fx;
  [["assets", DB.assets, ASSET_CATS, "tA"], ["debts", DB.debts, DEBT_CATS, "tD"]].forEach(function(p){
    var kind = p[0], list = p[1], cats = p[2], tid = p[3], grand = 0, sums = {};
    list.forEach(function(x){
      var v = toManwon(x.amount, x.ccy, fx);
      sums[x.cat] = (sums[x.cat] || 0) + v; grand += v;
      var cell = CELLS.conv[x.id]; if(cell) cell.textContent = won(v);
    });
    if(kind === "assets" && DB.holdings.length){
      var hm = holdingsManwon(DB.holdings, fx);
      sums["투자"] = (sums["투자"] || 0) + hm; grand += hm;
      if(CELLS.hold) CELLS.hold.textContent = won(hm);
      if(CELLS.holdn) CELLS.holdn.textContent = DB.holdings.length;
    }
    cats.forEach(function(c){ var sc = CELLS.sub[tid + "|" + c.k]; if(sc) sc.textContent = won(sums[c.k] || 0); });
    var tc = CELLS.total[kind]; if(tc) tc.textContent = won(grand);
  });
  renderKpi();
  dirty.p3 = dirty.p4 = true;
}

function renderKpi(){
  var t = totals(DB), m = metrics(DB, DB.monthlyExpense);
  $("kNet").innerHTML = won(t.net) + '<small>만원</small>';
  $("kNet").className = "v " + (t.net < 0 ? "debt" : "mut");
  $("kNetS").textContent = ymKo(DB.asOf) + " 기준 · 환율 " + (DB.fx ? DB.fx.toLocaleString("ko-KR") + "원" : "미입력");
  $("kAst").innerHTML = won(t.totalAssets) + '<small>만원</small>';
  $("kAstS").textContent = "현금성 " + won(m.cash) + " · 투자 " + won(m.invest);
  $("kDbt").innerHTML = won(t.totalDebts) + '<small>만원</small>';
  var lease = t.debtByCat["임대보증금"] || 0;
  $("kDbtS").textContent = lease > 0 ? ("임대보증금 " + won(lease) + " 포함") : " ";
  $("kRatio").textContent = pct(m.debtRatio);
  $("kNetDebt").innerHTML = won(m.netDebt) + '<small>만원</small>';
  var liq = $("kLiq");
  liq.textContent = m.liquidMonths == null ? "-" : m.liquidMonths.toFixed(1) + "개월";
  liq.className = "v " + (m.liquidMonths == null ? "mut" : (m.liquidMonths < 3 ? "debt" : "asset"));
  $("kLiqS").textContent = m.liquidMonths == null ? "월 고정지출을 입력하십시오" : ("현금성 " + won(m.cash) + " ÷ 월 " + won(DB.monthlyExpense));
  $("kUsd").textContent = pct(m.usdShare);
  $("kUsdS").textContent = won(m.usdAmount) + "만원이 달러 자산";
  var needFx = !(DB.fx > 0) && (DB.holdings.length || DB.assets.some(function(x){ return x.ccy === "USD" && x.amount; }));
  $("fxWarn").style.display = needFx ? "block" : "none";
}

/* ══════════════════════════════════════════
   02 주식
   ══════════════════════════════════════════ */
var HC = {};      // 종목 파생 셀 캐시: id → { field: el }

function renderHoldings(){
  var groupsSeen = {};
  DB.holdings.forEach(function(h){ if(h.group) groupsSeen[h.group] = 1; });
  var dl = '<datalist id="grpList">' + Object.keys(groupsSeen).map(function(g){ return '<option value="' + esc(g) + '">'; }).join("") + '</datalist>';
  var head = '<thead><tr><th>종목</th><th>그룹</th><th>수량</th><th>현재가 $</th><th>평단 $</th><th>원화 매입금액 (원)</th>' +
             '<th>평가 (만원)</th><th>원화손익 (만원)</th><th>수익률</th><th>주가 · 환율 효과 (만원)</th><th>비중</th><th>지금 팔면 세액</th><th></th></tr></thead>';
  var rows = DB.holdings.map(function(h){
    function inp(f, label, mode, step, cls){
      return '<td data-label="' + label + '"' + (cls ? ' class="' + cls + '"' : '') + '><input class="cellin' + (mode === "text" ? " txt" : "") + '" ' +
        (mode === "text" ? 'type="text" autocapitalize="characters" spellcheck="false"' : 'type="number" inputmode="decimal" step="' + step + '"') +
        (f === "group" ? ' list="grpList"' : '') +
        ' data-k="holdings" data-id="' + esc(h.id) + '" data-f="' + f + '" value="' + esc(h[f]) + '" aria-label="' + label + '"></td>';
    }
    function out(f, label, cls){ return '<td class="c-out' + (cls ? " " + cls : "") + '" data-label="' + label + '" data-hv="' + esc(h.id) + '|' + f + '"></td>'; }
    return '<tr data-hrow="' + esc(h.id) + '"' + (fnum(h.shares) > 0 ? '' : ' class="hz"') + '>' +
      inp("ticker", "종목", "text", "", "c-name") + inp("group", "그룹", "text", "", "c-grp") +
      inp("shares", "수량", "num", "any") + inp("price", "현재가 $", "num", "0.01") +
      inp("avgUSD", "평단 $ (선택)", "num", "0.01") + inp("costKRW", "원화 매입금액 (원)", "num", "1", "c-wide") +
      out("val", "평가 (만원)", "c-hide") + out("gain", "원화손익 (만원)", "c-hide") + out("pct", "수익률", "c-hide") +
      out("split", "주가 · 환율 효과 (만원)", "c-wide c-hide") + out("w", "비중", "c-hide") + out("mtax", "지금 팔면 세액", "c-tax c-hide") +
      '<td class="c-del"><button class="xbtn" data-del="holdings" data-id="' + esc(h.id) + '" aria-label="' + esc(h.ticker || "종목") + ' 삭제">✕</button></td></tr>';
  }).join("");
  if(!rows) rows = '<tr><td colspan="13" class="empty">종목이 없습니다. ＋ 종목으로 추가하십시오.</td></tr>';
  $("tH").innerHTML = head + '<tbody>' + rows + '</tbody>';
  if(!$("grpList")) document.body.insertAdjacentHTML("beforeend", dl);
  else $("grpList").outerHTML = dl;
  HC = {};
  $("tH").querySelectorAll("[data-hv]").forEach(function(el){
    var p = el.getAttribute("data-hv").split("|");
    (HC[p[0]] = HC[p[0]] || {})[p[1]] = el;
  });
  refreshHoldings();
}

function colorOf(el, v, invert){
  el.classList.remove("a", "d");
  var r = Math.round(v);
  if(r === 0) return;
  el.classList.add((invert ? r < 0 : r > 0) ? "a" : "d");
}

function refreshHoldings(){
  var fx = DB.fx, realized = DB.tax.realized;
  var w = weights(DB.holdings, fx), wm = {};
  w.items.forEach(function(x){ wm[x.id] = x; });
  var fxSum = 0, priceSum = 0, nDec = 0;
  DB.holdings.forEach(function(h){
    var c = HC[h.id]; if(!c) return;
    var row = c.val.parentNode; if(row) row.classList.toggle("hz", !(fnum(h.shares) > 0));
    var val = valueKRW(h, fx), g = gainKRW(h, fx), gp = gainPct(h, fx), d = decompose(h, fx);
    var mt = marginalTax(realized, g), wi = wm[h.id] || { pct:0, small:false };
    c.val.textContent = man1(val);
    c.gain.textContent = man1s(g); colorOf(c.gain, g / 1000);
    c.pct.textContent = gp == null ? "-" : (gp > 0 ? "+" : "") + gp.toFixed(1) + "%"; colorOf(c.pct, gp == null ? 0 : gp * 10);
    if(d){
      fxSum += d.fx; priceSum += d.price; nDec++;
      c.split.innerHTML = '주가 ' + man1s(d.price) + ' · 환율 ' + man1s(d.fx) +
        ((d.price > 0 && g < 0) ? '<span class="tag fxl">환율로 원화 손실</span>' : '');
    }else c.split.textContent = "평단 입력 시 표시";
    c.w.innerHTML = pct(wi.pct) + (wi.small ? '<span class="tag small">5%↓</span>' : '');
    c.mtax.textContent = Math.round(mt) === 0 ? "0원" : fwons(mt); colorOf(c.mtax, mt, true);
  });

  var s = summary(DB.holdings, fx);
  $("hVal").innerHTML = won(s.valueKRW / 10000) + '<small>만원</small>';
  $("hValS").textContent = DB.holdings.length + "종목 · 매입 " + won(s.costKRW / 10000) + "만원" + (fx ? " · 환율 " + fx.toLocaleString("ko-KR") : " · 환율 미입력");
  $("hGain").innerHTML = man1s(s.gainKRW) + '<small>만원</small>'; colorOf($("hGain"), s.gainKRW / 1000);
  $("hGainS").textContent = "이익 " + man1s(s.gainOnly) + " · 손실 " + man1(s.lossOnly) + " (만원)";
  $("hFx").innerHTML = nDec ? (man1s(fxSum) + '<small>만원</small>') : "-";
  if(nDec) colorOf($("hFx"), fxSum / 1000);
  $("hFxS").textContent = nDec ? ("주가 효과 " + man1s(priceSum) + "만원 · 평단 입력 " + nDec + "종목") : "평단(USD)을 넣은 종목만 계산";

  var b = budget(realized), all = taxOn(realized + s.gainKRW);
  $("taxYearLbl").textContent = DB.tax.year + "년";
  $("tUsed").textContent = pct(b.usedPct, 0);
  $("tRoom").textContent = fwon(b.room);
  $("tTax").textContent = fwon(b.tax); colorOf($("tTax"), b.tax, true);
  $("tAll").textContent = fwon(all) + (s.gainKRW ? " (보유 손익 " + man1s(s.gainKRW) + "만원 포함)" : "");
  var m = $("taxMeter"); m.firstElementChild.style.width = b.usedPct.toFixed(1) + "%"; m.classList.toggle("full", b.usedPct >= 100);

  var yn = $("yearNote"), cy = currentYear();
  if(DB.tax.year < cy){
    yn.style.display = "block";
    yn.innerHTML = "<b>" + DB.tax.year + "년 실현손익이 입력되어 있습니다.</b> " + cy + "년으로 넘어왔으면 올해 기준으로 초기화하십시오. (작년 금액은 5월 신고 때 증권사 자료로 확인)" +
                   '<div class="act"><button class="btn mini" id="bTaxReset">' + cy + '년으로 초기화</button></div>';
  }else yn.style.display = "none";

  var g = groups(DB.holdings, fx);
  $("barsG").innerHTML = g.length && s.valueKRW > 0 ? g.map(function(x, i){
    return '<div class="bar"><div class="bl"><b>' + esc(x.group) + '</b><span>' + man1(x.value) + '만원 · ' + x.pct.toFixed(1) + '%</span></div>' +
           '<div class="bt"><div class="bf" style="width:' + x.pct.toFixed(2) + '%;background:' + GROUP_COLORS[i % GROUP_COLORS.length] + '"></div></div></div>';
  }).join("") : '<div class="empty">종목에 그룹(예: 반도체, 지수, 금융)을 적으면 묶어서 비중을 보여줍니다.</div>';
}

/* ══════════════════════════════════════════
   03 분석
   ══════════════════════════════════════════ */
function barSet(el, pairs, total, colorMap){
  var max = Math.max.apply(null, pairs.map(function(p){ return p[1]; }).concat([1]));
  el.innerHTML = pairs.length ? pairs.map(function(p){
    var share = total > 0 ? p[1] / total * 100 : 0;
    return '<div class="bar"><div class="bl"><b>' + p[0] + '</b><span>' + won(p[1]) + '만원 · ' + share.toFixed(1) + '%</span></div>' +
      '<div class="bt"><div class="bf" style="width:' + (p[1]/max*100).toFixed(2) + '%;background:' + (colorMap[p[0]] || "var(--c7)") + '"></div></div></div>';
  }).join("") : '<div class="empty">항목이 없습니다.</div>';
}
function renderAnalysis(){
  var t = totals(DB), m = metrics(DB, DB.monthlyExpense);
  barSet($("barsA"), ASSET_CATS.map(function(c){ return [c.k, t.assetByCat[c.k]]; }).filter(function(p){ return p[1] > 0; }), t.totalAssets, CAT_COLOR);
  barSet($("barsD"), DEBT_CATS.map(function(c){ return [c.k, t.debtByCat[c.k]]; }).filter(function(p){ return p[1] > 0; }), t.totalDebts,
    { "마이너스통장":"var(--debt)", "신용대출":"#8E2F3C", "주택담보대출":"#C4626D", "임대보증금":"#D08C94", "기타부채":"var(--c7)" });
  var b = liquidityBands(DB), tot = t.totalAssets, st = $("stackL"), lg = $("stackLg");
  if(tot > 0){
    var ks = BAND_ORDER.filter(function(k){ return b[k] > 0; });
    st.innerHTML = ks.map(function(k){ return '<div style="width:' + (b[k]/tot*100).toFixed(3) + '%;background:' + BAND_COLOR[k] + '" title="' + k + '"></div>'; }).join("");
    lg.innerHTML = ks.map(function(k){ return '<span><i style="background:' + BAND_COLOR[k] + '"></i>' + k + ' ' + won(b[k]) + ' (' + (b[k]/tot*100).toFixed(1) + '%)</span>'; }).join("");
  }else{ st.innerHTML = ""; lg.innerHTML = '<span style="color:var(--ink-3)">자산 항목이 없습니다.</span>'; }
  var items = DB.assets.map(function(x){ return { n:x.name, v:toManwon(x.amount, x.ccy, DB.fx) }; })
    .concat(holdItems(DB).map(function(x){ return { n:x.name, v:x.v }; }))
    .filter(function(x){ return x.v > 0; }).sort(function(a,c){ return c.v - a.v; }).slice(0,5);
  var h = '<thead><tr><th>구분</th><th>금액 (만원)</th><th>총자산 대비</th></tr></thead><tbody>';
  h += '<tr class="sub"><td>통화 노출</td><td></td><td></td></tr>';
  h += '<tr><td>달러 자산</td><td>' + won(m.usdAmount) + '</td><td>' + pct(m.usdShare) + '</td></tr>';
  h += '<tr><td>원화 자산</td><td>' + won(t.totalAssets - m.usdAmount) + '</td><td>' + pct(t.totalAssets > 0 ? 100 - m.usdShare : 0) + '</td></tr>';
  h += '<tr class="sub"><td>상위 보유 항목</td><td></td><td></td></tr>';
  h += items.length ? items.map(function(x){ return '<tr><td>' + esc(x.n) + '</td><td>' + won(x.v) + '</td><td>' + pct(t.totalAssets > 0 ? x.v/t.totalAssets*100 : 0) + '</td></tr>'; }).join("")
                    : '<tr><td colspan="3" class="empty">항목 없음</td></tr>';
  h += '<tr class="sub"><td>성격별</td><td></td><td></td></tr>';
  h += '<tr><td>현금성 + 투자 (단기 동원 가능)</td><td>' + won(m.quickAssets) + '</td><td>' + pct(t.totalAssets > 0 ? m.quickAssets/t.totalAssets*100 : 0) + '</td></tr>';
  h += '<tr><td>실물자산</td><td>' + won(t.assetByCat["실물"]) + '</td><td>' + pct(m.realShare) + '</td></tr>';
  $("tConc").innerHTML = h + '</tbody>';
}

/* ══════════════════════════════════════════
   04 추이
   ══════════════════════════════════════════ */
function trendChart(list){
  var W = 940, H = 300, L = 66, R = 14, T = 16, B = 38, pw = W - L - R, ph = H - T - B, n = list.length;
  if(n === 0){ $("chartS").innerHTML = ""; return; }
  var vals = [0]; list.forEach(function(s){ vals.push(s.net, s.totalAssets, s.totalDebts); });
  var hi = Math.max.apply(null, vals), lo = Math.min.apply(null, vals);
  if(hi === lo){ hi += 1; lo -= 1; }
  var pad = (hi - lo) * 0.1; hi += pad; lo -= pad;
  function X(i){ return L + (n <= 1 ? pw/2 : pw * i / (n - 1)); }
  function Y(v){ return T + ph * (hi - v) / (hi - lo); }
  var s = "";
  for(var t = 0; t <= 4; t++){
    var v = lo + (hi - lo) * t / 4, y = Y(v);
    s += '<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W-R) + '" y2="' + y.toFixed(1) + '" stroke="#E8EBEE"/>';
    s += '<text x="' + (L-8) + '" y="' + (y+3.5).toFixed(1) + '" text-anchor="end" font-size="11" font-family="Consolas,monospace" fill="#6F7985">' + won(v) + '</text>';
  }
  if(lo < 0 && hi > 0) s += '<line x1="' + L + '" y1="' + Y(0).toFixed(1) + '" x2="' + (W-R) + '" y2="' + Y(0).toFixed(1) + '" stroke="#13171F" stroke-dasharray="3 3" opacity=".45"/>';
  function line(key, color, w, dash){
    var p = list.map(function(s2,i){ return (i?'L':'M') + X(i).toFixed(1) + ' ' + Y(s2[key]).toFixed(1); }).join(' ');
    return '<path d="' + p + '" fill="none" stroke="' + color + '" stroke-width="' + w + '" stroke-linejoin="round"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>';
  }
  s += line("totalAssets", "#6F7985", 1.6, "5 3") + line("totalDebts", "#B03A48", 1.8, "") + line("net", "#146B63", 2.8, "");
  list.forEach(function(s2,i){ s += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(s2.net).toFixed(1) + '" r="3.5" fill="#146B63"/>'; });
  var step = n <= 12 ? 1 : Math.ceil(n / 12);
  for(var i = 0; i < n; i += step)
    s += '<text x="' + X(i).toFixed(1) + '" y="' + (T+ph+17) + '" text-anchor="middle" font-size="11" font-family="Consolas,monospace" fill="#6F7985">' + list[i].ym.replace("-",".") + '</text>';
  $("chartS").innerHTML = s;
}
function renderTrend(){
  var L = DB.snapshots || [];
  $("sEmpty").style.display = L.length ? "none" : "block";
  $("sN").textContent = L.length + "개월";
  $("sRange").textContent = L.length ? (ymKo(L[0].ym) + " ~ " + ymKo(L[L.length-1].ym)) : " ";
  var df = snapshotDiff(L);
  function put(id, v, invert){
    var e = $(id);
    if(!df){ e.textContent = "-"; e.className = "v mut"; return; }
    e.textContent = sgn(v);
    e.className = "v " + (Math.abs(v) < 0.5 ? "mut" : ((invert ? v < 0 : v > 0) ? "asset" : "debt"));
  }
  put("sNet", df ? df.net : 0); put("sAst", df ? df.assets : 0); put("sDbt", df ? df.debts : 0, true);
  $("sNetS").textContent = df ? (ymKo(df.from) + " → " + ymKo(df.to) + (df.netPct != null ? " · " + (df.netPct>0?"+":"") + df.netPct.toFixed(1) + "%" : "")) : "기록 2개월 이상 필요";
  trendChart(L);
  var h = '<thead><tr><th>연월</th><th>총자산</th><th>총부채</th><th>순자산</th><th>전월 대비</th><th>환율</th><th></th></tr></thead><tbody>';
  if(L.length) L.forEach(function(s, i){
    var d = i > 0 ? s.net - L[i-1].net : null;
    h += '<tr><td>' + s.ym.replace("-",".") + '</td><td class="a">' + won(s.totalAssets) + '</td><td class="d">' + won(s.totalDebts) + '</td>' +
         '<td style="font-weight:700">' + won(s.net) + '</td><td class="' + (d==null?"":(d>=0?"a":"d")) + '">' + (d==null?"-":sgn(d)) + '</td>' +
         '<td>' + (s.fx ? Number(s.fx).toLocaleString("ko-KR") : "-") + '</td>' +
         '<td><button class="xbtn" data-snapdel="' + esc(s.ym) + '" aria-label="' + esc(s.ym) + ' 기록 삭제">✕</button></td></tr>';
  });
  else h += '<tr><td colspan="7" class="empty">기록이 없습니다.</td></tr>';
  $("tSnap").innerHTML = h + '</tbody>';
}

/* ══════════════════════════════════════════
   05 시뮬레이터
   ══════════════════════════════════════════ */
var MAP = [
  ["incomeM","incomeM","n"],["expenseM","expenseM","n"],["otherAssets","otherAssets","n"],["months","months","n"],["startYm","startYm","s"],
  ["mtBal","mtong.bal","n"],["mtLimit","mtong.limit","n"],["mtRate","mtong.rate","n"],
  ["lnBal","loan.bal","n"],["lnRate","loan.rate","n"],["lnType","loan.type","s"],["lnTerm","loan.termMonths","n"],
  ["pkBal","park.bal","n"],["pkTarget","park.target","n"],["pkRate","park.rate","n"],["pkTax","park.tax","b"],
  ["ivBal","invest.bal","n"],["ivRate","invest.rate","n"]
];
function getPath(o,p){ return p.split(".").reduce(function(a,k){ return a[k]; }, o); }
function setPath(o,p,v){ var ks=p.split("."), last=ks.pop(); ks.reduce(function(a,k){ return a[k]; },o)[last]=v; }
function fillSim(){
  MAP.forEach(function(m){ var el = $(m[0]), v = getPath(DB.sim, m[1]); if(m[2]==="b") el.checked = !!v; else el.value = v; });
  renderPrio(); renderEvents();
}
function readSim(){
  MAP.forEach(function(m){
    var el = $(m[0]);
    if(m[2]==="b") setPath(DB.sim, m[1], el.checked);
    else if(m[2]==="n") setPath(DB.sim, m[1], fnum(el.value));
    else setPath(DB.sim, m[1], el.value);
  });
}
function renderPrio(){
  $("prio").innerHTML = DB.sim.priority.map(function(k,i){
    return '<li><span class="pn">' + LABEL[k] + '</span><span class="pb">' +
      '<button class="btn mini" data-mv="up" data-i="' + i + '"' + (i===0?' disabled':'') + ' aria-label="위로">↑</button>' +
      '<button class="btn mini" data-mv="dn" data-i="' + i + '"' + (i===DB.sim.priority.length-1?' disabled':'') + ' aria-label="아래로">↓</button></span></li>';
  }).join("");
}
function renderEvents(){
  $("events").innerHTML = DB.sim.events.length ? DB.sim.events.map(function(e,i){
    return '<div class="evt"><div class="r1"><input type="text" data-ev="memo" data-i="' + i + '" value="' + esc(e.memo) + '" placeholder="항목명" aria-label="항목명">' +
      '<input type="number" inputmode="decimal" data-ev="amt" data-i="' + i + '" value="' + e.amt + '" step="10" aria-label="금액(만원)"></div>' +
      '<div class="r2"><input type="month" data-ev="ym" data-i="' + i + '" value="' + esc(e.ym) + '" aria-label="연월">' +
      '<select data-ev="repeat" data-i="' + i + '" aria-label="반복">' +
        '<option value="none"' + (e.repeat==="none"?" selected":"") + '>1회만</option><option value="yearly"' + (e.repeat==="yearly"?" selected":"") + '>매년 반복</option>' +
        '<option value="monthly"' + (e.repeat==="monthly"?" selected":"") + '>매월 반복</option></select>' +
      '<button class="btn mini" data-evdel="' + i + '" aria-label="삭제">✕</button></div></div>';
  }).join("") : '<div class="empty" style="padding:10px">연차수당·상여금처럼 정해진 목돈을 넣으면 반영됩니다.</div>';
}
function simChart(res){
  var W=940,H=320,L=62,R=14,T=16,B=40, rows=res.rows, n=rows.length, pw=W-L-R, ph=H-T-B;
  var vals=[0]; rows.forEach(function(r){ vals.push(r.debt, r.net); });
  var hi=Math.max.apply(null,vals), lo=Math.min.apply(null,vals);
  if(hi===lo){ hi+=1; lo-=1; }
  var pad=(hi-lo)*0.08; hi+=pad; lo-=pad;
  function X(i){ return L+(n<=1?pw/2:pw*i/(n-1)); }
  function Y(v){ return T+ph*(hi-v)/(hi-lo); }
  var s="";
  for(var t=0;t<=5;t++){ var v=lo+(hi-lo)*t/5, y=Y(v);
    s+='<line x1="'+L+'" y1="'+y.toFixed(1)+'" x2="'+(W-R)+'" y2="'+y.toFixed(1)+'" stroke="#E8EBEE"/>';
    s+='<text x="'+(L-8)+'" y="'+(y+3.5).toFixed(1)+'" text-anchor="end" font-size="11" font-family="Consolas,monospace" fill="#6F7985">'+won(v)+'</text>'; }
  if(lo<0&&hi>0) s+='<line x1="'+L+'" y1="'+Y(0).toFixed(1)+'" x2="'+(W-R)+'" y2="'+Y(0).toFixed(1)+'" stroke="#13171F" stroke-dasharray="3 3" opacity=".45"/>';
  var base=Y(Math.max(lo,0));
  var dp=rows.map(function(r,i){ return (i?'L':'M')+X(i).toFixed(1)+' '+Y(r.debt).toFixed(1); }).join(' ');
  s+='<path d="'+dp+' L'+X(n-1).toFixed(1)+' '+base.toFixed(1)+' L'+X(0).toFixed(1)+' '+base.toFixed(1)+' Z" fill="#B03A48" opacity=".10"/>';
  s+='<path d="'+dp+'" fill="none" stroke="#B03A48" stroke-width="2.2" stroke-linejoin="round"/>';
  var np=rows.map(function(r,i){ return (i?'L':'M')+X(i).toFixed(1)+' '+Y(r.net).toFixed(1); }).join(' ');
  s+='<path d="'+np+'" fill="none" stroke="#146B63" stroke-width="2.2" stroke-linejoin="round"/>';
  rows.forEach(function(r,i){ if(r.inflow>0){
    s+='<line x1="'+X(i).toFixed(1)+'" y1="'+T+'" x2="'+X(i).toFixed(1)+'" y2="'+(T+ph)+'" stroke="#3E4CB8" stroke-width="1" opacity=".28"/>';
    s+='<circle cx="'+X(i).toFixed(1)+'" cy="'+Y(r.debt).toFixed(1)+'" r="3.2" fill="#3E4CB8"/>'; } });
  var zi=-1; for(var i=0;i<n;i++){ if(rows[i].debt<0.005){ zi=i; break; } }
  if(zi>=0 && (res.rows[0].debt > 0.005 || zi > 0)){
    s+='<line x1="'+X(zi).toFixed(1)+'" y1="'+T+'" x2="'+X(zi).toFixed(1)+'" y2="'+(T+ph)+'" stroke="#146B63" stroke-width="1.5" stroke-dasharray="4 3"/>';
    var tx=Math.min(X(zi)+6, W-R-100);
    s+='<rect x="'+tx.toFixed(1)+'" y="'+(T+4)+'" width="96" height="18" rx="3" fill="#146B63"/>';
    s+='<text x="'+(tx+48).toFixed(1)+'" y="'+(T+17)+'" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">부채 0 · '+ymKo(rows[zi].ym)+'</text>';
  }
  var step=n<=14?2:(n<=40?6:12);
  for(var j=0;j<n;j+=step) s+='<text x="'+X(j).toFixed(1)+'" y="'+(T+ph+17)+'" text-anchor="middle" font-size="11" font-family="Consolas,monospace" fill="#6F7985">'+rows[j].ym.replace("-",".")+'</text>';
  $("chart").innerHTML=s;
}
function setKpi(id,sid,val,sub,cls){ var e=$(id); e.textContent=val; e.className="v "+(cls||"mut"); $(sid).innerHTML=sub||"&nbsp;"; }
function endRow(name,a,b,isDebt){
  var d=b-a;
  return '<tr><td>'+name+'</td><td>'+won(a)+'</td><td class="'+(isDebt?"d":"a")+'">'+won(b)+'</td><td class="'+(d>0?(isDebt?"d":"a"):(isDebt?"a":"d"))+'">'+sgn(d)+'</td></tr>';
}
function renderSim(){
  readSim();
  var cfg = DB.sim, res = simulate(cfg), k = res.kpi;
  var sp = cfg.incomeM - cfg.expenseM, ds = $("dSurplus");
  ds.textContent = wonU(sp); ds.className = "v" + (sp < 0 ? " neg" : "");
  $("dPmt").textContent = cfg.loan.type === "원리금균등" ? wonU(res.basePmt) : wonU(cfg.loan.bal*cfg.loan.rate/100/12) + " (이자만)";
  var last = res.rows[res.rows.length-1];
  setKpi("kMt","kMtS", cfg.mtong.bal <= 0 ? "없음" : (k.mtClear?ymKo(k.mtClear):"기간 내 미완"),
    cfg.mtong.bal <= 0 ? "&nbsp;" : (k.mtClear?monthsBetween(cfg.startYm,k.mtClear)+"개월차":"잔액 "+wonU(last.mtong)), k.mtClear||cfg.mtong.bal<=0?"asset":"debt");
  setKpi("kLn","kLnS", cfg.loan.bal <= 0 ? "없음" : (k.lnClear?ymKo(k.lnClear):"기간 내 미완"),
    cfg.loan.bal <= 0 ? "&nbsp;" : (k.lnClear?monthsBetween(cfg.startYm,k.lnClear)+"개월차":"잔액 "+wonU(last.loan)), k.lnClear||cfg.loan.bal<=0?"asset":"debt");
  setKpi("kPk","kPkS", cfg.park.target<=0?"목표 없음":(k.pkHit?ymKo(k.pkHit):"기간 내 미달"), cfg.park.target>0?"목표 "+wonU(cfg.park.target):"&nbsp;", k.pkHit?"asset":"mut");
  setKpi("kInt","kIntS", won(k.totalInterest), "마통 "+won(k.intMt)+" · 신용 "+won(k.intLn)+" (만원)", "debt");
  simChart(res);
  var cur = cfg.priority.join(">");
  var h = '<thead><tr><th>배분 순서</th><th>마통 완제</th><th>대출 완제</th><th>비상자금</th><th>총 이자</th><th>기말 부채</th><th>기말 순자산</th></tr></thead><tbody>';
  Object.keys(PRESET).forEach(function(p){
    var r = simulate(Object.assign({}, cfg, { priority: PRESET[p] })), isCur = PRESET[p].join(">") === cur;
    h += '<tr' + (isCur?' class="cur"':'') + '><td>' + PRESET_NAME[p] + (isCur?'<span class="badge">현재</span>':'') + '</td>' +
      '<td>'+(cfg.mtong.bal<=0?"-":(r.kpi.mtClear?ymKo(r.kpi.mtClear):"미완"))+'</td><td>'+(cfg.loan.bal<=0?"-":(r.kpi.lnClear?ymKo(r.kpi.lnClear):"미완"))+'</td>' +
      '<td>'+(cfg.park.target<=0?"-":(r.kpi.pkHit?ymKo(r.kpi.pkHit):"미달"))+'</td>' +
      '<td class="d">'+won(r.kpi.totalInterest)+'</td><td class="d">'+won(r.kpi.endDebt)+'</td><td class="a">'+won(r.kpi.endNet)+'</td></tr>';
  });
  $("cmp").innerHTML = h + '</tbody>';
  var start = cfg.park.bal + cfg.invest.bal + cfg.otherAssets - cfg.mtong.bal - cfg.loan.bal;
  $("endt").innerHTML = '<thead><tr><th>항목</th><th>시작</th><th>'+ymKo(last.ym)+'</th><th>증감</th></tr></thead><tbody>' +
    endRow("마이너스통장", cfg.mtong.bal, last.mtong, true) + endRow("신용대출", cfg.loan.bal, last.loan, true) +
    endRow("파킹통장", cfg.park.bal, last.park, false) + endRow("투자 계좌", cfg.invest.bal, last.invest, false) +
    '<tr style="border-top:2px solid #13171F"><td style="font-weight:800">순자산</td><td>'+won(start)+'</td><td class="a" style="font-weight:800">'+won(last.net)+'</td><td class="a">'+sgn(last.net-start)+'</td></tr>' +
    '<tr><td>누적 목돈 유입</td><td>-</td><td>'+won(k.totalInflow)+'</td><td>-</td></tr></tbody>';
  var mh = '<thead><tr><th>연월</th><th>목돈</th><th>필수상환</th><th>마통</th><th>신용대출</th><th>파킹</th><th>투자</th><th>총부채</th><th>순자산</th></tr></thead><tbody>';
  res.rows.forEach(function(r){
    mh += '<tr'+(r.inflow>0?' class="evtrow"':'')+'><td>'+r.ym.replace("-",".")+'</td><td>'+(r.inflow?won(r.inflow):"")+'</td><td>'+won(r.due)+'</td>' +
      '<td class="d">'+won(r.mtong)+'</td><td class="d">'+won(r.loan)+'</td><td class="a">'+won(r.park)+'</td><td class="a">'+won(r.invest)+'</td>' +
      '<td class="d">'+won(r.debt)+'</td><td class="a">'+won(r.net)+'</td></tr>';
  });
  $("monthly").innerHTML = mh + '</tbody>';
  var w = [];
  if(res.warn.negative > 0) w.push("월 현금흐름이 <b>"+res.warn.negative+"개월</b> 적자입니다. 부족분은 마이너스통장으로 흡수되도록 계산했습니다.");
  if(res.warn.overLimit) w.push("<b>"+ymKo(res.warn.overLimit)+"</b>에 마이너스통장 한도를 초과합니다. 이후 계산은 한도 제약을 무시한 값입니다.");
  if(res.warn.maturity) w.push("<b>"+ymKo(res.warn.maturity)+"</b>에 만기일시상환 대출의 만기가 도래해 원금을 일시 상환하도록 계산했습니다. 실제로는 연장 여부 확인이 필요합니다.");
  if(cfg.invest.rate > 10) w.push("가정 수익률이 연 "+cfg.invest.rate+"%입니다. 장기 평균으로는 낙관적이므로 낮춰서도 비교해 보십시오.");
  var wb = $("warnbox");
  if(w.length){ wb.style.display="block"; wb.innerHTML = "<b>확인 필요</b><ol><li>"+w.join("</li><li>")+"</li></ol>"; } else wb.style.display = "none";
  window.__res = res;
}

function pullFromSheet(){
  var fx = DB.fx, t = totals(DB);
  function agg(cat){
    var rows = DB.debts.filter(function(x){ return x.cat === cat; }), bal = 0, wsum = 0, lim = 0, term = 0;
    rows.forEach(function(x){ var v = toManwon(x.amount, x.ccy, fx); bal += v; wsum += v * (Number(x.rate)||0); lim += Number(x.limit)||0; term = Math.max(term, Number(x.term)||0); });
    return { n:rows.length, bal:bal, lim:lim, term:term, rate: bal > 0 ? wsum / bal : (rows.length ? (Number(rows[0].rate)||0) : 0) };
  }
  var mt = agg("마이너스통장"), ln = agg("신용대출");
  DB.sim.mtong.bal = Math.round(mt.bal);
  if(mt.n){ DB.sim.mtong.rate = Math.round(mt.rate*100)/100; if(mt.lim) DB.sim.mtong.limit = mt.lim; }
  DB.sim.loan.bal = Math.round(ln.bal);
  if(ln.n){ DB.sim.loan.rate = Math.round(ln.rate*100)/100; if(ln.term) DB.sim.loan.termMonths = ln.term; }
  DB.sim.park.bal   = Math.round(t.assetByCat["현금성"] || 0);
  DB.sim.invest.bal = Math.round(t.assetByCat["투자"] || 0);           // 해외주식 포함
  DB.sim.expenseM   = fnum(DB.monthlyExpense);
  DB.sim.otherAssets = Math.round(t.net - (DB.sim.park.bal + DB.sim.invest.bal - DB.sim.mtong.bal - DB.sim.loan.bal));
  fillSim(); renderSim(); persistSoon();
  var multi = (mt.n > 1 ? 1 : 0) + (ln.n > 1 ? 1 : 0);
  toast(multi ? "가져왔습니다. 같은 분류가 여러 건이라 금리는 잔액 가중평균입니다." : "현황 값을 가져왔습니다. 월 소득은 직접 입력하십시오.");
}

/* ══════════════════════════════════════════
   저장 · 동기화
   ══════════════════════════════════════════ */
var LS = (function(){
  try{ var k = "__nw_t"; window.localStorage.setItem(k, "1"); window.localStorage.removeItem(k); return window.localStorage; }
  catch(e){ var m = {}; return { getItem:function(k){ return k in m ? m[k] : null; }, setItem:function(k,v){ m[k] = String(v); }, removeItem:function(k){ delete m[k]; }, _mem:true }; }
})();
function defaultDevice(){
  var u = navigator.userAgent || "";
  if(/iPhone/.test(u)) return "iPhone"; if(/iPad/.test(u)) return "iPad"; if(/Android/.test(u)) return "Android";
  if(/Macintosh/.test(u)) return "Mac"; if(/Windows/.test(u)) return "Windows PC"; return "브라우저";
}
function deviceName(){ try{ return LS.getItem("nw.device") || defaultDevice(); }catch(e){ return defaultDevice(); } }

var STATE_TEXT = { local:"기기 저장", pending:"전송 대기", syncing:"전송 중", synced:"동기화됨", offline:"오프라인", error:"동기화 오류", conflict:"충돌 — 선택" };
function renderStatus(st){
  var pill = $("syncPill"); if(!pill) return;
  pill.setAttribute("data-s", st.state);
  $("syncText").textContent = STATE_TEXT[st.state] + (st.state === "synced" && st.at ? " " + hhmm(st.at) : "");
  var sl = $("setStatus");
  if(sl){ sl.setAttribute("data-s", st.state); sl.textContent = (st.message || STATE_TEXT[st.state]) + (st.at ? " · " + hhmm(st.at) : ""); }
}

var SYNC = createSync({
  fetch: function(u, i){ return window.fetch(u, i); },
  storage: LS, deviceName: deviceName, debounceMs: 4000,
  onStatus: renderStatus,
  onRemote: function(data){ DB = hydrate(data); DB.asOf = DB.asOf || currentYm(); renderAll(); toast("다른 기기의 최신 내용을 반영했습니다."); },
  onConflict: function(c){ showConflict(c); },
  flush: function(){ persistNow(); }          // 원격 판단 직전, 화면에 입력 중인 값을 먼저 저장
});

var booted = false, persistT = null;
function persistNow(){
  if(!booted) return;
  if(persistT){ clearTimeout(persistT); persistT = null; }
  try{ readSim(); }catch(e){}
  SYNC.saveLocal(serialize());
}
function persistSoon(){
  if(!booted) return;
  if(persistT) clearTimeout(persistT);
  persistT = setTimeout(persistNow, 300);
}
["input","change","click"].forEach(function(t){
  document.addEventListener(t, function(e){
    if(e.target && e.target.closest && e.target.closest("#setBg, #cfBg")) return;   // 설정 입력은 자산 데이터 아님
    persistSoon();
  });
});
document.addEventListener("visibilitychange", function(){
  if(document.visibilityState === "hidden"){ persistNow(); if(SYNC.isConfigured() && SYNC.meta().dirty) SYNC.pushNow(); }
  else if(SYNC.isConfigured()){ persistNow(); SYNC.pull(); }
});
window.addEventListener("pagehide", persistNow);
window.addEventListener("online", function(){ if(SYNC.isConfigured()){ persistNow(); SYNC.onOnline(); } });

/* ── 충돌 ── */
/* 두 데이터의 실제 차이 — 순자산이 같아도 무엇이 다른지 보여준다 */
function diffList(a, b){
  var out = [];
  function add(k, x, y, fmt){ if(JSON.stringify(x) !== JSON.stringify(y)) out.push([k, fmt ? fmt(x) : x, fmt ? fmt(y) : y]); }
  var n = function(v){ return v == null ? "-" : (typeof v === "number" ? v.toLocaleString("ko-KR") : String(v)); };
  add("원/달러 환율", a.fx, b.fx, n);
  add("월 고정지출 (만원)", a.monthlyExpense, b.monthlyExpense, n);
  add("올해 실현손익 (원)", a.tax.realized, b.tax.realized, n);
  [["assets","자산"],["debts","부채"]].forEach(function(p){
    var ma = {}, mb = {};
    a[p[0]].forEach(function(x){ ma[x.id] = x; }); b[p[0]].forEach(function(x){ mb[x.id] = x; });
    Object.keys(ma).concat(Object.keys(mb).filter(function(k){ return !ma[k]; })).forEach(function(id){
      var x = ma[id], y = mb[id];
      if(!x){ out.push([p[1] + " 추가: " + y.name, "없음", n(y.amount)]); return; }
      if(!y){ out.push([p[1] + " 삭제: " + x.name, n(x.amount), "없음"]); return; }
      add(x.name, x.amount, y.amount, n);
      if(x.name !== y.name) out.push([p[1] + " 이름", x.name, y.name]);
    });
  });
  var ha = {}, hb = {};
  a.holdings.forEach(function(x){ ha[x.id] = x; }); b.holdings.forEach(function(x){ hb[x.id] = x; });
  Object.keys(ha).concat(Object.keys(hb).filter(function(k){ return !ha[k]; })).forEach(function(id){
    var x = ha[id], y = hb[id];
    if(!x){ out.push(["종목 추가: " + (y.ticker || "?"), "없음", "있음"]); return; }
    if(!y){ out.push(["종목 삭제: " + (x.ticker || "?"), "있음", "없음"]); return; }
    [["shares","수량"],["price","현재가"],["avgUSD","평단"],["costKRW","매입금액"]].forEach(function(f){ add((x.ticker || "종목") + " " + f[1], x[f[0]], y[f[0]], n); });
  });
  add("월별 기록 수", a.snapshots.length, b.snapshots.length, n);
  if(JSON.stringify(a.sim) !== JSON.stringify(b.sim)) out.push(["시뮬레이션 설정", "다름", "다름"]);
  return out;
}

function showConflict(c){
  var a = totals(hydrate(c.local)), b = totals(hydrate(c.remote));
  $("cfMine").textContent = won(a.net) + "만원";
  $("cfMineS").textContent = "순자산 · 수정 " + dtKo(SYNC.meta().updatedAt);
  $("cfTheirs").textContent = won(b.net) + "만원";
  $("cfTheirsS").textContent = "순자산 · " + (c.remoteDevice || "다른 기기") + " " + dtKo(c.remoteSavedAt);
  var dl = diffList(hydrate(c.local), hydrate(c.remote)), MAX = 8;
  $("cfDiff").innerHTML = '<li class="h"><span>달라진 항목 ' + dl.length + '건</span><span>이 기기</span><span>다른 기기</span></li>' +
    (dl.length ? dl.slice(0, MAX).map(function(r){ return '<li><span>' + esc(r[0]) + '</span><span class="m">' + esc(r[1]) + '</span><span class="t">' + esc(r[2]) + '</span></li>'; }).join("")
               : '<li><span>내용은 같고 저장 시점만 다릅니다 — 어느 쪽을 골라도 같습니다</span><span></span><span></span></li>') +
    (dl.length > MAX ? '<li><span>외 ' + (dl.length - MAX) + '건</span><span></span><span></span></li>' : '');
  openSheet("cfBg");
}
$("bCfMine").onclick = function(){ closeSheet("cfBg"); SYNC.resolve("mine").then(function(){ toast("이 기기 내용으로 저장소를 갱신했습니다."); }); };
$("bCfTheirs").onclick = function(){ closeSheet("cfBg"); SYNC.resolve("theirs"); };
$("bCfBackup").onclick = function(){ exportJson("자산현황_이기기_" + currentYm() + ".json"); };
$("bCfLater").onclick = function(){ closeSheet("cfBg"); toast("충돌이 해결될 때까지 저장소로 보내지 않습니다. 상단 표시를 누르면 다시 고를 수 있습니다."); };

/* ── 시트 ── */
var lastFocus = null;
function openSheet(id){ lastFocus = document.activeElement; var el = $(id); el.classList.add("on"); el.setAttribute("aria-hidden","false");
  var f = el.querySelector("button, input"); if(f) setTimeout(function(){ try{ f.focus({ preventScroll:true }); }catch(e){} }, 30); }
function closeSheet(id){ var el = $(id); el.classList.remove("on"); el.setAttribute("aria-hidden","true"); if(lastFocus && lastFocus.focus) try{ lastFocus.focus(); }catch(e){} }
document.addEventListener("keydown", function(e){ if(e.key === "Escape"){ if($("setBg").classList.contains("on")) closeSheet("setBg"); } });
$("setBg").addEventListener("click", function(e){ if(e.target.id === "setBg") closeSheet("setBg"); });

function guessOwner(){ var h = location.hostname || ""; return /\.github\.io$/.test(h) ? h.split(".")[0] : ""; }
function openSettings(){
  var c = SYNC.publicConfig();
  $("sOwner").value = c.owner || guessOwner();
  $("sRepo").value = c.repo || "networth-data";
  $("sToken").value = "";
  $("sToken").placeholder = c.hasToken ? "●●●● 저장됨 (바꿀 때만 입력)" : "github_pat_…";
  $("sDevice").value = deviceName();
  $("appVer").textContent = "버전 " + APP_VERSION;
  renderStatus(SYNC.status());
  checkStorage();
  openSheet("setBg");
}
$("bMenu").onclick = openSettings;
$("syncPill").onclick = function(){ if(SYNC.status().state === "conflict" && SYNC.pendingConflict()) showConflict(SYNC.pendingConflict()); else openSettings(); };
$("bSetClose").onclick = function(){ closeSheet("setBg"); };
$("sDevice").addEventListener("change", function(){ var v = this.value.trim().slice(0,40); try{ if(v) LS.setItem("nw.device", v); }catch(e){} });

$("bSyncSave").onclick = function(){
  var ok = SYNC.configure({ owner:$("sOwner").value, repo:$("sRepo").value || "networth-data", path:"data.json", branch:"main", token:$("sToken").value });
  $("sToken").value = "";
  if(!ok){ toast("사용자명 · 저장소 · 토큰을 모두 입력하십시오."); return; }
  $("sToken").placeholder = "●●●● 저장됨 (바꿀 때만 입력)";
  persistNow();
  SYNC.testConnection().then(function(t){
    if(!t.ok){ renderStatus({ state:"error", message:t.message, at:Date.now() }); toast(t.message); return; }
    if(t.warn) toast(t.message);
    return SYNC.pull().then(function(r){ if(r && r.action === "pushed") toast("저장소에 첫 저장을 마쳤습니다."); else if(r && r.action === "none") toast("동기화 완료"); });
  });
};
$("bSyncTest").onclick = function(){
  if(!SYNC.isConfigured()){ toast("먼저 저장하고 동기화를 누르십시오."); return; }
  SYNC.testConnection().then(function(t){ toast(t.message); });
};
$("bSyncNow").onclick = function(){
  if(!SYNC.isConfigured()){ toast("동기화가 설정되지 않았습니다."); return; }
  persistNow(); SYNC.pull();
};
(function(){
  var armed = 0;
  $("bSyncOff").onclick = function(){
    if(!SYNC.isConfigured()){ toast("동기화가 설정되어 있지 않습니다."); return; }
    if(Date.now() - armed > 3000){ armed = Date.now(); this.textContent = "한 번 더 누르면 해제"; var b = this; setTimeout(function(){ b.textContent = "연결 해제"; }, 3000); return; }
    armed = 0; this.textContent = "연결 해제";
    SYNC.disconnect(); $("sToken").placeholder = "github_pat_…";
    toast("연결을 해제했습니다. 이 기기의 토큰을 지웠고, 자산 데이터는 기기에 남아 있습니다.");
  };
})();

function checkStorage(){
  var el = $("storeState");
  if(LS._mem){ el.textContent = "기기 저장 불가 (사생활 모드 등) — 동기화 또는 파일 백업 필요"; el.setAttribute("data-s","error"); return; }
  if(navigator.storage && navigator.storage.persisted){
    navigator.storage.persisted().then(function(p){
      el.textContent = p ? "영구 저장 허용됨" : "저장 중 (공간 부족 시 브라우저가 지울 수 있음 — 동기화 권장)";
      el.setAttribute("data-s", p ? "synced" : "pending");
    }).catch(function(){ el.textContent = "저장 중"; });
  }else el.textContent = "저장 중";
}

/* ── 파일 ── */
function download(fn, txt, mime){
  var b = new Blob([txt], { type: mime || "application/json;charset=utf-8" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(b); a.download = fn;
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function exportJson(name){ persistNow(); download(name || ("자산현황_" + currentYm() + ".json"), JSON.stringify(serialize(), null, 2)); toast("JSON 파일을 내려받았습니다."); }
$("bSave").onclick = function(){ exportJson(); };
$("bLoad").onclick = function(){ $("fileIn").click(); };
$("bFirstImport").onclick = function(){ $("fileIn").click(); };
$("fileIn").onchange = function(e){
  var f = e.target.files[0]; e.target.value = ""; if(!f) return;
  var r = new FileReader();
  r.onload = function(){
    try{
      var o = JSON.parse(r.result);
      if(isPlainObj(o) && o.app === "networth" && isPlainObj(o.data)) o = o.data;
      if(!isPlainObj(o) || !Array.isArray(o.assets)) throw new Error("자산현황 파일 형식이 아닙니다.");
      var keepAsOf = DB.asOf;
      DB = hydrate(o); DB.asOf = keepAsOf;
      renderAll(); persistNow();
      $("firstNote").style.display = "none";
      closeSheet("setBg");
      toast("불러왔습니다." + (SYNC.isConfigured() ? " 저장소에도 곧 반영됩니다." : ""));
    }catch(err){ toast("불러오지 못했습니다: " + err.message); }
  };
  r.onerror = function(){ toast("파일을 읽지 못했습니다."); };
  r.readAsText(f, "utf-8");
};
function csvq(v){ var s = String(v == null ? "" : v); return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; }
$("bCsv").onclick = function(){
  var fx = DB.fx, L = ["구분,분류,항목,통화,입력금액,원화환산(만원)"];
  DB.assets.forEach(function(x){ L.push(["자산",x.cat,csvq(x.name),x.ccy,x.amount,Math.round(toManwon(x.amount,x.ccy,fx))].join(",")); });
  DB.debts.forEach(function(x){ L.push(["부채",x.cat,csvq(x.name),x.ccy,x.amount,Math.round(toManwon(x.amount,x.ccy,fx))].join(",")); });
  if(DB.holdings.length){
    L.push(""); L.push("종목,그룹,수량,현재가(USD),평단(USD),원화매입(원),평가(원),원화손익(원)");
    DB.holdings.forEach(function(h){ L.push([csvq(h.ticker),csvq(h.group),h.shares,h.price,h.avgUSD,h.costKRW,Math.round(valueKRW(h,fx)),Math.round(gainKRW(h,fx))].join(",")); });
  }
  var t = totals(DB);
  L.push(""); L.push("총자산(만원),"+Math.round(t.totalAssets)); L.push("총부채(만원),"+Math.round(t.totalDebts)); L.push("순자산(만원),"+Math.round(t.net));
  L.push("기준연월,"+DB.asOf); L.push("환율,"+fx);
  if(DB.snapshots.length){ L.push(""); L.push("연월,총자산,총부채,순자산,환율");
    DB.snapshots.forEach(function(s){ L.push([s.ym,Math.round(s.totalAssets),Math.round(s.totalDebts),Math.round(s.net),s.fx||""].join(",")); }); }
  download("자산현황_" + currentYm() + ".csv", "﻿" + L.join("\r\n"), "text/csv;charset=utf-8");
  toast("CSV를 내려받았습니다.");
};
$("bPrint").onclick = function(){ closeSheet("setBg"); setTimeout(function(){ window.print(); }, 200); };
$("bFirstClose").onclick = function(){ $("firstNote").style.display = "none"; try{ LS.setItem("nw.seenIntro","1"); }catch(e){} };

/* ══════════════════════════════════════════
   화면 이벤트
   ══════════════════════════════════════════ */
function showPane(id){
  $("tabs").querySelectorAll("button").forEach(function(x){ var on = x.dataset.p === id; x.setAttribute("aria-selected", on ? "true" : "false"); x.tabIndex = on ? 0 : -1; });
  document.querySelectorAll(".pane").forEach(function(p){ p.classList.toggle("on", p.id === id); });
  if(id === "p3" && dirty.p3){ renderAnalysis(); dirty.p3 = false; }
  if(id === "p4" && dirty.p4){ renderTrend(); dirty.p4 = false; }
  try{ sessionStorage.setItem("nw.tab", id); }catch(e){}
}
$("tabs").addEventListener("click", function(e){
  var b = e.target.closest("button[data-p]"); if(!b) return;
  showPane(b.dataset.p); try{ window.scrollTo(0,0); }catch(err){}
});
$("tabs").addEventListener("keydown", function(e){
  if(e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  var bs = [].slice.call(this.querySelectorAll("button[data-p]")), i = bs.indexOf(document.activeElement); if(i < 0) return;
  var j = (i + (e.key === "ArrowRight" ? 1 : -1) + bs.length) % bs.length;
  e.preventDefault(); bs[j].focus(); showPane(bs[j].dataset.p);
});

["asOf","fx","fx2","mExp"].forEach(function(id){
  $(id).addEventListener("input", function(){
    if(id === "asOf") DB.asOf = this.value;
    else if(id === "fx" || id === "fx2"){
      DB.fx = fnum(this.value);
      var other = $(id === "fx" ? "fx2" : "fx"); if(other.value !== this.value) other.value = this.value;   // 두 칸 같은 값
      refreshHoldings();
    }
    else DB.monthlyExpense = fnum(this.value);
    refreshDerived();
  });
});

function refocus(id, f){ var el = document.querySelector('[data-id="' + id + '"][data-f="' + f + '"]'); if(el) try{ el.focus({ preventScroll:true }); }catch(e){} }

function onCell(e){
  var t = e.target;
  if(!t.dataset || !t.dataset.f || !t.dataset.k) return;
  var list = DB[t.dataset.k]; if(!list) return;
  var it = list.find(function(x){ return x.id === t.dataset.id; }); if(!it) return;
  var f = t.dataset.f;
  if(t.dataset.k === "holdings"){
    if(f === "ticker" || f === "group"){ if(it[f] === t.value) return; it[f] = t.value; if(f === "group") refreshHoldings(); dirty.p3 = true; return; }
    var hv = fnum(t.value); if(it[f] === hv) return; it[f] = hv;
    refreshHoldings(); refreshDerived(); return;
  }
  if(f === "cat"){ if(it.cat === t.value) return; it.cat = t.value; renderSheet(); refocus(it.id, "cat"); return; }
  if(f === "name"){ if(it.name === t.value) return; it.name = t.value; dirty.p3 = true; return; }
  if(f === "ccy"){
    if(it.ccy === t.value) return; it.ccy = t.value;
    var amt = document.querySelector('[data-id="' + it.id + '"][data-f="amount"]');
    if(amt && amt.parentNode) amt.parentNode.setAttribute("data-label", amtLabel(it.ccy));
    refreshDerived(); return;
  }
  var nv = fnum(t.value); if(it[f] === nv) return; it[f] = nv;
  refreshDerived();
}
function bindTable(tid){
  var el = $(tid);
  el.addEventListener("input", onCell);
  el.addEventListener("change", onCell);
  el.addEventListener("click", function(e){
    var b = e.target.closest("button[data-del]"); if(!b) return;
    var k = b.dataset.del, it = DB[k].find(function(x){ return x.id === b.dataset.id; });
    DB[k] = DB[k].filter(function(x){ return x.id !== b.dataset.id; });
    if(k === "holdings"){ renderHoldings(); }
    renderSheet();
    toast(((it && (it.name || it.ticker)) || "항목") + " 삭제됨");
  });
}
bindTable("tA"); bindTable("tD"); bindTable("tH");

$("bAddA").onclick = function(){ var it = { id:uid("a"), cat:"현금성", name:"새 자산", ccy:"KRW", amount:0 }; DB.assets.push(it); renderSheet(); refocus(it.id, "name"); };
$("bAddD").onclick = function(){ var it = { id:uid("d"), cat:"신용대출", name:"새 부채", ccy:"KRW", amount:0, rate:0, term:0 }; DB.debts.push(it); renderSheet(); refocus(it.id, "name"); };
$("bAddH").onclick = function(){ var it = { id:uid("h"), ticker:"", group:"", shares:0, price:0, avgUSD:0, costKRW:0 }; DB.holdings.push(it); renderHoldings(); renderSheet(); refocus(it.id, "ticker"); };

["taxRealized","taxYear"].forEach(function(id){
  $(id).addEventListener("input", function(){
    if(id === "taxRealized") DB.tax.realized = fnum(this.value);
    else { var y = Math.round(fnum(this.value)); if(y >= 2000 && y <= 2100) DB.tax.year = y; else return; }
    refreshHoldings();
  });
});
$("p2").addEventListener("click", function(e){
  if(e.target && e.target.id === "bTaxReset"){ DB.tax = { year: currentYear(), realized: 0 }; $("taxYear").value = DB.tax.year; $("taxRealized").value = 0; refreshHoldings(); toast(DB.tax.year + "년 기준으로 초기화했습니다."); }
});

function takeSnapshot(){
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(DB.asOf || ""))){ toast("기준 연월을 먼저 지정하십시오."); $("asOf").focus(); return; }
  var had = DB.snapshots.some(function(s){ return s.ym === DB.asOf; });
  DB.snapshots = upsertSnapshot(DB.snapshots, makeSnapshot(DB, DB.asOf));
  renderTrend(); dirty.p4 = false;
  toast(ymKo(DB.asOf) + " 기록을 " + (had ? "갱신" : "저장") + "했습니다.");
}
$("bSnap").onclick = takeSnapshot; $("bSnap2").onclick = takeSnapshot;
$("tSnap").addEventListener("click", function(e){
  var b = e.target.closest("button[data-snapdel]"); if(!b) return;
  DB.snapshots = DB.snapshots.filter(function(s){ return s.ym !== b.dataset.snapdel; });
  renderTrend(); dirty.p4 = false; toast("기록을 삭제했습니다.");
});

document.querySelector("#p5 aside").addEventListener("input", function(e){
  var t = e.target;
  if(t.dataset.ev !== undefined){ var i = +t.dataset.i, f = t.dataset.ev; if(DB.sim.events[i]) DB.sim.events[i][f] = (f === "amt") ? fnum(t.value) : t.value; }
  renderSim();
});
document.querySelector("#p5 aside").addEventListener("change", function(e){
  if(e.target.dataset.ev !== undefined && DB.sim.events[+e.target.dataset.i]) DB.sim.events[+e.target.dataset.i][e.target.dataset.ev] = e.target.dataset.ev === "amt" ? fnum(e.target.value) : e.target.value;
  renderSim();
});
$("prio").addEventListener("click", function(e){
  var b = e.target.closest("button[data-mv]"); if(!b) return;
  var i = +b.dataset.i, j = b.dataset.mv === "up" ? i-1 : i+1;
  if(j < 0 || j >= DB.sim.priority.length) return;
  var tmp = DB.sim.priority[i]; DB.sim.priority[i] = DB.sim.priority[j]; DB.sim.priority[j] = tmp;
  renderPrio(); renderSim();
});
document.querySelectorAll("button[data-preset]").forEach(function(b){
  b.onclick = function(){ DB.sim.priority = PRESET[b.dataset.preset].slice(); renderPrio(); renderSim(); toast(PRESET_NAME[b.dataset.preset] + " 적용"); };
});
$("events").addEventListener("click", function(e){
  var b = e.target.closest("button[data-evdel]"); if(!b) return;
  DB.sim.events.splice(+b.dataset.evdel, 1); renderEvents(); renderSim();
});
$("bAddEvt").onclick = function(){ DB.sim.events.push({ ym: DB.sim.startYm || currentYm(), amt:0, memo:"새 항목", repeat:"none" }); renderEvents(); renderSim(); };
$("bPull").onclick = pullFromSheet;

/* ══════════════════════════════════════════
   기동
   ══════════════════════════════════════════ */
function renderAll(){
  $("asOf").value = DB.asOf; $("fx").value = DB.fx; $("fx2").value = DB.fx; $("mExp").value = DB.monthlyExpense;
  $("taxYear").value = DB.tax.year; $("taxRealized").value = DB.tax.realized;
  renderSheet(); renderHoldings(); fillSim(); renderSim();
  var active = document.querySelector(".pane.on");
  showPane(active ? active.id : "p1");
}

var DB;
(function boot(){
  var saved = SYNC.loadLocal();
  DB = saved ? hydrate(saved) : DEFAULT_DB();
  DB.asOf = currentYm();                    // 열 때마다 이번 달 — 지난달 기록 덮어쓰기 방지
  var seen = false; try{ seen = !!LS.getItem("nw.seenIntro"); }catch(e){}
  if(!saved && !seen) $("firstNote").style.display = "block";
  var tab = null; try{ tab = sessionStorage.getItem("nw.tab"); }catch(e){}
  if(tab && $(tab)){ document.querySelectorAll(".pane").forEach(function(p){ p.classList.toggle("on", p.id === tab); }); }
  renderAll();
  if(!saved){ try{ readSim(); }catch(e){} SYNC.seedLocal(serialize()); }   // 빈 틀은 '수정'이 아님
  booted = true;
  renderStatus(SYNC.status());
  if(SYNC.isConfigured()) SYNC.pull();
  if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function(){});
  if("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1"))
    navigator.serviceWorker.register("sw.js").catch(function(){});
})();
