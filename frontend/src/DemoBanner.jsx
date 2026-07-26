import { useEffect, useState } from 'react';
import { ArrowRight, FlaskConical } from 'lucide-react';
import { Button } from './ui.jsx';

// US-036: the sandbox is the whole app on throwaway data with every run replayed
// from a fixture. That is honest only if every screen says so — hence a
// persistent strip under the top bar, present in demo mode on all views. It
// states that results are simulated and when the tenant resets, and carries the
// one signup CTA the deployment exists to drive.
//
// `expiresAt` is when the reaper deletes this tenant (from POST /api/demo/session);
// null while it resolves or if provisioning failed. `error` is the capacity/rate
// message when a tenant couldn't be minted — still labelled a demo, but honest
// that this session isn't backed by one.
export default function DemoBanner({ expiresAt, ctaUrl, error }) {
  // Re-render each minute so the reset countdown stays roughly current rather
  // than freezing at whatever it read on first paint.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="demo-bar" role="status">
      <div className="demo-bar-inner">
        <FlaskConical size={14} aria-hidden="true" />
        <span className="demo-bar-msg">
          <strong>Demo — simulated results.</strong>{' '}
          {error ? (
            <span>{error}</span>
          ) : (
            <span>
              Every run replays a recording; nothing here is live.{' '}
              {resetPhrase(expiresAt)}
            </span>
          )}
        </span>
        {ctaUrl && (
          <Button as="a" href={ctaUrl} variant="primary" size="sm" className="demo-bar-cta">
            Sign up <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}

/** "This sandbox resets in ~52m." — a rough, honest countdown, no false precision. */
function resetPhrase(expiresAt) {
  if (!expiresAt) return 'This sandbox is temporary and resets on its own.';
  const mins = Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000);
  if (mins <= 1) return 'This sandbox resets any moment now.';
  if (mins < 60) return `This sandbox resets in ~${mins}m.`;
  const hrs = Math.round(mins / 60);
  return `This sandbox resets in ~${hrs}h.`;
}
