import {
  DESIGN_CAPTURE_BUDGET,
  DESIGN_CAPTURE_STYLE_NAMES,
  type DesignCapture,
  type DesignCaptureScreenshot
} from '@shared/design-capture'
import { Icon } from './Icon'
import './DesignCapturePanel.css'

type DesignCapturePanelProps = {
  capture: DesignCapture
  screenshot: DesignCaptureScreenshot | null
  screenshotPending: boolean
  note: string
  onNoteChange(note: string): void
  onClear(): void
  onReselect(): void
  onAttach(): void
}

function formatBounds({ x, y, width, height }: DesignCapture['bounds']['viewport']): string {
  return `${Math.round(width)} × ${Math.round(height)} at ${Math.round(x)}, ${Math.round(y)}`
}

export function DesignCapturePanel({
  capture,
  screenshot,
  screenshotPending,
  note,
  onNoteChange,
  onClear,
  onReselect,
  onAttach
}: DesignCapturePanelProps) {
  return (
    <aside className="design-capture-panel" aria-label="Design capture review">
      <header className="design-capture-header">
        <div>
          <span className="design-capture-eyebrow">Design Mode</span>
          <h2>Review capture</h2>
        </div>
        <button className="icon-btn design-capture-close" type="button" aria-label="Clear capture" title="Clear capture" onClick={onClear}>
          <Icon name="x" size={14} />
        </button>
      </header>

      <div className="design-capture-security" role="note">
        <Icon name="alert" size={14} />
        <span>Page content is untrusted. Sensitive fields, editable content, query strings, and active markup are excluded.</span>
      </div>

      <section className="design-capture-section" aria-labelledby="design-capture-page-heading">
        <h3 id="design-capture-page-heading">Page</h3>
        <dl className="design-capture-facts">
          <div><dt>Title</dt><dd>{capture.title || 'Untitled page'}</dd></div>
          <div><dt>URL</dt><dd className="mono">{capture.url}</dd></div>
        </dl>
      </section>

      <section className="design-capture-section" aria-labelledby="design-capture-element-heading">
        <h3 id="design-capture-element-heading">Selected element</h3>
        <div className="design-capture-tags">
          <span className="design-capture-tag">&lt;{capture.tag}&gt;</span>
          {capture.role ? <span className="design-capture-role">role={capture.role}</span> : null}
          <span>{formatBounds(capture.bounds.viewport)}</span>
        </div>
        <dl className="design-capture-facts">
          <div><dt>Selector</dt><dd className="mono">{capture.selector}</dd></div>
          <div><dt>Visible text</dt><dd>{capture.text || 'No visible text'}</dd></div>
        </dl>
      </section>

      <section className="design-capture-section" aria-labelledby="design-capture-screenshot-heading">
        <div className="design-capture-section-heading">
          <h3 id="design-capture-screenshot-heading">Cropped screenshot</h3>
          <span className="design-capture-preview-badge">Preview only</span>
        </div>
        {screenshotPending ? (
          <div className="design-capture-no-image" role="status">Capturing a bounded preview…</div>
        ) : screenshot ? (
          <figure className="design-capture-figure">
            <img src={screenshot.dataUrl} alt={`Captured ${capture.tag} element preview`} />
            <figcaption>{screenshot.width} × {screenshot.height}px · Image is not transmitted</figcaption>
          </figure>
        ) : (
          <div className="design-capture-no-image">Screenshot unavailable. The bounded text capture can still be attached.</div>
        )}
      </section>

      <details className="design-capture-details">
        <summary>Computed CSS</summary>
        <dl className="design-capture-styles">
          {DESIGN_CAPTURE_STYLE_NAMES.map((name) => capture.styles[name] ? (
            <div key={name}><dt>{name}</dt><dd>{capture.styles[name]}</dd></div>
          ) : null)}
        </dl>
      </details>

      <details className="design-capture-details">
        <summary>Sanitized DOM snippet</summary>
        <pre>{capture.domSnippet || '<!-- no safe markup captured -->'}</pre>
      </details>

      <label className="design-capture-note">
        <span>Your note <small>{note.length}/{DESIGN_CAPTURE_BUDGET.userNote}</small></span>
        <textarea
          value={note}
          maxLength={DESIGN_CAPTURE_BUDGET.userNote}
          rows={3}
          placeholder="What should the agent change or inspect?"
          onChange={(event) => onNoteChange(event.target.value)}
        />
      </label>

      <footer className="design-capture-actions">
        <button className="btn btn-secondary btn-sm" type="button" onClick={onReselect}>
          <Icon name="refresh" size={14} />
          Reselect
        </button>
        <button className="btn btn-primary btn-sm" type="button" onClick={onAttach}>
          <Icon name="robot" size={14} />
          Attach to agent…
        </button>
      </footer>
    </aside>
  )
}
