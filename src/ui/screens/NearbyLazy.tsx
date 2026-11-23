import { lazy, Suspense, type ComponentProps, type ReactNode } from "react";

// The nearby screens (WebRTC, QR codes, the in-page referee) load only when someone uses them.
const screens = () => import("./Nearby");
const Panel = lazy(() => screens().then((m) => ({ default: m.NearbyPanel })));
const Invite = lazy(() => screens().then((m) => ({ default: m.NearbyInvite })));
const Join = lazy(() => screens().then((m) => ({ default: m.NearbyJoin })));

function Loading({ children }: { children?: ReactNode }) {
  return (
    <div className="online online--loading" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {children ?? "Loading…"}
    </div>
  );
}

export function NearbyPanel(props: ComponentProps<typeof Panel>) {
  return (
    <Suspense fallback={<Loading />}>
      <Panel {...props} />
    </Suspense>
  );
}

export function NearbyInvite(props: ComponentProps<typeof Invite>) {
  return (
    <Suspense fallback={<Loading>Making a code…</Loading>}>
      <Invite {...props} />
    </Suspense>
  );
}

export function NearbyJoin(props: ComponentProps<typeof Join>) {
  return (
    <Suspense
      fallback={
        <main className="lobby">
          <Loading>Reading the invite…</Loading>
        </main>
      }
    >
      <Join {...props} />
    </Suspense>
  );
}
