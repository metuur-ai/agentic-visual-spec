import {
  InspectOverlay,
  InspectorProvider,
  SelectionReporter,
  SurfaceHost,
  useSurfaceModule,
} from '@visual-spec/core/app';
import { useState } from 'react';

const SURFACE_ID = 'example';

export function App() {
  const [page, setPage] = useState(0);
  const state = useSurfaceModule(SURFACE_ID);

  if (state.status === 'loading') return <Centered>Loading surface…</Centered>;
  if (state.status === 'error') return <Centered>Error: {state.error.message}</Centered>;

  const pages = state.module.default;
  const Page = pages[Math.min(page, pages.length - 1)]!;

  return (
    <InspectorProvider surfaceId={SURFACE_ID} pageIndex={page}>
      <div style={{ display: 'flex', height: '100%' }}>
        <main style={{ flex: 1, position: 'relative', background: '#f8fafc' }}>
          <SurfaceHost meta={state.module.meta}>
            <Page />
          </SurfaceHost>
          <InspectOverlay />
          <nav style={nav}>
            <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>‹</button>
            <span style={{ font: '12px ui-monospace, monospace' }}>{page + 1} / {pages.length}</span>
            <button type="button" onClick={() => setPage((p) => Math.min(pages.length - 1, p + 1))} disabled={page >= pages.length - 1}>›</button>
            <span style={{ marginLeft: 12, opacity: 0.55, fontSize: 12 }}>press <kbd>I</kbd> to inspect</span>
          </nav>
        </main>
      </div>
      <SelectionReporter />
    </InspectorProvider>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>{children}</div>;
}

const nav: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  left: 12,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
};
