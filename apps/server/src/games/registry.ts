import type {GameMetadata} from '@board/contracts';
export function createRegistry(){return {list:():GameMetadata[]=>[{id:'doudizhu',name:'斗地主',description:'三人好友斗地主，先暗叫、再明叫。',status:'available',ruleVersion:'blind-open-1.0',playPath:'/games/doudizhu',playerCounts:[3],capabilities:{solo:false,multiplayer:true,privateRooms:true,matchmaking:false}}]};}
