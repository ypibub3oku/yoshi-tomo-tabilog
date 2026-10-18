/**
 * Google Maps URL metadata helper for Vercel.
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
function isAddressLike(text) {
  const s=String(text||'').trim();
  return !s || /^(?:〒|郵便番号|\d{3}-\d{4}\b|\d{1,5}\s+\w+\s+(?:st|rd|ave|blvd)\b)/i.test(s) ||
    /^(?:東京都|大阪府|京都府|北海道|.{2,4}県|日本、|Japan,|\d{1,3}[-–]\d{1,3}[-–]\d{1,4})/.test(s) ||
    /(?:\d+[‐ー−-]\d+(?:[‐ー−-]\d+)?|丁目|番地|番[0-9一二三四五六七八九十]+号)/.test(s) ||
    /^(?:Google (?:Maps|マップ)|地図|Map)(?:\s*[-|—].*)?$/i.test(s);
}
function normalizedName(value) {
  let s=decodeEntities(value).replace(/<[^>]*>/g,'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
  // Strip Google Maps suffix, not parts of the actual business name.
  s=s.replace(/\s*[-–—|]\s*Google\s*(?:Maps|マップ)\s*$/i,'').replace(/\s*[-–—|]\s*Google マップ\s*$/,'').trim();
  s=s.replace(/\s*[|–—]\s*Google マップ\s*$/,'').trim();
  if (s.length>150 || isAddressLike(s)) return '';
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
async function resolve(raw) {
  let u=safeGoogleUrl(raw); let html='';
  // Some short links first redirect to an app-link wrapper with a nested /maps URL.
  for(let n=0;n<8;n++) {
    const nested=unwrapLink(u);
    if(nested) {u=nested;continue;}
    const response=await fetch(u.toString(),{
      method:'GET',redirect:'manual',signal:AbortSignal.timeout(7500),
      headers:{'user-agent':'Mozilla/5.0 (compatible; OdekakeMap/7.0)','accept':'text/html','accept-language':'ja-JP,ja;q=0.9'}
    });
    if(response.status>=300 && response.status<400) {
      const redirect=response.headers.get('location');
      if(!redirect)break;
      u=safeGoogleUrl(new URL(redirect,u).toString());
      continue;
    }
    if(response.ok) html=await firstHtml(response);
    break;
  }
  if(['maps.app.goo.gl','goo.gl'].includes(u.hostname.toLowerCase()))
    throw new Error('Google側から転送先URLを取得できませんでした');
  const name=urlPlaceName(u.toString()) || htmlPlaceName(html);
  return {url:u.toString(),name};
}
module.exports=async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return res.status(405).json({error:'GETだけに対応しています'});
  const raw=req.query?.url;
  if(typeof raw!=='string'||raw.length>3500)return res.status(400).json({error:'URLを正しく指定してください'});
  try {return res.status(200).json(await resolve(raw));}
  catch(err){return res.status(502).json({error:`共有URLを解析できませんでした: ${err.message}`});}
};
module.exports._test={safeGoogleUrl,normalizedName,urlPlaceName,htmlPlaceName,isAddressLike,resolve};
