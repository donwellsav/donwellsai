import { useEffect, useMemo, useRef, useState } from 'react'
import {
  projectCreationTargetPath,
  validateProjectCreationRequest,
  validateProjectName,
  validateProjectParentPath
} from '@shared/project-creation'
import { closeProjectSetup, useProjectSetup } from '../project-setup'
import { useAppStore } from '../store'
import { Icon } from './Icon'
import { ModalDialog } from './ModalDialog'
import './project-setup.css'

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function ProjectSetupDialog() {
  const open = useProjectSetup((state) => state.open)
  const preferredParentPath = useProjectSetup((state) => state.preferredParentPath)
  const openSequence = useProjectSetup((state) => state.openSequence)
  const [name, setName] = useState('')
  const [parentPath, setParentPath] = useState('')
  const [initializeGit, setInitializeGit] = useState(true)
  const [busy, setBusy] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [nameTouched, setNameTouched] = useState(false)
  const [locationTouched, setLocationTouched] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const defaultsGeneration = useRef(0)
  const parentPathRef = useRef(parentPath)

  useEffect(() => {
    parentPathRef.current = parentPath
  }, [parentPath])

  useEffect(() => {
    const generation = ++defaultsGeneration.current
    if (!open) return
    setSubmitError(null)
    if (preferredParentPath) {
      parentPathRef.current = preferredParentPath
      setParentPath(preferredParentPath)
      return
    }
    if (parentPathRef.current) return
    void window.donwells.getProjectCreationDefaults().then((defaults) => {
      if (defaultsGeneration.current === generation) {
        setParentPath((current) => current || defaults.parentPath)
      }
    }).catch((cause: unknown) => {
      if (defaultsGeneration.current === generation) {
        setSubmitError(`Could not load the default project location. ${errorMessage(cause)}`)
      }
    })
  }, [open, openSequence, preferredParentPath])

  const nameError = useMemo(() => validateProjectName(name), [name])
  const locationError = useMemo(() => validateProjectParentPath(parentPath), [parentPath])
  const targetPath = useMemo(
    () => name && parentPath ? projectCreationTargetPath(parentPath, name) : '',
    [name, parentPath]
  )
  const disabled = busy || browsing
  const close = (): void => {
    if (!disabled) closeProjectSetup()
  }
  const browse = async (): Promise<void> => {
    if (disabled) return
    setBrowsing(true)
    setSubmitError(null)
    try {
      const directory = await window.donwells.pickDirectory()
      if (directory) {
        setParentPath(directory)
        setLocationTouched(true)
      }
    } catch (cause) {
      setSubmitError(`Could not open the folder browser. ${errorMessage(cause)}`)
    } finally {
      setBrowsing(false)
    }
  }
  const submit = async (): Promise<void> => {
    if (disabled) return
    setSubmitted(true)
    setNameTouched(true)
    setLocationTouched(true)
    const validation = validateProjectCreationRequest({ parentPath, name, initializeGit })
    if (!validation.ok) return

    setBusy(true)
    setSubmitError(null)
    try {
      const summary = await window.donwells.createProject(validation.request)
      const store = useAppStore.getState()
      store.openProject(summary)
      store.setRightSidebarTab('explorer')
      store.setRightSidebarOpen(true)
      setName('')
      setInitializeGit(true)
      setSubmitted(false)
      setNameTouched(false)
      setLocationTouched(false)
      closeProjectSetup()
    } catch (cause) {
      setSubmitError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null
  const showNameError = (nameTouched || submitted) && nameError
  const showLocationError = (locationTouched || submitted) && locationError
  const describedBy = [
    showNameError ? 'project-setup-name-error' : null,
    showLocationError ? 'project-setup-location-error' : null,
    submitError ? 'project-setup-submit-error' : null
  ].filter(Boolean).join(' ') || undefined

  return (
    <ModalDialog labelledBy="project-setup-title" className="modal project-setup-dialog" onClose={close}>
      <form className="project-setup-form" onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}>
        <header className="project-setup-header">
          <div className="project-setup-mark"><Icon name="dir" size={17} /></div>
          <div>
            <p className="project-setup-kicker">New project</p>
            <h2 id="project-setup-title">Create a local project</h2>
            <p>Start with a new empty folder. You can add files, open a terminal, and connect tools after creation.</p>
          </div>
        </header>

        <div className="project-setup-fields">
          <div className="project-setup-field">
            <label htmlFor="project-setup-name">Project name</label>
            <input
              id="project-setup-name"
              className="input"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="my-project"
              value={name}
              disabled={disabled}
              aria-invalid={Boolean(showNameError)}
              aria-describedby={showNameError ? 'project-setup-name-error' : undefined}
              onBlur={() => setNameTouched(true)}
              onChange={(event) => {
                setName(event.target.value)
                setSubmitError(null)
              }}
            />
            {showNameError && <p id="project-setup-name-error" className="project-setup-field-error">{nameError}</p>}
          </div>

          <div className="project-setup-field">
            <label htmlFor="project-setup-location">Location</label>
            <div className="project-setup-location-row">
              <input
                id="project-setup-location"
                className="input"
                autoComplete="off"
                spellCheck={false}
                placeholder="Choose a parent folder"
                value={parentPath}
                disabled={disabled}
                aria-invalid={Boolean(showLocationError)}
                aria-describedby={showLocationError ? 'project-setup-location-error' : undefined}
                onBlur={() => setLocationTouched(true)}
                onChange={(event) => {
                  setParentPath(event.target.value)
                  setSubmitError(null)
                }}
              />
              <button className="btn btn-secondary project-setup-browse" type="button" disabled={disabled} onClick={() => void browse()}>
                <Icon name="dir" size={14} />
                {browsing ? 'Choosing…' : 'Browse'}
              </button>
            </div>
            {showLocationError && <p id="project-setup-location-error" className="project-setup-field-error">{locationError}</p>}
          </div>
        </div>

        <div className="project-setup-result" aria-live="polite">
          <span>Project will be created at</span>
          <code>{targetPath || 'Choose a name and location'}</code>
        </div>

        <label className="project-setup-git-option">
          <input
            type="checkbox"
            checked={initializeGit}
            disabled={disabled}
            onChange={(event) => {
              setInitializeGit(event.target.checked)
              setSubmitError(null)
            }}
          />
          <span>
            <strong>Initialize a Git repository</strong>
            <small>Creates an empty repository on the <code>main</code> branch. No commit or Git identity is required.</small>
          </span>
        </label>

        {submitError && (
          <div id="project-setup-submit-error" className="project-setup-submit-error" role="alert">
            <Icon name="alert" size={15} />
            <span>{submitError}</span>
          </div>
        )}

        <footer className="project-setup-actions">
          <p id="project-setup-progress" aria-live="polite">{busy ? `Creating ${targetPath}…` : 'The new folder is never merged with or written over an existing path.'}</p>
          <div>
            <button className="btn btn-secondary" type="button" disabled={disabled} onClick={close}>Cancel</button>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={disabled || Boolean(nameError) || Boolean(locationError)}
              aria-describedby={describedBy ?? 'project-setup-progress'}
            >
              {busy ? 'Creating project…' : 'Create project'}
            </button>
          </div>
        </footer>
      </form>
    </ModalDialog>
  )
}
