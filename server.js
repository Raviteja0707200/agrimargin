'use strict';
/* AgriMargin sync server – zero dependencies (Node >= 18).
   Serves index.html, a single-password login, and record-level sync.      */
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');

const PORT=Number(process.env.PORT)||3000;
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data');
const DATA_FILE=path.join(DATA_DIR,'agrimargin-data.json');
const PASSWORD=process.env.APP_PASSWORD||'password123';
const SESSION_MS=30*24*3600*1000;
const MAX_BODY=12*1024*1024;
fs.mkdirSync(DATA_DIR,{recursive:true});

/* ---------- credentials ----------
   APP_PASSWORD is the initial password. Once the password is changed (or reset with a recovery key)
   the scrypt hash in auth.json takes over. RESET_AUTH=true clears auth.json on boot (emergency reset). */
const AUTH_FILE=path.join(DATA_DIR,'auth.json');
if(process.env.RESET_AUTH==='true'){
  try{fs.unlinkSync(AUTH_FILE);console.log('RESET_AUTH=true: stored password and recovery key cleared; APP_PASSWORD is active again. Remove RESET_AUTH and redeploy.');}catch(e){if(e.code!=='ENOENT')throw e;}
}
let auth=null;
try{auth=JSON.parse(fs.readFileSync(AUTH_FILE,'utf8'));if(!auth||typeof auth!=='object')throw new Error('bad shape');}
catch(e){if(e.code!=='ENOENT'){console.error('FATAL: auth.json is unreadable – refusing to start. Set RESET_AUTH=true to clear it.',e.message);process.exit(1);}auth=null;}
if(PASSWORD.length<8&&!(auth&&auth.pw)){console.error('FATAL: set the APP_PASSWORD environment variable (at least 8 characters).');process.exit(1);}
function saveAuth(){const tmp=AUTH_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(auth),{mode:0o600});fs.renameSync(tmp,AUTH_FILE);}
const kdf=(pw,salt)=>crypto.scryptSync(String(pw).normalize('NFKC'),salt,32);
function mkCred(pw){const salt=crypto.randomBytes(16);return {salt:salt.toString('hex'),hash:kdf(pw,salt).toString('hex')};}
function checkCred(pw,c){if(typeof pw!=='string'||!c)return false;const h=kdf(pw,Buffer.from(c.salt,'hex')),e=Buffer.from(c.hash,'hex');return h.length===e.length&&crypto.timingSafeEqual(h,e);}
const curVer=()=>(auth&&auth.ver)|0;
const KEY_ALPHA='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRecoveryKey(){let s='';for(const x of crypto.randomBytes(20))s+=KEY_ALPHA[x%32];return s.match(/.{4}/g).join('-');}
const normKey=k=>String(k||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const pwProblem=p=>typeof p!=='string'||p.length<8?'Password must be at least 8 characters':p.length>200?'Password is too long':'';
const hasRecovery=()=>!!(auth&&auth.rec);

const SECRET=process.env.SESSION_SECRET||(()=>{
  const f=path.join(DATA_DIR,'.session-secret');
  try{return fs.readFileSync(f,'utf8');}catch(e){const s=crypto.randomBytes(32).toString('hex');fs.writeFileSync(f,s,{mode:0o600});return s;}
})();
const HTML_FILE=fs.existsSync(path.join(__dirname,'index.html'))?path.join(__dirname,'index.html'):path.join(__dirname,'index truck.html');
const INDEX=fs.readFileSync(HTML_FILE);

/* ---------- storage ---------- */
function loadState(){
  try{
    const s=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
    if(!s||typeof s!=='object'||!s.records||!s.tombs||!s.id)throw new Error('unexpected file shape');
    return s;
  }catch(e){
    if(e.code==='ENOENT')return {id:crypto.randomUUID(),rev:0,seq:0,records:{},tombs:{}};
    console.error('FATAL: data file exists but cannot be read – refusing to start so it is not overwritten.',e.message);
    process.exit(1);
  }
}
let state=loadState();
function save(){
  const tmp=DATA_FILE+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(state));
  fs.renameSync(tmp,DATA_FILE);
}
if(!fs.existsSync(DATA_FILE))save();

