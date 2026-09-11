/**
 * Real app capabilities exposed to plugins through the registry's
 * permission gate (PluginContext.getCapability).
 *
 * Only capabilities with a genuine backing are registered here. A plugin
 * declaring an unregistered permission receives null — never a stub.
 */

import { Notification } from 'electron'
import { registerAppCapability } from './plugin-registry'
import type { DomainEvent, EventStore } from '../events/event-store'

export type CapabilityEventStore = Pick<EventStore, 'append' | 'query'>

export interface NotificationOptions {
  title?: string
  body?: string
}

export function registerPluginCapabilities(eventStore: CapabilityEventStore): void {
  registerAppCapability('notification', (options: NotificationOptions = {}) => {
    if (!Notification.isSupported()) return false
    new Notification({
      title: String(options.title ?? 'donwells'),
      body: String(options.body ?? '')
    }).show()
    return true
  })

  registerAppCapability('event-store', {
    append: (event: DomainEvent) => eventStore.append(event),
    query: (filter?: { sessionId?: string; type?: string; since?: number }) =>
      eventStore.query(filter ?? {})
  })
}
