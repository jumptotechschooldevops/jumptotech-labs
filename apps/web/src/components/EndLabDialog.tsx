/**
 * End Lab confirmation.
 *
 * Ending a lab deletes the namespace and everything in it, and unlike Reset it
 * cannot be undone — so it is behind an explicit confirmation, as the story
 * requires.
 */
export function EndLabDialog({
  open,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;

  return (
    <div className="modal__backdrop" role="presentation" onClick={busy ? undefined : onCancel}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="end-lab-title"
        aria-describedby="end-lab-body"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="end-lab-title" className="modal__title">
          End this lab?
        </h2>
        <p id="end-lab-body" className="modal__body">
          Your temporary lab environment will be deleted.
          <br />
          This action cannot be undone.
        </p>
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Ending…' : 'End Lab'}
          </button>
        </div>
      </div>
    </div>
  );
}
