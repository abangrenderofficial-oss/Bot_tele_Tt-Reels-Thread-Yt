const INSTANCES = [
  'https://inv.nadeko.net', 'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com', 'https://invidious.tiekoetter.com',
];

function videoId(input) {
  const u = new URL(input); if (u.hostname === 'youtu.be') return u.pathname.split('/').filter(Boolean)[0] || '';
  if (u.pathname === '/watch') return u.searchParams.get('v') || '';
  const p = u.pathname.split('/').filter(Boolean); if (['shorts','embed','live'].includes(p[0])) return p[1] || ''; return '';
}
function collectMedia(node, out=[]) {
  if (!node) return out;
  if (Array.isArray(node)) { for (const x of node) collectMedia(x,out); return out; }
  if (typeof node !== 'object') return out;
  const u = node.url || node.downloadUrl || node.download_url || node.link;
  if (typeof u === 'string' && /^https?:\/\//.test(u)) {
    const type = String(node.type || node.mimeType || node.mime_type || node.format || node.ext || '').toLowerCase();
    if (type.includes('video') || type.includes('mp4') || /\.mp4(?:\?|$)/i.test(u)) out.push({node,url:u});
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') collectMedia(v,out);
  return out;
}
async function weirdDl(url) {
  const r = await fetch(`https://weirddl.sbs/api/info?url=${encodeURIComponent(url)}`, { headers:{Accept:'application/json','User-Agent':'Mozilla/5.0'}, signal:AbortSignal.timeout(18000) });
  if (!r.ok) throw new Error(`weirddl:${r.status}`);
  const data = await r.json(); const found = collectMedia(data);
  if (!found.length) throw new Error('weirddl:no-video');
  const videos = found.map(({node,url}) => ({ url, quality:node.qualityLabel||node.quality||node.resolution||'video', width:null, height:Number(String(node.qualityLabel||node.quality||'').match(/(\d+)p/)?.[1]||0)||null, ext:'mp4', hasAudio:node.hasAudio!==false, source:'weirddl', headers:null, filesize:node.filesize||node.size||null }));
  return { platform:'YouTube', title:data.title||data.data?.title||'', thumbnail:data.thumbnail||data.data?.thumbnail||'', duration:data.duration||data.data?.duration||null, images:[], videos, audios:[] };
}

export async function parseYouTubeFree(url) {
  const id = videoId(url); if (!id) throw new Error('Invalid YouTube URL'); const failures=[];
  try { return await weirdDl(url); } catch(e) { failures.push(String(e?.message||e)); }
  for (const base of INSTANCES) {
    try {
      const r=await fetch(`${base}/api/v1/videos/${encodeURIComponent(id)}?local=true`,{headers:{Accept:'application/json','User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(12000)});
      if(!r.ok){failures.push(`${new URL(base).host}:${r.status}`);continue;} const data=await r.json(); const streams=Array.isArray(data?.formatStreams)?data.formatStreams:[];
      const videos=streams.filter(s=>s?.url).map(s=>({url:s.url,quality:s.qualityLabel||s.quality||s.resolution||'video',width:null,height:Number(String(s.qualityLabel||'').match(/(\d+)p/)?.[1]||0)||null,ext:String(s.container||'').toLowerCase()||'mp4',hasAudio:true,source:'invidious',headers:null,filesize:null}));
      if(!videos.length){failures.push(`${new URL(base).host}:no-streams`);continue;}
      return {platform:'YouTube',title:data.title||'',thumbnail:data.videoThumbnails?.[0]?.url||'',duration:Number(data.lengthSeconds||0)||null,images:[],videos,audios:[]};
    } catch(e){failures.push(`${new URL(base).host}:${e?.name||'error'}`);}
  }
  const err=new Error(`Free YouTube fallback failed: ${failures.join(', ')}`); err.code='DOWNLOADER_ERROR'; throw err;
}
