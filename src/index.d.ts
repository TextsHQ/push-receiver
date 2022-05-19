import { EventEmitter } from "events";

interface ClientOptions {
  // the period with which to check in
  checkInInterval?: number
}

interface RegisterOptions {
  // specify an existing app id (before expiry) to renew its subscription
  appId?: string
  // how long the token lasts, in seconds
  ttl?: number
}

type RegisterResult = {
  endpoint: string
  appId: string
  expiry: Date
}

interface ClientInfo {
  androidId: string
  securityToken: string
  instanceId: string
}

interface CustomDataStore {
  get clientInfo(): ClientInfo | null
  set clientInfo(newValue: ClientInfo)
  allPersistentIds(): string[]
  clearPersistentIds(): void
  hasPersistentId(id: string): boolean
  addPersistentId(id: string): void
}

// file path (to use disk) or a custom store
type DataStore = string | CustomDataStore

type Notification = {
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

export = class Client extends EventEmitter {
  constructor(dataStore: DataStore, options?: ClientOptions)
  startListening(): void
  stopListening(): void
  async register(authorizedEntity: string, options?: RegisterOptions): Promise<RegisterResult>

  on(event: 'connect', listener: () => void): this
  on(event: 'disconnect', listener: () => void): this
  on(event: 'notification', listener: (notification: Notification) => void): this
  on(event: string, listener: Function): this
}
