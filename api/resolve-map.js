/**
 * Vercel Serverless Function: Google Maps短縮URLをサーバー側で展開。
 * ブラウザからの短縮URL取得はCORS制限があるため、このAPIが必要です。
 * SSRF対策としてGoogle/MAPSドメイン以外へのリダイレクトを禁止します。
 */
const GOOGLE_HOSTS = new Set([
  'maps.app.goo.gl','goo.gl','www.google.com','google.com','maps.google.com',
  'www.google.co.jp','google.co.jp','maps.google.co.jp',
  'www.google.co.uk','google.co.uk','www.google.com.au','google.com.au'
]);
function safeGoogleUrl(raw) {
  let u;
  try {u = new URL(raw);}catch{throw new Error('URLの形式が正しくありません');}
  if(u.protocol!=='https:' || !GOOGLE_HOSTS.has(u.hostname.toLowerCase()) || u.username || u.password || u.port)
    throw new Error('GoogleマップのHTTPS URLだけ使用できます');
  if(u.hostname==='goo.gl' && !u.pathname.startsWith('/maps/'))
    throw new Error('Googleマップの短縮URLではありません');
  return u;
}
module.exports = async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET') return res.status(405).json({error:'GETだけに対応しています'});
  const raw=req.query?.url;
  if(typeof raw!=='string'||raw.length>3000)return res.status(400).json({error:'URLを正しく指定してください'});
  let u;
  try {u=safeGoogleUrl(raw);} catch(err){return res.status(400).json({error:err.message});}
  try {
    let changed=false;
    for(let n=0;n<8;n++) {
      if(!['maps.app.goo.gl','goo.gl'].includes(u.hostname) && changed) break;
      const response=await fetch(u.toString(),{
        method:'GET', redirect:'manual', signal:AbortSignal.timeout(9000),
        headers:{'user-agent':'OdekakeMap/2.0 (personal Google Maps URL resolver)','accept':'text/html'}
      });
      if(response.status<300||response.status>=400)break;
      const location=response.headers.get('location');
      if(!location)break;
      u=safeGoogleUrl(new URL(location,u).toString());
      changed=true;
    }
    if(['maps.app.goo.gl','goo.gl'].includes(u.hostname))
      throw new Error('Google側から転送先URLを取得できませんでした');
    return res.status(200).json({url:u.toString()});
  } catch(error) {
    return res.status(502).json({error:`短縮URLを展開できませんでした: ${error.message}`});
  }
};
