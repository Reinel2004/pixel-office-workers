// Small typed event bus between the React interface and the Phaser scene.

import type { AgentId, RoomId, Selection } from './sim/types';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface BusEvents {
  // UI -> scene
  'camera:zoom': { factor: number };
  'camera:reset': { animate: boolean; initial?: boolean };
  'camera:focusAgent': { id: AgentId };
  'camera:insets': Insets;
  'scene:selection': { selection: Selection };
  // scene -> UI
  'scene:ready': undefined;
  'scene:progress': { value: number };
  'scene:pick': { kind: 'agent'; id: AgentId } | { kind: 'room'; id: RoomId } | { kind: 'none' };
  'scene:zoom': { zoom: number };
}

type Handler<T> = (payload: T) => void;

export class Bus {
  private map = new Map<keyof BusEvents, Set<Handler<unknown>>>();
  on<K extends keyof BusEvents>(k: K, fn: Handler<BusEvents[K]>) {
    if (!this.map.has(k)) this.map.set(k, new Set());
    this.map.get(k)!.add(fn as Handler<unknown>);
    return () => this.map.get(k)?.delete(fn as Handler<unknown>);
  }
  emit<K extends keyof BusEvents>(k: K, payload: BusEvents[K]) {
    this.map.get(k)?.forEach((fn) => fn(payload));
  }
}
