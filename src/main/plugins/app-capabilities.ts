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
import type { DaemonClient } from '../daemon-client'
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
/**
 * Register only projection/intent methods. Worker credentials and lease tokens
 * never cross the plugin boundary; the daemon authenticates this app session
 * as an administrator and enforces the capability at plugin activation.
 */
export function registerTaskAuthorityCapability(daemon: Pick<DaemonClient, 'taskQuery' | 'taskCreate' | 'taskUpdate' | 'taskCancel'>): void {
  registerAppCapability('task-authority', {
    query: (input?: Parameters<DaemonClient['taskQuery']>[0]) => daemon.taskQuery(input ?? {}),
    create: (input: Parameters<DaemonClient['taskCreate']>[0]) => daemon.taskCreate(input),
    update: (input: Parameters<DaemonClient['taskUpdate']>[0]) => daemon.taskUpdate(input),
    cancel: (input: Parameters<DaemonClient['taskCancel']>[0]) => daemon.taskCancel(input)
  })
}
