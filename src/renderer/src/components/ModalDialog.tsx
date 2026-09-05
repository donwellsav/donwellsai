import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'

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
    return () => dialog.close()
  }, [])

  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault()
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
