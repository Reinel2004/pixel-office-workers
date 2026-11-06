import Phaser from 'phaser';
import { useEffect, useRef } from 'react';
import type { Bus, Insets } from '../bridge';
import type { Engine } from '../sim/engine';
import { OfficeScene } from './OfficeScene';

interface Props {
  engine: Engine;
  bus: Bus;
  insets: Insets;
}

/** Mounts the Phaser game once and hands it the engine + bus. */
export function OfficeCanvas({ engine, bus, insets }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const insetsRef = useRef(insets);
  insetsRef.current = insets;

  useEffect(() => {
    if (!host.current) return;
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host.current,
      transparent: true,
      scale: { mode: Phaser.Scale.RESIZE, width: host.current.clientWidth, height: host.current.clientHeight },
      render: { antialias: true, roundPixels: false },
      banner: false,
      input: { activePointers: 3 },
      audio: { noAudio: true },
      scene: [],
    });
    game.scene.add('office', OfficeScene, true, { engine, bus, insets: insetsRef.current });
    (window as unknown as { __wadGame?: Phaser.Game }).__wadGame = game;
    return () => game.destroy(true);
  }, [engine, bus]);

  useEffect(() => {
    bus.emit('camera:insets', insets);
  }, [bus, insets]);

  return <div ref={host} className="office-canvas" aria-label="Isometric office view" role="application" />;
}
