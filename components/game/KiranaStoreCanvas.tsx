"use client";
import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import type { CrewActor } from "@/components/game/three/crew";
import type { Lighting } from "@/components/game/three/StoreRenderer";

export interface KiranaStoreCanvasHandle {
  recenter(): void;
  setTopDown(v: boolean): void;
  setLighting(l: Lighting): void;
  select(id: string | null): void;
  setPaused(v: boolean): void;
}

interface Props {
  onSelect: (id: string | null) => void;
  onActors: (a: CrewActor[]) => void;
  onZone: (id: string | null) => void;
  activities?: Record<string, string>;
}

export const KiranaStoreCanvas = forwardRef<KiranaStoreCanvasHandle, Props>(
  function KiranaStoreCanvas({ onSelect, onActors, onZone, activities }, ref) {
    const host = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<
      import("@/components/game/three/StoreRenderer").StoreRenderer | null
    >(null);
    const cbs = useRef({ onSelect, onActors, onZone });
    cbs.current = { onSelect, onActors, onZone };
    const live = useRef<Record<string, string>>({});
    live.current = activities ?? {};

    useImperativeHandle(ref, () => ({
      recenter: () => rendererRef.current?.recenter(),
      setTopDown: (v) => rendererRef.current?.setTopDown(v),
      setLighting: (l) => rendererRef.current?.setLighting(l),
      select: (id) => rendererRef.current?.select(id),
      setPaused: (v) => rendererRef.current?.setPaused(v),
    }));

    useEffect(() => {
      if (rendererRef.current && activities) rendererRef.current.setLiveActivities(activities);
    }, [activities]);

    useEffect(() => {
      let cancelled = false;
      let r: import("@/components/game/three/StoreRenderer").StoreRenderer | null = null;
      (async () => {
        try {
          await Promise.race([
            Promise.all([
              document.fonts.load('800 40px "Baloo 2"'),
              document.fonts.load('700 40px "Baloo 2"'),
            ]),
            new Promise((res) => setTimeout(res, 2500)),
          ]);
        } catch {
          /* use system font */
        }
        const { StoreRenderer } = await import("@/components/game/three/StoreRenderer");
        if (cancelled || !host.current) return;
        r = new StoreRenderer(
          host.current,
          (id) => cbs.current.onSelect(id),
          (a) => cbs.current.onActors(a),
          (z) => cbs.current.onZone(z),
        );
        r.setLiveActivities(live.current);
        rendererRef.current = r;
      })();
      return () => {
        cancelled = true;
        r?.dispose();
        rendererRef.current = null;
      };
    }, []);

    return <div ref={host} className="relative h-full w-full" />;
  },
);
