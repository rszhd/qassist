import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button, Modal } from './ui.jsx';

// The CI trigger for one test, module, suite or project (US-008). Everything
// runnable runs from a single authenticated POST, so the dialog is that
// command rather than prose about it: built from this host's origin and the
// row's own slug or id, it pastes into a pipeline as-is.
//
// target: { kind: 'project'|'module'|'suite'|'test', name, project?, module?, id? }
const PATH = {
  project: (t) => `/api/projects/${t.project}/run`,
  module: (t) => `/api/projects/${t.project}/modules/${t.module}/run`,
  suite: (t) => `/api/suites/${t.id}/run`,
  test: (t) => `/api/tests/${t.id}/run`,
};

export default function CiCommand({ target, onClose }) {
  const [copied, setCopied] = useState(false);
  const one = target.kind === 'test';
  const bySlug = target.kind === 'project' || target.kind === 'module';

  const command =
    `curl -X POST ${window.location.origin}${PATH[target.kind](target)} \\\n` +
    `  -H "Authorization: Bearer $WORKER_API_TOKEN" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"trigger":"ci","start_url":"https://preview.example.com"}'`;

  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Modal
      title={`Run "${target.name}" from CI`}
      description={
        one
          ? 'One POST starts this test and answers straight away with its run id.'
          : `One POST starts a run per test in this ${target.kind} and answers straight away with their run ids.`
      }
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon={copied ? Check : Copy} onClick={copy}>
            {copied ? 'Copied' : 'Copy command'}
          </Button>
        </>
      }
    >
      <pre className="ci-code">{command}</pre>
      <p className="hint">
        <code>start_url</code> is optional and{' '}
        {one
          ? 'overrides the saved URL on this test — how a pipeline points it at the deploy it just built; drop it and the test keeps its own.'
          : 'overrides the saved URL for every test in the batch — how a pipeline points them at the deploy it just built; drop it and each test keeps its own.'}{' '}
        Poll <code>GET /api/runs/&lt;runId&gt;</code> for a verdict, or watch the runs land in
        History tagged <code>ci</code>.
        {bySlug
          ? ' The path carries slugs, not ids: renaming is safe here, editing the slug is what a pipeline notices.'
          : ` A ${target.kind} is addressed by id and has no slug, so renaming it never touches this command.`}
      </p>
    </Modal>
  );
}
