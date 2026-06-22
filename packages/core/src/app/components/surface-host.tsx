/**
 * surface-host.tsx — render a surface page under its declared projection.
 *  - canvas: fixed WxH, scaled to fit the container (slide-like).
 *  - flow:   natural document flow (screen/mockup).
 * Identity and markers are projection-agnostic; only the frame differs. The host
 * carries data-inspector-root so the overlay can scope elementsFromPoint.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type Projection, resolveProjection, type SurfaceMeta } from '../lib/sdk';

export function SurfaceHost({ meta, children }: { meta?: SurfaceMeta; children: ReactNode }) {
  const projection = resolveProjection(meta);
  return projection.kind === 'canvas' ? (
    <CanvasHost projection={projection}>{children}</CanvasHost>
  ) : (
    <div data-inspector-root style={{ position: 'relative', minHeight: '100%' }}>
      {children}
    </div>
  );
}

function CanvasHost({ projection, children }: { projection: Extract<Projection, { kind: 'canvas' }>; children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      setScale(Math.min(width / projection.width, height / projection.height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [projection.width, projection.height]);

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div
        data-inspector-root
        data-vs-canvas
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: projection.width,
          height: projection.height,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        {children}
      </div>
    </div>
  );
}
