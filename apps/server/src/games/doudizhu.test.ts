import {it,expect} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../app.js';
import {openDatabase,migrate} from '../database/index.js';
import type {DoudizhuRoomView} from '@board/contracts';
const origin='https://board.test',headers=(id:string)=>({origin,cookie:`board_session=${id}`});
const cmd=(type:string,v:number,extra:object={})=>({type,expectedVersion:v,requestId:randomUUID(),...extra});
it('authenticates three seats, protects hands/bottom cards, serializes actions and restores after restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'board-doudizhu-')),path=join(dir,'db.sqlite'),db=openDatabase(path).sqlite;migrate(db);
 for(const id of ['alice','bob','carol','eve']){db.prepare('INSERT INTO users(id,username,nickname,password_hash,created_at) VALUES(?,?,?,?,?)').run(id,id,id,'unused',0);db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(id).digest('hex'),id,Date.now()+600000);}
 let app=createApp({databasePath:path,origin,production:true,logger:false}).app;
 const post=(url:string,id:string,payload:object)=>app.inject({method:'POST',url,headers:headers(id),payload}),get=(url:string,id:string)=>app.inject({url,headers:headers(id)});
 try{
  expect((await get('/api/doudizhu/rooms','unknown')).statusCode).toBe(401);expect((await app.inject({method:'POST',url:'/api/doudizhu/rooms',headers:{...headers('alice'),origin:'https://evil.test'},payload:{capacity:3}})).statusCode).toBe(403);
  const created=await post('/api/doudizhu/rooms','alice',{capacity:3});expect(created.statusCode).toBe(201);let v=created.json<DoudizhuRoomView>();const base=`/api/doudizhu/rooms/${v.code}`,users=['alice','bob','carol'];
  expect((await get(base,'bob')).statusCode).toBe(404);await post(base+'/join','bob',{});await post(base+'/join','carol',{});expect((await post(base+'/join','eve',{})).statusCode).toBe(409);
  for(const id of users){v=(await get(base,id)).json();const ready=cmd('ready',v.version,{ready:true});v=(await post(base+'/actions',id,ready)).json();expect((await post(base+'/actions',id,ready)).json().version).toBe(v.version);}
  expect(v.status).toBe('playing');expect(v.view!.myHand).toHaveLength(17);expect(v.view!.bottomCards).toEqual([]);expect(v.seats.every(s=>s.cardCount===17)).toBe(true);expect(v.view!.playerIds).toEqual(['0','1','2']);expect(JSON.stringify(v)).not.toContain('user_id');
  const bidder=v.view!.currentTurn,id=users[bidder]!,other=users[(bidder+1)%3]!;
  expect((await post(base+'/actions',other,cmd('bid',v.version,{score:3}))).statusCode).toBe(409);expect((await post(base+'/actions',id,cmd('bid',v.version,{score:1.5}))).statusCode).toBe(400);
  const bid=cmd('bid',v.version,{score:3});v=(await post(base+'/actions',id,bid)).json();expect(v.view!.myHand).toHaveLength(20);expect((await post(base+'/actions',id,bid)).json().view.myHand).toHaveLength(20);expect((await get(base,other)).json().view.bottomCards).toEqual([]);
  expect((await post(base+'/actions',id,cmd('pass',v.version))).statusCode).toBe(409);const card=v.view!.myHand[0]!;
  expect((await post(base+'/actions',id,cmd('play',v.version,{cards:[card.id,card.id]}))).statusCode).toBe(409);expect((await post(base+'/actions',id,cmd('play',v.version,{cards:['forged']}))).statusCode).toBe(409);
  const move=cmd('play',v.version,{cards:[card.id]});v=(await post(base+'/actions',id,move)).json();expect(v.view!.myHand).toHaveLength(19);expect((await post(base+'/actions',id,move)).json().view.myHand).toHaveLength(19);expect((await post(base+'/actions',id,cmd('play',v.version-1,{cards:[card.id]}))).statusCode).toBe(409);
  await app.close();app=createApp({databasePath:path,origin,production:true,logger:false}).app;v=(await get(base,id)).json();expect(v.view!.myHand).toHaveLength(19);expect((await get('/api/doudizhu/rooms',id)).json().rooms[0].code).toBe(v.code);
  for(let n=0;n<2;n++){const p=users[v.view!.currentTurn]!;v=(await post(base+'/actions',p,cmd('pass',v.version))).json();}expect(v.view!.gameInfo.lastPlay).toBeNull();expect(v.view!.currentTurn).toBe(bidder);
  v=(await post(base+'/actions','alice',cmd('resign',v.version))).json();expect(v.status).toBe('finished');expect(v.view!.winner).toBeNull();expect(v.view!.bottomCards).toHaveLength(3);
  expect((await post(base+'/actions','bob',cmd('rematch',v.version))).statusCode).toBe(409);v=(await post(base+'/actions','alice',cmd('rematch',v.version))).json();expect(v.round).toBe(2);expect(v.view).toBeNull();
  const leave=cmd('leave',v.version);expect((await post(base+'/actions','alice',leave)).json().left).toBe(true);expect((await post(base+'/actions','alice',leave)).json().left).toBe(true);v=(await get(base,'bob')).json();expect(v.hostSeat).toBe(1);expect((await post(base+'/actions','bob',cmd('cancel',v.version))).json().status).toBe('cancelled');
 }finally{await app.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
it('closes production HTTP',async()=>{const {app}=createApp({databasePath:':memory:',origin:'http://board.test',production:true,logger:false});try{expect((await app.inject('/api/doudizhu/rooms')).statusCode).toBe(503);}finally{await app.close();}});