/* ---------- auto-purge: delete records older than 6 months ---------- */
const RETENTION_DAYS=183;
function retentionCutoff(){const d=new Date();d.setDate(d.getDate()-RETENTION_DAYS);return d.toISOString().slice(0,10);}
function purgeOldRecords(){
  const cutoff=retentionCutoff();let purged=0;
  for(const [id,entry] of Object.entries(state.records)){
    if(entry.rec&&entry.rec.date&&entry.rec.date<cutoff){
      state.rev++;delete state.records[id];state.tombs[id]={at:new Date().toISOString(),rev:state.rev};purged++;
    }
  }
  if(purged>0){save();console.log(`Auto-purge: removed ${purged} records older than ${cutoff}`);}
}
// Run on startup and every 24 hours
purgeOldRecords();
setInterval(purgeOldRecords,24*3600*1000).unref();

/* ---------- validation ---------- */
const num=v=>typeof v==='number'&&isFinite(v)&&Math.abs(v)<=1e12;
const str=(v,m)=>typeof v==='string'?v.replace(/[\u0000-\u001f]+/g,' ').trim().slice(0,m):'';
const iso=v=>{const t=Date.parse(v);return typeof v==='string'&&isFinite(t)?new Date(t).toISOString():null;};
function cleanRecord(r){
  if(!r||typeof r!=='object'||Array.isArray(r))return null;
  const id=str(r.id,40);if(!id)return null;
  if(!['truck','margin','standard'].includes(r.type))return null;
  if(typeof r.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||!isFinite(Date.parse(r.date)))return null;
  if(!num(r.qty)||r.qty<=0)return null;
  const createdAt=iso(r.createdAt),updatedAt=iso(r.updatedAt);if(!createdAt||!updatedAt)return null;
  const o={id,type:r.type,date:r.date,qty:r.qty,commodity:str(r.commodity,80),truck:str(r.truck,30),customer:str(r.customer,80),destination:str(r.destination,80),remarks:str(r.remarks,500),sellPrice:null,procPrice:null,margin:null,expenses:null,createdAt,updatedAt};
  if(r.sample===true)o.sample=true;
  if(r.type==='truck'){if(!num(r.sellPrice)||r.sellPrice<=0||!num(r.margin))return null;o.sellPrice=r.sellPrice;o.margin=r.margin;}
  else if(r.type==='margin'){if(!num(r.margin))return null;o.margin=r.margin;}
  else{
    if(!num(r.procPrice)||r.procPrice<0||!num(r.sellPrice)||r.sellPrice<0)return null;
    o.procPrice=r.procPrice;o.sellPrice=r.sellPrice;o.truck='';
    const e=r.expenses||{},ex={transport:0,loading:0,other:0,extras:[]};
    for(const k of ['transport','loading','other']){if(e[k]==null)continue;if(!num(e[k])||e[k]<0)return null;ex[k]=e[k];}
    if(e.extras!=null){if(!Array.isArray(e.extras)||e.extras.length>30)return null;for(const x of e.extras){if(!x||!num(x.amount)||x.amount<0)return null;ex.extras.push({name:str(x.name,40)||'Expense',amount:x.amount});}}
    o.expenses=ex;
  }
  return o;
}

