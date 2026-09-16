import { parseMedia, chooseBestVideo } from '../src/downloader.js';

const CASES = [
  ['reels','https://www.instagram.com/reel/DdVLsscjj2o/?stkn=MXV3a2hncmE3cWZheQ=='],
  ['youtube','https://youtu.be/RKdxQwnRRqw?si=GJX9HDe4OBsxwBYQ'],
  ['tiktok','https://vt.tiktok.com/ZSqqYxc13/'],
  ['threads','https://www.threads.com/share/BALVYg5Lmq/'],
];

export default async function handler(req,res){
  const out=[];
  for (const [name,url] of CASES) {
    try {
      const media=await parseMedia(url);
      const best=chooseBestVideo(media.videos||[]);
      out.push({name,ok:!!best,platform:media.platform||null,title:media.title||'',videoCount:(media.videos||[]).length,best:best?{quality:best.quality,ext:best.ext,hasAudio:best.hasAudio!==false}:null});
    } catch(e) {
      out.push({name,ok:false,code:e?.code||null,error:String(e?.message||e).slice(0,800)});
    }
  }
  res.status(200).json({ok:out.every(x=>x.ok),results:out});
}
