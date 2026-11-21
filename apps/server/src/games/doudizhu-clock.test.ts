import {it,expect} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../app.js';
import {openDatabase,migrate} from '../database/index.js';
it('persists deadlines, rejects late moves, advances offline turns and applies safe timeout actions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ddz-clock-')),path=join(dir,'test.sqlite'),db=openDatabase(path).sqlite;migrate(db);let now=Date.now();const users=['a','b','c'],origin='https://board.test';
 for(const id of users){db.prepare('INSERT INTO users(id,username,nickname,password_hash,created_at) VALUES(?,?,?,?,?)').run(id,id,id,'unused',0);db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(id).digest('hex'),id,now+3600000);}
 let app=createApp({databasePath:path,origin,logger:false,doudizhuClock:()=>now}).app;
 const post=(url:string,id:string,payload:object)=>app.inject({method:'POST',url,headers:{origin,cookie:`board_session=${id}`},payload});const get=(url:string,id='a')=>app.inject({url,headers:{cookie:`board_session=${id}`}});const cmd=(v:number,type:string,extra:object={})=>({type,expectedVersion:v,requestId:randomUUID(),...extra});
 try{let v=(await post('/api/doudizhu/rooms','a',{capacity:3})).json();const base=`/api/doudizhu/rooms/${v.code}`;for(const id of users.slice(1))await post(base+'/join',id,{});for(const id of users){v=(await get(base,id)).json();v=(await post(base+'/actions',id,cmd(v.version,'ready',{ready:true}))).json();}
  expect(v.deadline).toBe(now+30000);const deadline=v.deadline,old=v.version,first=v.view.currentTurn;
  await app.close();app=createApp({databasePath:path,origin,logger:false,doudizhuClock:()=>now}).app;expect((await get(base)).json().deadline).toBe(deadline);
  now=deadline;expect((await post(base+'/actions',users[first]!,cmd(old,'bid',{score:3}))).statusCode).toBe(409);v=(await get(base)).json();expect(v.view.currentTurn).toBe((first+1)%3);expect(v.tablePlays[first]).toEqual({type:'bid',score:0,automatic:true});expect(v.deadline).toBe(now+30000);
  const leader=v.view.currentTurn;v=(await post(base+'/actions',users[leader]!,cmd(v.version,'bid',{score:3}))).json();expect(v.view.myHand).toHaveLength(20);
  now=v.deadline;await new Promise(resolve=>setTimeout(resolve,1150));const raw=JSON.parse((db.prepare('SELECT state FROM doudizhu_rooms WHERE code=?').get(v.code) as {state:string}).state);expect(raw.game.players[leader].hand).toHaveLength(19);expect(raw.tablePlays[leader].automatic).toBe(true);v=(await get(base)).json();const follower=v.view.currentTurn;
  now=v.deadline;v=(await get(base)).json();expect(v.tablePlays[follower]).toEqual({type:'pass',automatic:true});expect(v.view.currentTurn).toBe((follower+1)%3);
 }finally{await app.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
