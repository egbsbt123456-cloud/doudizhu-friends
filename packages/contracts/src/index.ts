import {z} from 'zod';
export const gameMetadataSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), description: z.string(),
  status: z.enum(['development', 'available', 'maintenance']),
  ruleVersion: z.string().nullable(),
  playPath: z.string().regex(/^\/games\/[a-z0-9-]+$/).optional(),
  capabilities: z.object({ solo: z.boolean(), multiplayer: z.boolean(), privateRooms: z.boolean(), matchmaking: z.boolean() }),
  playerCounts: z.array(z.number().int().positive()),
});
export type GameMetadata = z.infer<typeof gameMetadataSchema>;
export const catalogSchema = z.object({ games: z.array(gameMetadataSchema) });
export const actionEnvelopeSchema = z.object({ requestId: z.uuid(), matchId: z.uuid(), expectedVersion: z.number().int().nonnegative(), type: z.string().min(1).max(80), payload: z.unknown() });
export type ActionEnvelope = z.infer<typeof actionEnvelopeSchema>;
export interface ServerEvents { 'platform:hello': (data: { protocolVersion: 1; serverTime: string; access: 'public' }) => void }
export interface ClientEvents { 'platform:ping': (ack: (data: { serverTime: string }) => void) => void }

export type {Card,LandlordPlayer,LandlordState,LandlordClientState,HandType,PlayedCards,DoudizhuRoomView,DoudizhuTablePlay} from './landlord.js';
