export type Awaitable<T> = T | PromiseLike<T>

export interface ClientOptions {
  // the period with which to check in
  checkInInterval?: number
}

export interface RegisterOptions {
  // specify an existing app id (before expiry) to renew its subscription
  appId?: string
  instanceId?: string
  // how long the token lasts, in seconds
  ttl?: number

  wpAppIdPrefix: string
  androidAppIdPrefix: string
}

export type RegisterResult = {
  token: string
  appId: string
  instanceId: string
  expiry: Date
}

export interface ClientInfo {
  androidId: string
  securityToken: string
}

export interface DataStore {
  get clientInfo(): ClientInfo | null
  set clientInfo(newValue: ClientInfo)

  allPersistentIds(): Awaitable<string[]>
  clearPersistentIds(): Awaitable<void>
  hasPersistentId(id: string): Awaitable<boolean>
  addPersistentId(id: string): Awaitable<void>
}

export type Notification = {
  // This is the message ID, set by client.
  id?: string
  // applicationServerKey of the sender.
  from: string
  // appId
  category: string
  // User data + GOOGLE. prefixed special entries.
  appData: { key: string, value: string }[]
  // Part of the ACK protocol, returned in DataMessageResponse on server side.
  // It's part of the key of DMP.
  persistentId?: string
  // Time to live, in seconds.
  ttl?: number
  // Timestamp ( according to client ) when message was sent by app, in seconds.
  sent?: string
  // Optional field containing the binary payload of the message.
  rawData?: Buffer
}