/* ---------- sync (last-write-wins per record, tombstones for deletes) ---------- */
function sync(body){
  body=body&&typeof body==='object'?body:{};
  if(body.serverId&&body.serverId!==state.id)return {reset:true,serverId:state.id};
  const since=Number.isInteger(body.since)&&body.since>=0?body.since:0;
  const accepted=new Set(),rejected=new Set(),conflicts=[],forceDeletes=new Set(),invalid=[];
  let changed=false;
  const bumpSeq=id=>{const m=/^TXN-(\d+)$/.exec(id);if(m)state.seq=Math.max(state.seq,+m[1]);};
  if(Number.isInteger(body.seq))state.seq=Math.max(state.seq,body.seq);

  for(const t of (Array.isArray(body.deletes)?body.deletes.slice(0,5000):[])){
    const id=str(t&&t.id,40);if(!id)continue;
    const at=iso(t.at)||new Date().toISOString(),cur=state.records[id];
    if(cur&&cur.rec.updatedAt>at){rejected.add(id);continue;}     // edited after it was deleted elsewhere
    if(cur){state.rev++;delete state.records[id];state.tombs[id]={at,rev:state.rev};changed=true;}
    else if(!state.tombs[id]){state.rev++;state.tombs[id]={at,rev:state.rev};changed=true;}
  }
  for(const raw of (Array.isArray(body.upserts)?body.upserts.slice(0,5000):[])){
    const rec=cleanRecord(raw);if(!rec){invalid.push(raw&&raw.id);continue;}
    const cur=state.records[rec.id],tomb=state.tombs[rec.id];
    if(cur){
      if(cur.rec.createdAt!==rec.createdAt){conflicts.push(rec.id);continue;}   // same id, different record
      if(cur.rec.updatedAt>rec.updatedAt){rejected.add(rec.id);continue;}
      if(cur.rec.updatedAt===rec.updatedAt){accepted.add(rec.id);continue;}
    }else if(tomb&&tomb.at>=rec.updatedAt){rejected.add(rec.id);forceDeletes.add(rec.id);continue;}
    state.rev++;state.records[rec.id]={rec,rev:state.rev};delete state.tombs[rec.id];accepted.add(rec.id);bumpSeq(rec.id);changed=true;
  }
  for(const id of Object.keys(state.records))bumpSeq(id);
  if(changed)save();

  const upserts=[],seen=new Set();
  for(const [id,v] of Object.entries(state.records)){if(v.rev>since&&!accepted.has(id)){upserts.push(v.rec);seen.add(id);}}
  rejected.forEach(id=>{const v=state.records[id];if(v&&!seen.has(id))upserts.push(v.rec);});
  const deletes=Object.entries(state.tombs).filter(([,t])=>t.rev>since).map(([id])=>id);
  forceDeletes.forEach(id=>{if(!deletes.includes(id))deletes.push(id);});
  return {serverId:state.id,rev:state.rev,seq:state.seq,upserts,deletes,conflicts,invalid};
}

/* ---------- auth ---------- */
const sign=p=>crypto.createHmac('sha256',SECRET).update(p).digest('base64url');
function makeToken(){const p=Buffer.from(JSON.stringify({exp:Date.now()+SESSION_MS,v:curVer()})).toString('base64url');return p+'.'+sign(p);}
function verifyToken(t){
  if(typeof t!=='string')return false;const [p,s]=t.split('.');if(!p||!s)return false;
  const a=Buffer.from(s),b=Buffer.from(sign(p));if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return false;
  try{const o=JSON.parse(Buffer.from(p,'base64url').toString());return o.exp>Date.now()&&(o.v|0)===curVer();}catch(e){return false;}
}
function cookieOf(req,name){const c=req.headers.cookie||'';for(const part of c.split(';')){const i=part.indexOf('=');if(i>0&&part.slice(0,i).trim()===name)return part.slice(i+1).trim();}return null;}
const isAuthed=req=>verifyToken(cookieOf(req,'am_session'));
const hash=s=>crypto.createHash('sha256').update(String(s)).digest();
const passwordOk=p=>typeof p==='string'&&(auth&&auth.pw?checkCred(p,auth.pw):crypto.timingSafeEqual(hash(p),hash(PASSWORD)));
const clientIp=req=>String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
const attempts=new Map();
function throttled(ip){const a=attempts.get(ip);return a&&a.reset>Date.now()&&a.n>=5;}
function noteFail(ip){const a=attempts.get(ip);if(!a||a.reset<=Date.now())attempts.set(ip,{n:1,reset:Date.now()+15*60*1000});else a.n++;}
setInterval(()=>{const n=Date.now();for(const [k,v] of attempts)if(v.reset<=n)attempts.delete(k);},60*1000).unref();

