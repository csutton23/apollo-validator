import { useState, useCallback, useRef } from "react";

const MODEL = "claude-sonnet-4-20250514";

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim().toLowerCase());
  return lines.slice(1).map(line => {
    const cols = [];
    let cur = "", inQ = false;
    for (let ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { cols.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    cols.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cols[i] ?? ""; });
    return obj;
  });
}

function getHeaders(row) {
  const keys = Object.keys(row);
  const find = (...c) => keys.find(k => c.some(x => k.toLowerCase().replace(/[\s_]/g,"").includes(x))) || "";
  return {
    firstName: find("firstname","first"),
    lastName:  find("lastname","last"),
    company:   find("companyname","company"),
    address:   find("companyaddress","address"),
    city:      find("city"),
    state:     find("state"),
    zip:       find("zip","postal"),
  };
}

const f = (row, key) => (row && key && row[key]) ? row[key] : "";

async function verify(row, h) {
  const co = f(row,h.company), fn = f(row,h.firstName), ln = f(row,h.lastName);
  const addr = f(row,h.address), city = f(row,h.city), state = f(row,h.state), zip = f(row,h.zip);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: "user",
        content: `Verify this business record by searching the web. Return ONLY raw JSON with no markdown fences.\n\nCompany: ${co}\nApollo owner: ${fn} ${ln}\nApollo address: ${addr}, ${city}, ${state} ${zip}\n\nFind the real owner and address from the company website or public records. Return this exact JSON structure:\n{"verified_owner_first":"","verified_owner_last":"","verified_address":"","verified_city":"","verified_state":"","verified_zip":"","name_status":"MATCH or MISMATCH or PARTIAL or UNVERIFIED","address_status":"MATCH or MISMATCH or PARTIAL or UNVERIFIED","name_notes":"","address_notes":"","source":""}`
      }]
    })
  });
  const data = await res.json();
  const raw = (data.content?.find(b => b.type === "text")?.text || "").replace(/```json|```/g,"").trim();
  try { return JSON.parse(raw); }
  catch { return { verified_owner_first:"",verified_owner_last:"",verified_address:"",verified_city:"",verified_state:"",verified_zip:"",name_status:"UNVERIFIED",address_status:"UNVERIFIED",name_notes:"Could not parse",address_notes:"",source:"" }; }
}

const COLS = ["First Name","Last Name","Company","Apollo Address","Apollo City","Apollo State","Apollo Zip","Verified First","Verified Last","Verified Address","Verified City","Verified State","Verified Zip","Name Status","Address Status","Name Notes","Address Notes","Source"];

function buildTSV(rows, h, results) {
  const lines = [COLS.join("\t")];
  rows.forEach((row, i) => {
    const r = results[i] || {};
    lines.push([
      f(row,h.firstName), f(row,h.lastName), f(row,h.company),
      f(row,h.address), f(row,h.city), f(row,h.state), f(row,h.zip),
      r.verified_owner_first||"", r.verified_owner_last||"",
      r.verified_address||"", r.verified_city||"", r.verified_state||"", r.verified_zip||"",
      r.name_status||"", r.address_status||"",
      r.name_notes||"", r.address_notes||"", r.source||""
    ].join("\t"));
  });
  return lines.join("\n");
}

const SC = { MATCH:"#22c55e", MISMATCH:"#f87171", PARTIAL:"#fbbf24", UNVERIFIED:"#94a3b8", PENDING:"#60a5fa", ERROR:"#f97316" };
const SB = { MATCH:"#052e16", MISMATCH:"#2d0a0a", PARTIAL:"#2d1d00", UNVERIFIED:"#0f172a", PENDING:"#0c1a2e", ERROR:"#2d1200" };

function Pill({ s }) {
  const c = SC[s]||SC.UNVERIFIED, bg = SB[s]||SB.UNVERIFIED;
  const labels = { MATCH:"Match", MISMATCH:"Mismatch", PARTIAL:"Partial", UNVERIFIED:"Unverified", PENDING:"Pending…", ERROR:"Error" };
  return <span style={{ background:bg, color:c, border:`1px solid ${c}40`, borderRadius:4, padding:"2px 8px", fontSize:11, fontWeight:700, whiteSpace:"nowrap" }}>{labels[s]||s}</span>;
}

