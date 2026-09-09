import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { focusPaneTarget } from '../navigation-controller'

type Props = {
  labelledBy: string
  className?: string
  onClose(): void
  children: ReactNode
}

export function ModalDialog({ labelledBy, className = 'modal', onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    dialog.showModal()
    return () => { dialog.close(); void focusPaneTarget() }
  }, [])

  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault()
        const activeElement = event.currentTarget.ownerDocument.activeElement
        if (activeElement instanceof HTMLSelectElement && activeElement.matches(':open')) {
          activeElement.blur()
          activeElement.focus()
          return
        }
        onClose()
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
      }}
    >
      {children}
    </dialog>
  )
}
