/**
 * Google Maps URL resolver for Vercel (validated place names only).
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
async function resolve(raw) {
  let u=safeGoogleUrl(raw);
  // If the URL already identifies a place, never fetch Google again. Google often
  // returns a consent/unsupported page when a backend fetches the destination.
  const initial=infoFromUrl(u,'url');
  if (initial.name && initial.coords) return initial;
  let html='';
  for(let n=0;n<8;n++) {
    const nested=unwrapLink(u);
    if (nested) {
      u=nested;
      const identified=infoFromUrl(u,'wrapped-url');
      if(identified.name && identified.coords) return identified;
      continue;
    }
    let response;
    try {
      response=await fetch(u.toString(),{
        method:'GET',redirect:'manual',signal:AbortSignal.timeout(8000),
        headers:{
          'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language':'ja-JP,ja;q=0.9,en;q=0.6'
        }
      });
    }catch(error) {
      // If we have already found a genuine place URL, prefer the identified
      // name over a later failure to fetch its HTML.
      const partial=infoFromUrl(u,'redirect-url');
      if(partial.name) return partial;
      throw error;
    }
    if(response.status>=300 && response.status<400) {
      const redirect=response.headers.get('location');
      if(!redirect) break;
      const next=new URL(redirect,u);
      // Some Google pages redirect to a consent screen or other non-Maps host.
      // Retain the last valid Google Maps destination if it already has the title.
      try{u=safeGoogleUrl(next.toString());}
      catch(error){
        const partial=infoFromUrl(u,'redirect-url');
        if(partial.name)return partial;
        throw error;
      }
      // CRITICAL: Stop on the first URL containing a valid place title and
      // location. No second request to google.co.jp or consent.google.com.
      const identified=infoFromUrl(u,'redirect-url');
      if(identified.name && identified.coords) return identified;
      continue;
    }
    if(response.ok) html=await firstHtml(response);
    break;
  }
  if(['maps.app.goo.gl','goo.gl'].includes(u.hostname.toLowerCase()))
    throw new Error('Google側から転送先URLを取得できませんでした');
  const result=infoFromUrl(u,'final-url');
  if(!result.name && html) {
    result.name=htmlPlaceName(html);
    if(result.name) result.source='page-title';
  }
  return result;
}
module.exports=async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Odekake-Resolver','v9');
  if(req.method!=='GET')return res.status(405).json({error:'GETだけに対応しています'});
  const raw=req.query?.url;
  if(typeof raw!=='string'||raw.length>3500)return res.status(400).json({error:'URLを正しく指定してください'});
  try {return res.status(200).json(await resolve(raw));}
  catch(err){return res.status(502).json({error:`共有URLを解析できませんでした: ${err.message}`});}
};
module.exports._test={safeGoogleUrl,normalizedName,urlPlaceName,htmlPlaceName,isAddressLike,isOpaqueMapsToken,placeCoords,resolve};
