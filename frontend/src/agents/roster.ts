import type { AgentId, RoomId } from '../sim/types';

export type Accessory = 'headset' | 'glasses' | 'hardhat' | 'beret' | 'tie' | 'hood' | 'none';
export type HairStyle = 'short' | 'long' | 'ponytail' | 'bun' | 'spiky';

export interface Look {
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  shirt: string;
  pants: string;
  accessory: Accessory;
  accent?: string;
}

export interface AgentDef {
  id: AgentId;
  name: string;
  role: string;
  room: RoomId;
  /** Desk top-left tile; the desk spans 2 tiles along +gx. The seat is the tile in front (+gy). */
  desk: { x: number; y: number };
  look: Look;
  /** Readable accent colour for names and rings in the interface. */
  tint: string;
  /** Short line used when the agent introduces themselves. */
  blurb: string;
}

export const AGENTS: AgentDef[] = [
  {
    id: 'lia',
    tint: '#ff8aa0',
    name: 'Lia',
    role: 'Sales Assistant',
    room: 'sales',
    desk: { x: 3, y: 28 },
    look: { skin: '#f1c7a1', hair: '#3a2418', hairStyle: 'long', shirt: '#e8607a', pants: '#3a4560', accessory: 'headset' },
    blurb: 'Handles new inquiries and gathers customer requirements.',
  },
  {
    id: 'marco',
    tint: '#72b8f5',
    name: 'Marco',
    role: 'Quotation Assistant',
    room: 'sales',
    desk: { x: 7, y: 28 },
    look: { skin: '#d9a27a', hair: '#1c1c1c', hairStyle: 'short', shirt: '#4f9de0', pants: '#2f3442', accessory: 'glasses' },
    blurb: 'Prepares quotation drafts for review.',
  },
  {
    id: 'paolo',
    tint: '#f7a94e',
    name: 'Paolo',
    role: 'Production Tracker',
    room: 'ops',
    desk: { x: 3, y: 16 },
    look: { skin: '#c98e64', hair: '#2a1b10', hairStyle: 'short', shirt: '#f0902a', pants: '#3b4150', accessory: 'hardhat', accent: '#f5c518' },
    blurb: 'Tracks shop-floor progress on every order.',
  },
  {
    id: 'nina',
    tint: '#62d6a4',
    name: 'Nina',
    role: 'Installation Scheduler',
    room: 'ops',
    desk: { x: 7, y: 16 },
    look: { skin: '#f0c9a8', hair: '#7a3e1d', hairStyle: 'ponytail', shirt: '#43b58a', pants: '#2e3a4a', accessory: 'none' },
    blurb: 'Plans installation crews and dates.',
  },
  {
    id: 'bea',
    tint: '#ad93f3',
    name: 'Bea',
    role: 'Finance Reporter',
    room: 'finance',
    desk: { x: 28, y: 28 },
    look: { skin: '#e6b48e', hair: '#141414', hairStyle: 'bun', shirt: '#8a6fd6', pants: '#2c2f3d', accessory: 'glasses' },
    blurb: 'Prepares income, expense and budget summaries.',
  },
  {
    id: 'rosa',
    tint: '#f2b8d0',
    name: 'Rosa',
    role: 'Collections Officer',
    room: 'finance',
    desk: { x: 32, y: 28 },
    look: { skin: '#d8a07c', hair: '#4a2a1a', hairStyle: 'ponytail', shirt: '#c2557f', pants: '#2c2f3d', accessory: 'headset' },
    blurb: 'Follows up downpayments and remaining balances.',
  },
  {
    id: 'mika',
    tint: '#6fd3e8',
    name: 'Mika',
    role: 'Data Analyst',
    room: 'intel',
    desk: { x: 2, y: 9 },
    look: { skin: '#e9bf98', hair: '#2b1d14', hairStyle: 'bun', shirt: '#2f8fa6', pants: '#2a3140', accessory: 'glasses' },
    blurb: 'Finds trends: best sellers, busy months and production bottlenecks.',
  },
  {
    id: 'carlo',
    tint: '#ff9566',
    name: 'Carlo',
    role: 'Marketing Writer',
    room: 'content',
    desk: { x: 28, y: 16 },
    look: { skin: '#b97a50', hair: '#3b2a1a', hairStyle: 'short', shirt: '#ff7a45', pants: '#34394a', accessory: 'beret', accent: '#c7344a' },
    blurb: 'Writes captions and posts for finished projects.',
  },
  {
    id: 'joy',
    tint: '#b6e36a',
    name: 'Joy',
    role: 'Customer Service',
    room: 'sales',
    desk: { x: 3, y: 32 },
    look: { skin: '#e8b996', hair: '#1f140d', hairStyle: 'bun', shirt: '#7fb83a', pants: '#2f3442', accessory: 'headset' },
    blurb: 'Drafts replies to customer messages about their orders.',
  },
  {
    id: 'tess',
    tint: '#f5d06b',
    name: 'Tess',
    role: 'Quality Control Assistant',
    room: 'ops',
    desk: { x: 3, y: 20 },
    look: { skin: '#dba882', hair: '#2a1a10', hairStyle: 'ponytail', shirt: '#c9a227', pants: '#34394a', accessory: 'glasses' },
    blurb: 'Builds inspection checklists from order specifications: dimensions, design, finish, jamb and hardware.',
  },
  {
    id: 'dev',
    tint: '#9fb4dc',
    name: 'Dev',
    role: 'Data Quality Checker',
    room: 'dev',
    desk: { x: 14, y: 4 },
    look: { skin: '#e2b090', hair: '#232323', hairStyle: 'spiky', shirt: '#4a5878', pants: '#262a35', accessory: 'hood' },
    blurb: 'Finds mistakes in the order data and writes a fix list.',
  },
  {
    id: 'sam',
    tint: '#7fd1c7',
    name: 'Sam',
    role: 'Systems Monitor',
    room: 'dev',
    desk: { x: 17, y: 4 },
    look: { skin: '#c98e64', hair: '#1a1a1a', hairStyle: 'short', shirt: '#2f7f74', pants: '#262a35', accessory: 'headset' },
    blurb: 'Watches the order system, finance, Gemini and Facebook for failures and slowdowns.',
  },
  {
    id: 'ivy',
    tint: '#c9a2f0',
    name: 'Ivy',
    role: 'Security Officer',
    room: 'dev',
    desk: { x: 20, y: 4 },
    look: { skin: '#f0c9a8', hair: '#3a1f12', hairStyle: 'long', shirt: '#5b3f8c', pants: '#262a35', accessory: 'glasses' },
    blurb: 'Watches sign-ins, blocked requests and risky settings.',
  },
  {
    id: 'aya',
    tint: '#ff9fd6',
    name: 'Aya',
    role: 'UI/UX Designer',
    room: 'dev',
    desk: { x: 14, y: 8 },
    look: { skin: '#f1c7a1', hair: '#5a2d1a', hairStyle: 'bun', shirt: '#d9579c', pants: '#2c2f3d', accessory: 'beret', accent: '#3a3f8f' },
    blurb: 'Plans page layouts, navigation and the mobile experience.',
  },
  {
    id: 'rey',
    tint: '#8fd17a',
    name: 'Rey',
    role: 'Developer',
    room: 'dev',
    desk: { x: 17, y: 8 },
    look: { skin: '#c98e64', hair: '#151515', hairStyle: 'short', shirt: '#3f8f4a', pants: '#262a35', accessory: 'headset' },
    blurb: 'Turns improvements into a change plan for your coding environment.',
  },
  {
    id: 'kim',
    tint: '#ffb37a',
    name: 'Kim',
    role: 'QA Tester / Reviewer',
    room: 'dev',
    desk: { x: 20, y: 8 },
    look: { skin: '#e9bf98', hair: '#241812', hairStyle: 'long', shirt: '#d9773a', pants: '#2a3140', accessory: 'glasses' },
    blurb: 'Tests workflows and reviews changes before release.',
  },
  {
    id: 'chief',
    tint: '#e8c46a',
    name: 'Chief',
    role: 'Coordinator',
    room: 'command',
    desk: { x: 21, y: 14 },
    look: { skin: '#c88b62', hair: '#6b6b6b', hairStyle: 'short', shirt: '#1f2a44', pants: '#1a1f2e', accessory: 'tie', accent: '#d8434e' },
    blurb: 'Coordinates the team and approves outgoing work.',
  },
];

export const AGENT_BY_ID: Record<AgentId, AgentDef> = Object.fromEntries(AGENTS.map((a) => [a.id, a])) as Record<
  AgentId,
  AgentDef
>;

export function seatOf(id: AgentId): { x: number; y: number } {
  const d = AGENT_BY_ID[id].desk;
  return { x: d.x, y: d.y + 1 };
}
