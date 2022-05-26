import EventEmitter from 'events'
import Long from 'long'
import path from 'path'
import tls from 'tls'
import { load } from 'protobufjs'

import Parser from './parser'
import constants from './constants'
import { checkIn, register } from './gcm'
import FileStore from './file-store'
import type { DataStore, ClientOptions, RegisterOptions, RegisterResult } from './types'

const {
  kMCSVersion,
  kChromeVersion,
  kMinimumCheckinInterval,
  kDefaultCheckinInterval,
  kLoginRequestTag,
  kDataMessageStanzaTag,
  kLoginResponseTag,
} = constants

const HOST = 'mtalk.google.com'
const PORT = 5228
const MAX_RETRY_TIMEOUT = 15

let proto = null

declare interface Client {
  on(event: 'connect', listener: () => void): this
  on(event: 'disconnect', listener: () => void): this
  on(event: 'notification', listener: (notification: Notification) => void): this
  on(event: string, listener: Function): this
}

class Client extends EventEmitter {
  _dataStorePath: string

  _retryCount: number

  _checkInInterval: number

  _retryTimeout: ReturnType<typeof setTimeout>

  _checkInHandle: ReturnType<typeof setInterval>

  _socket: tls.TLSSocket

  _parser: Parser

  _initPromise: Promise<void>

  _dataStore

  static async _init() {
    if (proto) {
      return
    }
    proto = await load(path.resolve(__dirname, 'mcs.proto'))
  }

  // pass a string as dataStore to use file-backed storage at that path
  constructor(dataStore: DataStore, options: ClientOptions = {}) {
    super()
    if (typeof dataStore === 'string') {
      this._dataStorePath = dataStore
    } else if (typeof dataStore === 'object') {
      this._dataStore = dataStore
    } else {
      throw new Error('dataStore must be a string or an object')
    }
    this._retryCount = 0
    this._onSocketConnect = this._onSocketConnect.bind(this)
    this._onSocketClose = this._onSocketClose.bind(this)
    this._onSocketError = this._onSocketError.bind(this)
    this._onMessage = this._onMessage.bind(this)
    this._onParserError = this._onParserError.bind(this)
    this._checkInInterval = typeof options.checkInInterval === 'number'
      ? Math.max(options.checkInInterval, kMinimumCheckinInterval)
      : kDefaultCheckinInterval
  }

  async _doInit() {
    await Client._init()
    if (this._dataStorePath) {
      this._dataStore = await FileStore.create(this._dataStorePath)
    }
    this._checkInHandle = setInterval(() => {
      this._checkIn()
    }, this._checkInInterval * 1000)
    this._checkInHandle.unref()
    await this._checkIn()
  }

  async _ensureInit() {
    if (this._initPromise) {
      await this._initPromise
      return
    }
    this._initPromise = this._doInit()
    return this._initPromise
  }

  async _startListening() {
    await this._ensureInit()

    // TODO: Implement heartbeat?
    // https://github.com/chromium/chromium/blob/8ff502b4d8b0b85fd4cda215cce617ea4a3c29a6/google_apis/gcm/engine/heartbeat_manager.cc

    this._connect()
    // can happen if the socket immediately closes after being created
    if (!this._socket) {
      return
    }
    await Parser.init()
    // can happen if the socket immediately closes after being created
    if (!this._socket) {
      return
    }
    this._parser = new Parser(this._socket)
    this._parser.on('message', this._onMessage)
    this._parser.on('error', this._onParserError)
  }

  startListening(): void {
    this._startListening()
  }

  stopListening(): void {
    this._stopListening()
  }

  // pass { appId: <existing app id> } to renew
  // you don't need to startListening() for this
  async register(type: 'web' | 'android', authorizedEntity: string, options?: RegisterOptions): Promise<RegisterResult> {
    await this._ensureInit()
    return register(this._dataStore.clientInfo, type, authorizedEntity, options)
  }

  async _checkIn() {
    this._dataStore.clientInfo = await checkIn(this._dataStore.clientInfo)
  }

  _connect() {
    this._socket = tls.connect(PORT, HOST, { servername: HOST })
    this._socket.setKeepAlive(true)
    this._socket.on('connect', this._onSocketConnect)
    this._socket.on('close', this._onSocketClose)
    this._socket.on('error', this._onSocketError)
    this._socket.write(this._loginBuffer())
  }

  _stopListening() {
    clearTimeout(this._retryTimeout)
    if (this._socket) {
      this._socket.removeListener('connect', this._onSocketConnect)
      this._socket.removeListener('close', this._onSocketClose)
      this._socket.removeListener('error', this._onSocketError)
      this._socket.destroy()
      this._socket = null
    }
    if (this._parser) {
      this._parser.removeListener('message', this._onMessage)
      this._parser.removeListener('error', this._onParserError)
      this._parser.destroy()
      this._parser = null
    }
  }

  _loginBuffer() {
    const LoginRequestType = proto.lookupType('mcs_proto.LoginRequest')
    const hexAndroidId = Long.fromString(
      this._dataStore.clientInfo.androidId,
    ).toString(16)
    const loginRequest = {
      adaptiveHeartbeat: false,
      authService: 2,
      authToken: this._dataStore.clientInfo.securityToken,
      id: `chrome-${kChromeVersion}`,
      domain: 'mcs.android.com',
      deviceId: `android-${hexAndroidId}`,
      networkType: 1,
      resource: this._dataStore.clientInfo.androidId,
      user: this._dataStore.clientInfo.androidId,
      useRmq2: true,
      setting: [{ name: 'new_vc', value: '1' }],
      // Id of the last notification received
      clientEvent: [],
      receivedPersistentId: this._dataStore.allPersistentIds(),
    }

    const errorMessage = LoginRequestType.verify(loginRequest)
    if (errorMessage) {
      throw new Error(errorMessage)
    }

    const buffer = LoginRequestType.encodeDelimited(loginRequest).finish()

    return Buffer.concat([
      Buffer.from([kMCSVersion, kLoginRequestTag]),
      buffer,
    ])
  }

  _onSocketConnect() {
    this._retryCount = 0
    this.emit('connect')
  }

  _onSocketClose() {
    this.emit('disconnect')
    this._retry()
  }

  _onSocketError(error) {
    // ignore, the close handler takes care of retry
    error
  }

  _onParserError(error) {
    error
    this._retry()
  }

  _retry() {
    this._stopListening()
    const timeout = Math.min(++this._retryCount, MAX_RETRY_TIMEOUT) * 1000
    this._retryTimeout = setTimeout(this.startListening.bind(this), timeout)
  }

  _onMessage({ tag, object }) {
    if (tag === kLoginResponseTag) {
      // clear persistent ids, as we just sent them to the server while logging
      // in
      this._dataStore.clearPersistentIds()
    } else if (tag === kDataMessageStanzaTag) {
      this._onDataMessage(object)
    }
  }

  _onDataMessage(object) {
    if (this._dataStore.hasPersistentId(object.persistentId)) {
      return
    }
    // Maintain persistentIds updated with the very last received value
    this._dataStore.addPersistentId(object.persistentId)
    // Send notification
    this.emit('notification', object)
  }
}

export default Client
