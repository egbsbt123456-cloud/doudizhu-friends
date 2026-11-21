import {randomBytes,randomInt,createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {createLandlordPlugin,landlordRank} from '@board/game-core';
import type {LandlordState,DoudizhuRoomView,DoudizhuTablePlay} from '@board/contracts';
type Saved={round:number;game:LandlordState|null;reason:string|null;deadline?:number|null;tablePlays?:Record<number,DoudizhuTablePlay>};
const TURN_MS=30000;
const empty=(round=1):Saved=>({round,game:null,reason:null});
import {sessionUser,type SessionUser} from '../auth/session.js';
type Room={code:string;capacity:number;host_seat:number;status:DoudizhuRoomView['status'];state:string;version:number;created_at:number;updated_at:number};
type Seat={seat:number;user_id:string;ready:number};
class Refusal extends Error{constructor(public status:number,message:string){super(message);}}
const codeSchema=z.string().regex(/^[A-F0-9]{10}$/);
const envelope={requestId:z.uuid(),expectedVersion:z.number().int().nonnegative()};
const action=z.discriminatedUnion('type',[
 z.object({...envelope,type:z.literal('ready'),ready:z.boolean()}).strict(),
 z.object({...envelope,type:z.literal('play'),cards:z.array(z.string().min(1).max(40)).min(1).max(20)}).strict(),
 z.object({...envelope,type:z.literal('bid'),score:z.number().int().min(0).max(3)}).strict(),
 z.object({...envelope,type:z.literal('pass')}).strict(),
 z.object({...envelope,type:z.literal('resign')}).strict(),
 z.object({...envelope,type:z.literal('cancel')}).strict(),
 z.object({...envelope,type:z.literal('rematch')}).strict(),
 z.object({...envelope,type:z.literal('leave')}).strict()
]);
export function registerDoudizhu(app:FastifyInstance,db:Database.Database,origin:string,production:boolean,clock:()=>number=Date.now){
  const engine=createLandlordPlugin(randomInt);
  app.register(async routes=>{
    const identities=new WeakMap<FastifyRequest,SessionUser>();
    const limits=new Map<string,{n:number;until:number}>();
    routes.addHook('preHandler',async(req,reply)=>{
      if(production&&!origin.startsWith('https://'))return reply.code(503).send({error:'好友同玩需要 HTTPS'});
      const user=sessionUser(db,req.headers.cookie);
      if(!user)return reply.code(401).send({error:'请先登录，再与好友同玩'});
      identities.set(req,user);
      if(req.method==='GET'){expireDue();return;}
      if(req.headers.origin!==origin)return reply.code(403).send({error:'请求来源不允许'});
      const now=Date.now();
      for(const [key,v] of limits)if(v.until<now)limits.delete(key);
      if(limits.size>=10000&&!limits.has(user.id))return reply.code(429).send({error:'请求繁忙，请稍后重试'});
      const limit=limits.get(user.id)??{n:0,until:now+60000};limits.set(user.id,limit);
      if(++limit.n>60)return reply.code(429).send({error:'操作太频繁，请稍后重试'});
      expireDue();
    });
    routes.setErrorHandler((err,req,reply)=>{
      if(err instanceof Refusal)return reply.code(err.status).send({error:err.message});
      req.log.error(err);return reply.code(500).send({error:'房间服务暂时不可用，请稍后重试'});
    });

    const getRoom=(code:string)=>db.prepare('SELECT * FROM doudizhu_rooms WHERE code=?').get(code) as Room|undefined;
    function applyEvent(state:Saved,event:'bid'|'play'|'pass',payload:unknown,automatic=false,actor=state.game!.currentTurn){
      const game=state.game!,seat=actor,free=game.game.lastPlay===null;
      const result=engine.handleEvent(game,String(seat),event,payload);
      if(result.error)throw new Refusal(409,result.error);
      state.game=result.state;
      if(event==='bid'){
        if(game.currentPhase!=='bidding')state.tablePlays={};
        else state.tablePlays={...state.tablePlays,[seat]:{type:'bid',score:(payload as {score:number}).score,automatic}};
      }else{
        if(event==='play'&&free)state.tablePlays={};
        state.tablePlays={...state.tablePlays,[seat]:event==='play'?{type:'play',cards:game.game.lastPlay!.cards,automatic}:{type:'pass',automatic}};
      }
      state.deadline=game.currentPhase==='ended'?null:clock()+TURN_MS;
    }
    function expireDue(){
      const now=clock();
      const due=db.prepare("SELECT * FROM doudizhu_rooms WHERE status='playing' AND (json_extract(state,'$.deadline') IS NULL OR json_extract(state,'$.deadline')<=?) LIMIT 100").all(now) as Room[];
      for(const room of due){
        try{db.transaction(()=>{
          const state=JSON.parse(room.state) as Saved;
          if(state.deadline==null){state.deadline=now+TURN_MS;}
          else if(state.game!.currentPhase==='bidding')applyEvent(state,'bid',{score:0},true);
          else if(state.game!.game.lastPlay&&state.game!.game.lastPlayer!==state.game!.currentTurn)applyEvent(state,'pass',{},true);
          else{
            const hand=state.game!.players[state.game!.currentTurn]!.hand;
            const card=hand.reduce((a,b)=>landlordRank(a)<=landlordRank(b)?a:b);
            applyEvent(state,'play',{cards:[{id:card.id}]},true);
          }
          db.prepare('UPDATE doudizhu_rooms SET state=?,status=?,version=version+1,updated_at=? WHERE code=?').run(JSON.stringify(state),state.game!.currentPhase==='ended'?'finished':'playing',now,room.code);
        })();}catch(error){app.log.error({err:error,room:room.code},'斗地主回合计时处理失败');}
      }
    }
    const turnTimer=setInterval(()=>{try{expireDue();}catch(error){app.log.error(error);}},1000);
    turnTimer.unref();
    routes.addHook('onClose',async()=>{clearInterval(turnTimer);});
    const parseCode=(req:FastifyRequest)=>{const p=z.object({code:codeSchema}).safeParse(req.params);if(!p.success)throw new Refusal(400,'请输入10位房间码');return p.data.code;};
    const seatsOf=(code:string)=>db.prepare('SELECT seat,user_id,ready FROM doudizhu_seats WHERE room_code=? ORDER BY seat').all(code) as Seat[];
    const member=(room:Room|undefined,user:SessionUser):Room=>{if(!room||!seatsOf(room.code).some(s=>s.user_id===user.id))throw new Refusal(404,'房间不存在，或你尚未加入');return room;};
    const view=(room:Room,user:SessionUser):DoudizhuRoomView=>{
      const state=JSON.parse(room.state) as Saved,seats=seatsOf(room.code),mine=seats.find(s=>s.user_id===user.id)!;
      return {deadline:room.status==='playing'?state.deadline??null:null,serverNow:clock(),turnSeconds:TURN_MS/1000,tablePlays:state.tablePlays??{},code:room.code,hostSeat:room.host_seat,status:room.status,version:room.version,yourSeat:mine.seat,round:state.round,reason:state.reason,view:state.game?engine.getClientState(state.game,String(mine.seat)):null,seats:seats.map(s=>({seat:s.seat,name:(db.prepare('SELECT nickname FROM users WHERE id=?').get(s.user_id) as {nickname:string}|undefined)?.nickname??'玩家',ready:!!s.ready,cardCount:state.game?.players.find(p=>p.id===String(s.seat))?.hand.length??0,role:state.game?.players.find(p=>p.id===String(s.seat))?.role??null})),updatedAt:room.updated_at};
    };
    const checkActive=(user:SessionUser)=>{const n=db.prepare("SELECT count(*) AS n FROM doudizhu_rooms r JOIN doudizhu_seats s ON r.code=s.room_code WHERE s.user_id=? AND r.status IN ('waiting','playing')").get(user.id) as {n:number};if(n.n>=3)throw new Refusal(409,'已有3个未结束房间，请先结束或退出');};
    routes.get('/rooms',req=>{const user=identities.get(req)!;const rooms=db.prepare("SELECT r.* FROM doudizhu_rooms r JOIN doudizhu_seats s ON r.code=s.room_code WHERE s.user_id=? AND r.status!='cancelled' ORDER BY r.updated_at DESC LIMIT 6").all(user.id) as Room[];return {rooms:rooms.map(r=>view(r,user))};});
    routes.post('/rooms',(req,reply)=>{
      const parsed=z.object({capacity:z.literal(3)}).strict().safeParse(req.body);if(!parsed.success)throw new Refusal(400,'斗地主需要3人');const user=identities.get(req)!;
      return reply.code(201).send(db.transaction(()=>{
        checkActive(user);
        const recent=db.prepare("SELECT count(*) AS n FROM doudizhu_requests q JOIN doudizhu_rooms r ON r.code=q.room_code WHERE q.user_id=? AND q.request_id='created' AND r.created_at>?").get(user.id,Date.now()-3600000) as {n:number};
        if(recent.n>=20)throw new Refusal(429,'本小时建房较多，请稍后重试');
        let code:string;do{code=randomBytes(5).toString('hex').toUpperCase();}while(getRoom(code));const now=Date.now();
        db.prepare("INSERT INTO doudizhu_rooms VALUES(?,?,0,'waiting',?,0,?,?)").run(code,parsed.data.capacity,JSON.stringify(empty()),now,now);
        db.prepare('INSERT INTO doudizhu_seats VALUES(?,0,?,0)').run(code,user.id);
        db.prepare("INSERT INTO doudizhu_requests VALUES(?,'created',?,'')").run(code,user.id);
        return view(getRoom(code)!,user);
      })());
    });
    routes.get('/rooms/:code',req=>{const user=identities.get(req)!;return view(member(getRoom(parseCode(req)),user),user);});
    routes.post('/rooms/:code/join',req=>{
      if(!z.object({}).strict().safeParse(req.body).success)throw new Refusal(400,'加入参数不正确');const code=parseCode(req),user=identities.get(req)!;
      return db.transaction(()=>{
        const room=getRoom(code);if(!room)throw new Refusal(404,'没有找到这个房间');const seats=seatsOf(code);
        if(seats.some(s=>s.user_id===user.id))return view(room,user);
        if(room.status!=='waiting'||seats.length>=room.capacity)throw new Refusal(409,'房间已满或已经开局');checkActive(user);
        const seat=[0,1,2].find(n=>!seats.some(s=>s.seat===n))!;
        db.prepare('INSERT INTO doudizhu_seats VALUES(?,?,?,0)').run(code,seat,user.id);
        db.prepare('UPDATE doudizhu_seats SET ready=0 WHERE room_code=?').run(code);
        db.prepare('UPDATE doudizhu_rooms SET version=version+1,updated_at=? WHERE code=?').run(Date.now(),code);
        return view(getRoom(code)!,user);
      })();
    });
    routes.post('/rooms/:code/actions',req=>{
      const parsed=action.safeParse(req.body);if(!parsed.success)throw new Refusal(400,'操作参数不正确');const input=parsed.data,code=parseCode(req),user=identities.get(req)!;
      const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
      return db.transaction(()=>{
        const found=getRoom(code);
        const old=db.prepare('SELECT user_id,fingerprint FROM doudizhu_requests WHERE room_code=? AND request_id=?').get(code,input.requestId) as {user_id:string;fingerprint:string}|undefined;
        if(old){if(old.user_id!==user.id||old.fingerprint!==fingerprint)throw new Refusal(409,'请求编号已使用');if(input.type==='leave')return {left:true};return view(member(found,user),user);}
        const room=member(found,user),seats=seatsOf(code),mine=seats.find(s=>s.user_id===user.id)!;
        if(input.expectedVersion!==room.version)throw new Refusal(409,'牌桌已更新，请同步后重试');
        let state=JSON.parse(room.state) as Saved,status=room.status,host=room.host_seat;
        if(input.type==='ready'){
          if(status!=='waiting')throw new Refusal(409,'本局已开始或结束');
          db.prepare('UPDATE doudizhu_seats SET ready=? WHERE room_code=? AND seat=?').run(input.ready?1:0,code,mine.seat);
          const current=seatsOf(code);if(current.length===3&&current.every(s=>s.ready)){state.game=engine.createInitialState(current.map(s=>String(s.seat)));state.deadline=clock()+TURN_MS;state.tablePlays={};status='playing';}
        }else if(input.type==='cancel'){
          if(status!=='waiting'||mine.seat!==host)throw new Refusal(409,'仅房主可取消等待中的房间');status='cancelled';state.reason='cancelled';state.deadline=null;
        }else if(input.type==='leave'){
          if(status!=='waiting')throw new Refusal(409,'只能退出等待中的房间；对局中请使用结束本局');
          db.prepare('DELETE FROM doudizhu_seats WHERE room_code=? AND seat=?').run(code,mine.seat);
          const remaining=seatsOf(code);if(!remaining.length)status='cancelled';else if(mine.seat===host)host=remaining[0]!.seat;
          db.prepare('UPDATE doudizhu_seats SET ready=0 WHERE room_code=?').run(code);
        }else if(input.type==='rematch'){
          if(status!=='finished'||mine.seat!==host)throw new Refusal(409,'仅房主可在结束后再开一局');status='waiting';state=empty(state.round+1);db.prepare('UPDATE doudizhu_seats SET ready=0 WHERE room_code=?').run(code);
        }else{
          if(status!=='playing')throw new Refusal(409,'对局尚未开始或已结束');
          if(input.type==='resign'){state.reason='resign';state.deadline=null;state.game!.currentPhase='ended';state.game!.winner=null;status='finished';}
          else {
            const payload=input.type==='bid'?{score:input.score}:input.type==='play'?{cards:input.cards.map(id=>({id}))}:{};
            applyEvent(state,input.type,payload,false,mine.seat);if(state.game!.currentPhase==='ended')status='finished';
          }
        }
        db.prepare('UPDATE doudizhu_rooms SET state=?,status=?,host_seat=?,version=version+1,updated_at=? WHERE code=?').run(JSON.stringify(state),status,host,Date.now(),code);
        db.prepare('INSERT INTO doudizhu_requests VALUES(?,?,?,?)').run(code,input.requestId,user.id,fingerprint);
        if(input.type==='leave')return {left:true};
        return view(getRoom(code)!,user);
      })();
    });
  },{prefix:'/api/doudizhu'});
}
