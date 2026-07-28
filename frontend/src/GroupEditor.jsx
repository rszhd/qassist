import { Trash2 } from 'lucide-react';
import { Button } from './ui.jsx';

// The name + slug editor shared by the two things in the Projects view that
// have both: a project and a module. They rename by different routes, so the
// form stays a form — the caller owns the request and its errors.
//
// Renaming and re-slugging are separate acts on the server: a rename never
// re-slugs, because the slug is what a CI config points at. That is why both
// fields are here and why `changedFields` sends only what actually moved.
//
// Delete lives in here rather than on the row being edited: a row that carries
// every action at once is four icons wide before it says anything, and
// deleting is the one action worth a deliberate second step.
export default function GroupEditor({ draft, setDraft, onSubmit, onCancel, onDelete, busy }) {
  return (
    <form className="inline-edit" onSubmit={onSubmit}>
      <input
        value={draft.name}
        autoFocus
        placeholder="Name"
        onChange={(e) => setDraft((cur) => ({ ...cur, name: e.target.value }))}
      />
      <input
        value={draft.slug}
        placeholder="slug"
        className="slug"
        onChange={(e) => setDraft((cur) => ({ ...cur, slug: e.target.value }))}
      />
      <div className="inline-edit-actions">
        <Button size="sm" variant="danger" icon={Trash2} onClick={onDelete} disabled={busy}>
          Delete
        </Button>
        <Button size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" variant="primary" disabled={busy || !draft.name.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}

/**
 * The part of a draft that differs from the row it was opened on — the whole
 * body of the PUT. An empty object means nothing changed, and the caller
 * should close the editor rather than send anything.
 */
export function changedFields(original, draft) {
  const body = {};
  const name = draft.name.trim();
  const slug = draft.slug.trim();
  if (name && name !== original.name) body.name = name;
  if (slug !== original.slug) body.slug = slug;
  return body;
}
