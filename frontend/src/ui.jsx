import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

// The shared UI vocabulary. Everything visual that appears in more than one
// view lives here so a button, a field or a dialog can't drift between views —
// the styles for all of it are the "Primitives" section of App.css.

// `public/qassist-mark.svg`, inlined rather than served as an <img>: the file's
// check is white, which is invisible on the light theme, so it takes its
// container's text colour. The green stroke is the brand and is fixed in both
// themes. The viewBox is cropped to the ink — the file carries the square
// padding a favicon needs, which as a glyph in a row would just be a hole on
// the left edge.
//
// It names itself only where it stands alone. Beside the wordmark it is
// decoration, and a second "QAssist" for a screen reader to read is noise.
export function BrandMark({ labelled = false }) {
  return (
    <svg
      className="brand"
      viewBox="20 20 86 74"
      fill="none"
      {...(labelled ? { role: 'img', 'aria-label': 'QAssist' } : { 'aria-hidden': 'true' })}
    >
      <path
        d="M26 60 L52 88 L100 26"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M26 60 L100 26"
        stroke="#3DDC97"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * One button component for the whole app; `variant` carries the emphasis
 * (primary action, secondary, quiet, destructive) and `icon` a lucide icon
 * rendered before the label. Defaults to type="button" — a submit button has
 * to say so, which is what keeps forms from firing on the wrong click.
 *
 * `as` swaps the element for something that navigates (a react-router `Link`),
 * so a link that looks like a button is still this component rather than a
 * hand-styled anchor. `type` goes with the real button.
 */
export function Button({
  as: Tag = 'button',
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  type = 'button',
  className = '',
  children,
  ...rest
}) {
  return (
    <Tag
      {...(Tag === 'button' ? { type } : {})}
      className={`btn btn-${variant} btn-${size} ${className}`.trim()}
      {...rest}
    >
      {Icon && <Icon size={size === 'sm' ? 13 : 15} strokeWidth={2} aria-hidden="true" />}
      {children}
    </Tag>
  );
}

/**
 * Icon-only action. `label` is mandatory: it is both the tooltip and the
 * accessible name, since there is no visible text to fall back on.
 */
export function IconButton({
  as: Tag = 'button',
  icon: Icon,
  label,
  variant = 'quiet',
  className = '',
  ...rest
}) {
  return (
    <Tag
      {...(Tag === 'button' ? { type: 'button' } : {})}
      className={`icon-btn icon-btn-${variant} ${className}`.trim()}
      title={label}
      aria-label={label}
      {...rest}
    >
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
    </Tag>
  );
}

/** Title block under the top bar: what this page is, plus its actions. */
export function PageHeader({ title, description, children }) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="page-head-actions">{children}</div>}
    </div>
  );
}

/** Label + control + optional hint, stacked. */
export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** Section heading inside a card — the small uppercase rule with a count. */
export function CardHead({ title, count, children }) {
  return (
    <div className="card-head">
      <span className="card-title">{title}</span>
      {count != null && <span className="card-count">{count}</span>}
      {children}
    </div>
  );
}

/** Placeholder for a list that has nothing in it yet. */
export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="empty">
      {Icon && <Icon size={20} strokeWidth={1.5} aria-hidden="true" />}
      {title && <p className="empty-title">{title}</p>}
      {children && <p className="empty-body">{children}</p>}
      {action}
    </div>
  );
}

/** One number with its label — the verdict readout. */
export function Stat({ label, value, tone = '' }) {
  return (
    <div className={`stat ${tone}`.trim()}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/**
 * Centred dialog. Closes on Escape and on a click outside the panel, moves
 * focus inside on open and restores it on close, and locks the page behind it.
 * Deliberately not <dialog>: Safari support for it only landed recently and
 * the styling hooks are simpler this way.
 */
export function Modal({ title, description, onClose, footer, wide, children }) {
  const panelRef = useRef(null);
  // Read through a ref so the effect below can run on open and close only. A
  // caller's `onClose` is usually a fresh closure each render, and re-running
  // the effect on every keystroke would drag focus back out of the field.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement;
    const onKey = (e) => e.key === 'Escape' && closeRef.current();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    // The first field — never the close button, which is what a plain
    // document-order query finds first since it sits up in the head.
    const panel = panelRef.current;
    const first =
      panel?.querySelector('.modal-body input, .modal-body textarea, .modal-body select') ||
      panel?.querySelector('.modal-foot button') ||
      panel?.querySelector('button');
    first?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={panelRef}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
