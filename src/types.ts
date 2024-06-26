import type { mcs_proto } from './protos/mcs'

export type Awaitable<T> = T | PromiseLike<T>

export interface CheckinClientOptions {
  // the period with which to check in
  checkInInterval?: number
}

export interface MCSClientOptions {}

export interface GCMRegistrarOptions {}

export type AppInfo = {
  appId: string
  instanceId: string
}

export type RegisterOptions = {
  // specify an existing app (before expiry) to renew its subscription
  app?: AppInfo
  expiry?: Date
}

export type RegisterResult = {
  app: AppInfo
  expiry: Date
  token: string
}

export interface ClientInfo {
  androidId: string
  securityToken: string
}

export interface CheckinDataStore {
  get clientInfo(): ClientInfo | null
  set clientInfo(newValue: ClientInfo)
}

// must be atomic and serial.
// if `clear` then `add` called, the net result should be
// one id in the store
export interface MCSDataStore {
  allPersistentIds(): Awaitable<Iterable<string>>
  clearPersistentIds(): Awaitable<void>
  hasPersistentId(id: string): Awaitable<boolean>
  addPersistentId(id: string): Awaitable<void>
}

export type FCMMessage = mcs_proto.IDataMessageStanza