/* ---------- http ---------- */
function json(res,code,obj){const b=JSON.stringify(Object.assign({app:'AgriMargin'},obj));res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(b);}
function text(res,code,t){res.writeHead(code,{'Content-Type':'text/plain; charset=utf-8'});res.end(t);}
function readJson(req){
  return new Promise((ok,bad)=>{
    let n=0;const chunks=[];
    req.on('data',c=>{n+=c.length;if(n>MAX_BODY){bad(Object.assign(new Error('too large'),{code:413}));req.destroy();return;}chunks.push(c);});
    req.on('end',()=>{try{ok(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch(e){bad(Object.assign(new Error('bad json'),{code:400}));}});
    req.on('error',bad);
  });
}
function securityHeaders(res){
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}
async function api(req,res,p){
  res.setHeader('Cache-Control','no-store');
  if(p==='/api/session'&&req.method==='GET'){const a=isAuthed(req);return json(res,200,a?{authed:true,hasRecovery:hasRecovery()}:{authed:false});}
  if(req.method!=='POST')return json(res,404,{error:'Not found'});
  if(req.headers['x-requested-with']!=='agrimargin')return json(res,403,{error:'Forbidden'});
  const secure=(req.headers['x-forwarded-proto']||'')==='https'?'; Secure':'';
  const ip=clientIp(req);
  const setSession=()=>res.setHeader('Set-Cookie',`am_session=${makeToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS/1000}${secure}`);
  const failDelay=async()=>{noteFail(ip);await new Promise(r=>setTimeout(r,400));};
  if(p==='/api/login'){
    if(throttled(ip))return json(res,429,{error:'Too many attempts'});
    const body=await readJson(req);
    if(passwordOk(body.password)){attempts.delete(ip);setSession();return json(res,200,{authed:true,hasRecovery:hasRecovery()});}
    await failDelay();return json(res,401,{error:'Incorrect password'});
  }
  if(p==='/api/change-password'){
    if(!isAuthed(req))return json(res,401,{error:'Sign in required'});
    if(throttled(ip))return json(res,429,{error:'Too many attempts'});
    const b=await readJson(req);
    if(!passwordOk(b.current)){await failDelay();return json(res,401,{error:'Current password is incorrect'});}
    const bad=pwProblem(b.next);if(bad)return json(res,400,{error:bad});
    auth=Object.assign({},auth,{pw:mkCred(b.next),ver:curVer()+1});saveAuth();attempts.delete(ip);
    setSession();return json(res,200,{authed:true,hasRecovery:hasRecovery()});     // every other session is now invalid
  }
  if(p==='/api/recovery-key'){
    if(!isAuthed(req))return json(res,401,{error:'Sign in required'});
    if(throttled(ip))return json(res,429,{error:'Too many attempts'});
    const b=await readJson(req);
    if(!passwordOk(b.password)){await failDelay();return json(res,401,{error:'Password is incorrect'});}
    const key=newRecoveryKey();auth=Object.assign({ver:0},auth,{rec:mkCred(normKey(key))});saveAuth();attempts.delete(ip);
    return json(res,200,{recoveryKey:key});                                            // shown once; only a hash is stored
  }
  if(p==='/api/reset-password'){
    if(throttled(ip))return json(res,429,{error:'Too many attempts'});
    const b=await readJson(req);
    if(!hasRecovery())return json(res,400,{error:'No recovery key was ever created on this server.'});
    if(!checkCred(normKey(b.recoveryKey),auth.rec)){await failDelay();return json(res,401,{error:'That recovery key is not correct'});}
    const bad=pwProblem(b.next);if(bad)return json(res,400,{error:bad});
    const key=newRecoveryKey();                                                        // the used key is retired, issue a fresh one
    auth=Object.assign({},auth,{pw:mkCred(b.next),rec:mkCred(normKey(key)),ver:curVer()+1});saveAuth();attempts.delete(ip);
    setSession();return json(res,200,{authed:true,hasRecovery:true,recoveryKey:key});
  }
  if(p==='/api/logout'){res.setHeader('Set-Cookie',`am_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);return json(res,200,{authed:false});}
  if(p==='/api/sync'){
    if(!isAuthed(req))return json(res,401,{error:'Sign in required'});
    return json(res,200,sync(await readJson(req)));
  }
  json(res,404,{error:'Not found'});
}
const server=http.createServer(async(req,res)=>{
  try{
    const p=new URL(req.url,'http://x').pathname;
    securityHeaders(res);
    if(p==='/healthz')return text(res,200,'ok');
    if(p==='/'||p==='/index.html'){
      if(req.method!=='GET'&&req.method!=='HEAD')return text(res,405,'Method not allowed');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});return res.end(req.method==='HEAD'?undefined:INDEX);
    }
    if(p.startsWith('/api/'))return await api(req,res,p);
    text(res,404,'Not found');
  }catch(e){
    if(e&&(e.code===400||e.code===413)&&!res.headersSent)return json(res,e.code,{error:e.message});
    console.error(e);if(!res.headersSent)json(res,500,{error:'Server error'});else res.end();
  }
});
server.listen(PORT,()=>console.log(`AgriMargin listening on :${PORT} (data: ${DATA_FILE})`));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