export default function App() {
  const [rows, setRows]         = useState([]);
  const [hmap, setHmap]         = useState(null);
  const [results, setResults]   = useState({});
  const [statuses, setStatuses] = useState({});
  const [running, setRunning]   = useState(false);
  const [pct, setPct]           = useState(0);
  const [fileName, setFileName] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [tab, setTab]           = useState("results");
  const [copied, setCopied]     = useState(false);
  const taRef = useRef(null);

  const onFile = useCallback(e => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = ev => {
      const parsed = parseCSV(ev.target.result);
      if (!parsed.length) return;
      setRows(parsed);
      setHmap(getHeaders(parsed[0]));
      setResults({}); setStatuses({}); setPct(0); setTab("results");
    };
    reader.readAsText(file);
  }, []);

  const run = useCallback(async () => {
    if (!rows.length || !hmap || running) return;
    setRunning(true); setPct(0);
    const res = {}, sts = {};
    for (let i = 0; i < rows.length; i++) {
      sts[i] = "PENDING"; setStatuses({...sts});
      try {
        res[i] = await verify(rows[i], hmap);
        sts[i] = "DONE";
      } catch(err) {
        res[i] = { name_status:"ERROR", address_status:"ERROR", name_notes:String(err), verified_owner_first:"",verified_owner_last:"",verified_address:"",verified_city:"",verified_state:"",verified_zip:"",address_notes:"",source:"" };
        sts[i] = "ERROR";
      }
      setResults({...res}); setStatuses({...sts});
      setPct(Math.round(((i+1)/rows.length)*100));
    }
    setRunning(false);
  }, [rows, hmap, running]);

  const doCopy = useCallback(async () => {
    if (!hmap) return;
    const tsv = buildTSV(rows, hmap, results);
    try {
      await navigator.clipboard.writeText(tsv);
      setCopied(true); setTimeout(() => setCopied(false), 3000);
    } catch {
      if (taRef.current) {
        taRef.current.focus(); taRef.current.select();
        document.execCommand("copy");
        setCopied(true); setTimeout(() => setCopied(false), 3000);
      }
    }
  }, [rows, hmap, results]);

  const overallS = i => {
    const r = results[i];
    if (!r) return statuses[i] === "PENDING" ? "PENDING" : "UNVERIFIED";
    if (statuses[i] === "ERROR") return "ERROR";
    const ns = r.name_status, as = r.address_status;
    if (ns==="MATCH" && as==="MATCH") return "MATCH";
    if (ns==="MISMATCH" || as==="MISMATCH") return "MISMATCH";
    if (ns==="PARTIAL" || as==="PARTIAL") return "PARTIAL";
    return "UNVERIFIED";
  };

  const counts = rows.reduce((a,_,i) => { const s=overallS(i); a[s]=(a[s]||0)+1; return a; }, {});
  const done = Object.keys(results).length;
  const tsv = tab === "export" && hmap ? buildTSV(rows, hmap, results) : "";

  return (
    <div style={{ minHeight:"100vh", background:"#070d14", color:"#e2e8f0", fontFamily:"'IBM Plex Mono','Courier New',monospace", paddingBottom:60 }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap" rel="stylesheet"/>

      {/* Header */}
      <div style={{ background:"linear-gradient(135deg,#0f1f2e,#0a1628)", borderBottom:"1px solid #1e3a5f", padding:"22px 28px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontSize:18, fontWeight:700, color:"#60a5fa", letterSpacing:"0.08em" }}>⬡ APOLLO CONTACT VALIDATOR</div>
          <div style={{ fontSize:10, color:"#475569", marginTop:3, letterSpacing:"0.05em" }}>AI-POWERED OWNER & ADDRESS VERIFICATION · M&A ADVISORY</div>
        </div>
        {rows.length > 0 && <div style={{ fontSize:11, color:"#475569" }}>{fileName} · <span style={{ color:"#60a5fa" }}>{rows.length} records</span></div>}
      </div>

      <div style={{ maxWidth:1180, margin:"0 auto", padding:"24px 18px" }}>

        {/* Upload */}
        <label style={{ display:"block", border:"2px dashed #1e3a5f", borderRadius:10, padding:"32px 20px", textAlign:"center", cursor:"pointer", background:"#0a1628", marginBottom:22 }}>
          <input type="file" accept=".csv" onChange={onFile} style={{ display:"none" }}/>
          <div style={{ fontSize:24, marginBottom:8 }}>📂</div>
          <div style={{ fontSize:13, color:"#60a5fa", fontWeight:700 }}>UPLOAD APOLLO CSV EXPORT</div>
          <div style={{ fontSize:11, color:"#475569", marginTop:5 }}>Columns needed: First Name · Last Name · Company · Address · City · State · Zip</div>
          {fileName && <div style={{ marginTop:10, color:"#22c55e", fontSize:12 }}>✓ {fileName} — {rows.length} rows detected</div>}
        </label>

        {rows.length > 0 && <>

          {/* Action bar */}
          <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:18, flexWrap:"wrap" }}>
            <button
              disabled={running}
              onClick={run}
              style={{ background: running?"#1e293b":"linear-gradient(135deg,#1d4ed8,#3b82f6)", color: running?"#475569":"#fff", border:"none", borderRadius:6, padding:"9px 22px", fontSize:12, fontWeight:700, cursor: running?"not-allowed":"pointer", letterSpacing:"0.05em" }}
            >
              {running ? `VERIFYING… ${pct}%` : "▶ RUN VERIFICATION"}
            </button>
            {done > 0 && <>
              <button onClick={()=>setTab("results")} style={{ background: tab==="results"?"#1d4ed8":"#0a1628", color: tab==="results"?"#fff":"#475569", border:`1px solid ${tab==="results"?"#1d4ed8":"#1e3a5f"}`, borderRadius:6, padding:"9px 18px", fontSize:12, fontWeight:700, cursor:"pointer" }}>📋 RESULTS</button>
              <button onClick={()=>setTab("export")}  style={{ background: tab==="export" ?"#1d4ed8":"#0a1628", color: tab==="export" ?"#fff":"#475569", border:`1px solid ${tab==="export" ?"#1d4ed8":"#1e3a5f"}`, borderRadius:6, padding:"9px 18px", fontSize:12, fontWeight:700, cursor:"pointer" }}>↓ EXPORT DATA</button>
            </>}
            <span style={{ fontSize:11, color:"#475569" }}>{done}/{rows.length} verified</span>
          </div>

          {/* Progress bar */}
          {running && (
            <div style={{ height:3, background:"#0f172a", borderRadius:2, marginBottom:18, overflow:"hidden" }}>
              <div style={{ height:"100%", background:"linear-gradient(90deg,#3b82f6,#60a5fa)", width:`${pct}%`, transition:"width 0.3s" }}/>
            </div>
          )}

          {/* Stats */}
          <div style={{ display:"flex", gap:10, marginBottom:18, flexWrap:"wrap" }}>
            {[["MATCH","#22c55e","CONFIRMED"],["PARTIAL","#fbbf24","PARTIAL"],["MISMATCH","#f87171","MISMATCH"],["UNVERIFIED","#94a3b8","UNVERIFIED"]].map(([k,c,l]) => (
              <div key={k} style={{ flex:"1 1 90px", background:"#0a1628", border:`1px solid ${c}30`, borderRadius:8, padding:"10px 14px" }}>
                <div style={{ fontSize:24, fontWeight:700, color:c, lineHeight:1 }}>{counts[k]||0}</div>
                <div style={{ fontSize:10, color:"#64748b", marginTop:3, letterSpacing:"0.05em" }}>{l}</div>
              </div>
            ))}
          </div>

          {/* RESULTS TAB */}
          {tab === "results" && (
            <div style={{ overflowX:"auto", borderRadius:8, border:"1px solid #1e3a5f" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead>
                  <tr>
                    {["#","Company","Owner (Apollo)","Address (Apollo)","Name","Address",""].map((h,i) => (
                      <th key={i} style={{ background:"#0d1b2a", color:"#60a5fa", padding:"9px 11px", textAlign:"left", fontWeight:700, letterSpacing:"0.05em", borderBottom:"1px solid #1e3a5f", fontSize:11, whiteSpace:"nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const r = results[i];
                    const s = statuses[i];
                    const exp = expanded === i;
                    const nameSt  = s==="PENDING"?"PENDING": r?(r.name_status||"UNVERIFIED"):"UNVERIFIED";
                    const addrSt  = s==="PENDING"?"PENDING": r?(r.address_status||"UNVERIFIED"):"UNVERIFIED";
                    const tdS = { padding:"8px 11px", borderBottom:"1px solid #0f1f2e", verticalAlign:"middle", fontSize:12 };
                    return [
                      <tr key={`r${i}`} style={{ background: exp?"#0f1f35": i%2===0?"#07111c":"#090f1a", cursor:"pointer" }} onClick={() => setExpanded(exp ? null : i)}>
                        <td style={{...tdS, color:"#475569", width:28}}>{i+1}</td>
                        <td style={{...tdS, color:"#e2e8f0", fontWeight:600}}>{f(row,hmap?.company)}</td>
                        <td style={{...tdS, color:"#94a3b8"}}>{f(row,hmap?.firstName)} {f(row,hmap?.lastName)}</td>
                        <td style={{...tdS, color:"#94a3b8", maxWidth:170, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{f(row,hmap?.address)}, {f(row,hmap?.city)}, {f(row,hmap?.state)}</td>
                        <td style={tdS}><Pill s={nameSt}/></td>
                        <td style={tdS}><Pill s={addrSt}/></td>
                        <td style={{...tdS, color:"#475569", textAlign:"right"}}>{exp?"▲":"▼"}</td>
                      </tr>,
                      exp && r && (
                        <tr key={`e${i}`} style={{ background:"#0c1e30", borderBottom:"2px solid #1e3a5f" }}>
                          <td colSpan={7} style={{ padding:0 }}>
                            <div style={{ padding:"14px 18px", display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
                              {[
                                ["OWNER NAME", r.name_status, `${f(row,hmap?.firstName)} ${f(row,hmap?.lastName)}`, `${r.verified_owner_first||""} ${r.verified_owner_last||""}`.trim()||"—", r.name_notes, null],
                                ["ADDRESS", r.address_status, `${f(row,hmap?.address)}, ${f(row,hmap?.city)}, ${f(row,hmap?.state)} ${f(row,hmap?.zip)}`, [r.verified_address,r.verified_city,r.verified_state,r.verified_zip].filter(Boolean).join(", ")||"—", r.address_notes, r.source]
                              ].map(([label,st,old,nw,notes,src]) => {
                                const c = SC[st]||SC.UNVERIFIED, bg = SB[st]||SB.UNVERIFIED;
                                return (
                                  <div key={label} style={{ background:bg, border:`1px solid ${c}25`, borderRadius:8, padding:"12px 14px" }}>
                                    <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", color:c, marginBottom:10 }}>{label} · <Pill s={st}/></div>
                                    <div style={{ fontSize:12, marginBottom:5 }}><span style={{ color:"#64748b", marginRight:8 }}>Apollo:</span><span style={{ color:"#94a3b8", textDecoration:"line-through" }}>{old}</span></div>
                                    <div style={{ fontSize:12, marginBottom:6 }}><span style={{ color:"#64748b", marginRight:8 }}>Found:</span><span style={{ color:"#e2e8f0", fontWeight:600 }}>{nw}</span></div>
                                    {notes && <div style={{ fontSize:11, color:"#64748b", fontStyle:"italic" }}>{notes}</div>}
                                    {src && <div style={{ fontSize:10, color:"#3b82f6", marginTop:5, wordBreak:"break-all" }}>🔗 {src}</div>}
                                  </div>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      )
                    ];
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* EXPORT TAB */}
          {tab === "export" && (
            <div>
              <div style={{ background:"#0c1e30", border:"1px solid #1e3a5f", borderRadius:8, padding:"14px 18px", marginBottom:14, fontSize:12, color:"#93c5fd", lineHeight:1.8 }}>
                <strong>3 steps to get this into Excel:</strong><br/>
                1. Click <strong>COPY TO CLIPBOARD</strong> below<br/>
                2. Open Excel → click cell <strong>A1</strong><br/>
                3. Press <strong>Ctrl+V</strong> (Windows) or <strong>Cmd+V</strong> (Mac) — all 18 columns paste in correctly<br/>
                <span style={{ color:"#475569", fontSize:11 }}>Then: File → Save As → CSV or .xlsx</span>
              </div>
              <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:12 }}>
                <button
                  onClick={doCopy}
                  style={{ background: copied?"#052e16":"#0f2d1a", color: copied?"#22c55e":"#4ade80", border:`1px solid ${copied?"#22c55e":"#4ade80"}40`, borderRadius:6, padding:"9px 22px", fontSize:12, fontWeight:700, cursor:"pointer", transition:"all 0.2s" }}
                >
                  {copied ? "✓ COPIED TO CLIPBOARD!" : "⎘ COPY TO CLIPBOARD"}
                </button>
                <span style={{ fontSize:11, color:"#475569" }}>{rows.length} rows · 18 columns · tab-separated (pastes into Excel as columns)</span>
              </div>
              <textarea
                ref={taRef}
                readOnly
                value={tsv}
                onClick={e => e.target.select()}
                style={{ width:"100%", height:320, background:"#040a10", color:"#64748b", border:"1px solid #1e3a5f", borderRadius:8, padding:"14px 16px", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, lineHeight:1.6, resize:"vertical", outline:"none", boxSizing:"border-box" }}
              />
            </div>
          )}

        </>}

        {rows.length === 0 && (
          <div style={{ textAlign:"center", padding:"60px 0", color:"#1e3a5f" }}>
            <div style={{ fontSize:42 }}>⬡</div>
            <div style={{ marginTop:10, fontSize:12, letterSpacing:"0.08em" }}>UPLOAD AN APOLLO CSV TO BEGIN</div>
          </div>
        )}

      </div>
    </div>
  );
}
