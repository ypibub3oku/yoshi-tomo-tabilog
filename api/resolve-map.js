/**
 * Google Maps URL resolver for Vercel (redirect fallback + validated place names).
 * - Expands maps.app.goo.gl / goo.gl/maps redirects.
 * - Attempts to retrieve a genuine place title from the Google Maps page.
 * - Never guesses a place name from a street address.
 * - No Google API key is required, though metadata may be unavailable for some links.
 */
const GOOGLE_HOSTS = new Set([
  'maps.app.goo.gl','goo.gl','www.google.com','google.com','maps.google.com',
  'www.google.co.jp','google.co.jp','maps.google.co.jp',
  'www.google.co.uk','google.co.uk','www.google.com.au','google.com.au'
]);
function safeGoogleUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('URLの形式が正しくありません'); }
  if (u.protocol !== 'https:' || !GOOGLE_HOSTS.has(u.hostname.toLowerCase()) || u.username || u.password || u.port)
    throw new Error('GoogleマップのHTTPS URLだけ使用できます');
  if (u.hostname.toLowerCase() === 'goo.gl' && !u.pathname.startsWith('/maps/'))
    throw new Error('Googleマップの短縮URLではありません');
  return u;
}
function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (original,code) => {
    const basic={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '};
    if (basic[code.toLowerCase()]) return basic[code.toLowerCase()];
    if (code[0] === '#') {
      const n=Number.parseInt(code.slice(code[1]?.toLowerCase()==='x'?2:1),code[1]?.toLowerCase()==='x'?16:10);
      return Number.isInteger(n) && n>0 && n<=0x10ffff ? String.fromCodePoint(n) : original;
    }
    return original;
  });
}
// Google Maps URLs may carry opaque IDs or internal data as if they were a place
// segment. Only human-readable, unambiguous names are accepted.
function isOpaqueMapsToken(value) {
  const s=String(value||'').trim();
  return !s ||
    /^(?:data[=:]|!\d+[a-z]|0x[0-9a-f]+(?::0x[0-9a-f]+)?$|ChIJ[A-Za-z0-9_-]{8,}$|place_id\s*[:=]|cid\s*[:=]|(?:null|undefined|nan|unknown))/.test(s) ||
    /(?:!\d+[a-z]|\b(?:ftid|skid|g_ep|entry|authuser|ved|hl|gl)=)/i.test(s) ||
    /^(?:[a-f0-9]{24,}|[A-Za-z0-9_-]{38,})$/i.test(s) ||
    /^(?:https?:|www\.|maps\.|\/)/i.test(s) ||
    /^(?:[-+]?\d+(?:\.\d+)?\s*,\s*[-+]?\d+(?:\.\d+)?)$/.test(s) ||
    /(?:%[0-9a-f]{2}){4,}/i.test(s) ||
    /[{}<>\[\]\\]/.test(s);
}
function isAddressLike(text) {
  const s=String(text||'').trim();
  // Distinguish an address ("東京都港区芝公園4丁目2-8") from a store name
  // ("セブン-イレブン 新宿三丁目店"). The old rule rejected every "丁目".
  return !s || /^(?:〒|郵便番号|\d{3}-\d{4}\b|日本[,、\s]|Japan[,\s])/i.test(s) ||
    /^(?:(?:北海道|東京都|大阪府|京都府|.{2,4}県).{0,95}(?:\d+丁目|[0-9０-９]+[-‐－ー−][0-9０-９]+|番地|\d+番\d*号))/.test(s) ||
    /^\d{1,5}\s+\w+(?:\s+\w+){0,5}\s+(?:st|street|rd|road|ave|avenue|blvd)\b/i.test(s) ||
    /^(?:Google\s*(?:Maps|マップ)|Googleマップ|地図|Map|Maps|Search|Place|Directions)(?:\s*[-|—].*)?$/i.test(s) ||
    /^(?:Sign in|Before you continue|Access Denied|Page Not Found|Error \d+|お探しのページ|ログイン|ページが見つかりません)/i.test(s);
}
function normalizedName(value) {
  let s=decodeEntities(value).replace(/<[^>]*>/g,'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
  // Remove a Maps page suffix, without removing hyphens within store names.
  if(isAddressLike(s)) return '';
  s=s.replace(/\s*[-–—|]\s*Google\s*(?:Maps|マップ)\s*$/i,'').trim();
  // A share label may append an address after a comma or postal marker.
  s=s.split(/\s*[、,]\s*(?=(?:〒|日本[、, ]|北海道|東京都|大阪府|京都府|.{2,4}県))/)[0].trim();
  s=s.split(/\s+(?=〒\s*\d{3}-\d{4})/)[0].trim();
  if(s.length<2 || s.length>120 || isOpaqueMapsToken(s) || isAddressLike(s)) return '';
  return s;
}
function urlPlaceName(raw) {
  try {
    const u=safeGoogleUrl(raw);
    const p=u.pathname.match(/\/(?:maps\/)?(?:place|search)\/([^/@?#]+)/i);
    if(p) {
      const n=normalizedName(decodeURIComponent(p[1].replace(/\+/g,' ')));
      if(n) return n;
    }
    for(const field of ['query','q']) {
      const v=u.searchParams.get(field);
      if(v && !/^[-\d.,\s]+$/.test(v)) {
        const n=normalizedName(v.split('〒')[0]);
        if(n) return n;
      }
    }
  } catch {}
  return '';
}
function metaValue(html, key, attribute) {
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag=match[0];
    const attrs={};
    for(const a of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
      attrs[a[1].toLowerCase()]=a[2]??a[3]??a[4];
    if ((attrs.property||attrs.name||'').toLowerCase()===key.toLowerCase())
      return attrs[attribute]||'';
  }
  return '';
}
function htmlPlaceName(html) {
  for(const raw of [metaValue(html,'og:title','content'),metaValue(html,'twitter:title','content'),
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]]) {
    const n=normalizedName(raw);
    if(n) return n;
  }
  return '';
}
async function firstHtml(response) {
  if (!String(response.headers.get('content-type')||'').includes('text/html')) return '';
  const reader=response.body?.getReader?.();
  if (!reader) return '';
  const decoder=new TextDecoder(); let text='', size=0;
  try {
    while(size<350000) {
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      text+=decoder.decode(value,{stream:true});
      if (size>=350000)break;
    }
  } finally {try{await reader.cancel();}catch{}}
  return text;
}
function unwrapLink(u) {
  const linked=u.searchParams.get('link');
  if (linked) {try {return safeGoogleUrl(linked)} catch {}}
  return null;
}
// Extract the coordinates of a selected Google Maps place, not the map viewport (@...)
// Google place URL example: .../maps/place/東京タワー/@35.6585848,139.742858,17z/data=...!3d35.6585805!4d139.7454329
function placeCoords(url) {
  const pair=String(url).match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (pair) return {lat:Number(pair[1]),lng:Number(pair[2])};
  const reversed=String(url).match(/!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/);
  if (reversed) return {lat:Number(reversed[2]),lng:Number(reversed[1])};
  try {
    const u=new URL(url);
    for (const param of ['query','q','ll']) {
      const value=u.searchParams.get(param);
      const m=value?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (m) return {lat:Number(m[1]),lng:Number(m[2])};
    }
  }catch {}
  return null;
}
function infoFromUrl(u, source) {
  const name=urlPlaceName(u.toString());
  return {url:u.toString(),name,coords:placeCoords(u.toString()),source};
}
// Some Google short links return a redirect for GET, others for HEAD.  Also,
// intermediate Google pages may expose the place through an og:url or canonical.
function htmlDestination(html, fromUrl) {
  const candidates = [];
  const meta = metaValue(html,'og:url','content');
  if(meta) candidates.push(meta);
  for(const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag=m[0];
    if(!/rel\s*=\s*['"]?canonical\b/i.test(tag)) continue;
    const href=tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if(href)candidates.push(href[1]||href[2]||href[3]);
  }
  const refresh = String(html).match(/<meta\b[^>]*http-equiv\s*=\s*['"]?refresh\b[^>]*>/i)?.[0];
  const fromRefresh = refresh?.match(/url\s*=\s*['"]?([^'"\s>]+)/i)?.[1];
  if(fromRefresh)candidates.push(fromRefresh);
  for(const raw of candidates) {
    try {return safeGoogleUrl(new URL(decodeEntities(raw),fromUrl).toString());}catch{}
  }
  return null;
}
async function fetchGoogle(u,method) {
  return fetch(u.toString(),{
    method,redirect:'manual',signal:AbortSignal.timeout(7500),
    headers:{
      'user-agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language':'ja-JP,ja;q=0.9,en;q=0.6'
    }
  });
}
async function resolve(raw) {
  let u=safeGoogleUrl(raw);
  const initial=infoFromUrl(u,'url');
  if(initial.name && initial.coords)return initial;
  let foundHtml='',lastError=null;
  const seen=new Set();
  for(let hop=0;hop<9;hop++) {
    const url=u.toString();
    if(seen.has(url))break;
    seen.add(url);
    const wrapped=unwrapLink(u);
    if(wrapped){u=wrapped;continue;}
    const current=infoFromUrl(u,'redirect-url');
    if(current.name && current.coords)return current;

    let next=null, html='';
    // GET is the default. HEAD is a fallback for pages that reject or block GET.
    for(const method of ['GET','HEAD']) {
      let response;
      try {response=await fetchGoogle(u,method);}
      catch(error){lastError=error;continue;}
      if(response.status>=300 && response.status<400) {
        const location=response.headers.get('location');
        if(location){
          try {next=safeGoogleUrl(new URL(location,u).toString());}catch {}
          if(next)break;
        }
      }
      if(method==='GET' && response.ok) {
        html=await firstHtml(response).catch(()=> '');
        foundHtml=html||foundHtml;
        next=htmlDestination(html,u);
        if(next)break;
      }
      if(response.ok && !next)break;
    }
    if(next){u=next;continue;}
    break;
  }
  const result=infoFromUrl(u,'final-url');
  if(!result.name && foundHtml){
    result.name=htmlPlaceName(foundHtml);
    if(result.name)result.source='page-title';
  }
  const isUnexpanded=['maps.app.goo.gl','goo.gl'].includes(u.hostname.toLowerCase());
  if(isUnexpanded) {
    const reason=lastError ? '（Google側への通信が失敗した可能性があります）' : '';
    throw new Error('Googleの短縮URLを展開できませんでした'+reason);
  }
  return result;
}
module.exports=async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Odekake-Resolver','v10');
  if(req.method!=='GET')return res.status(405).json({error:'GETだけに対応しています'});
  const raw=req.query?.url;
  if(typeof raw!=='string'||raw.length>3500)return res.status(400).json({error:'URLを正しく指定してください'});
  try {return res.status(200).json(await resolve(raw));}
  catch(err){return res.status(502).json({error:`共有URLを解析できませんでした: ${err.message}`});}
};
module.exports._test={safeGoogleUrl,normalizedName,urlPlaceName,htmlPlaceName,isAddressLike,isOpaqueMapsToken,placeCoords,resolve,htmlDestination};
