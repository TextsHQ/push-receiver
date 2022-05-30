/* eslint-disable class-methods-use-this */

import EventEmitter from 'events'
import Long from 'long'
import tls from 'tls'
import { mcs_proto } from './protos/mcs'

import MCSParser from './mcs-parser'
import constants from './constants'
import { typeToTag } from './mcs-tags'
import type { MCSDataStore, MCSClientOptions, FCMMessage } from './types'
import type CheckinClient from './checkin-client'

const {
  kMCSVersion,
  kChromeVersion,
} = constants

const HOST = 'mtalk.google.com'
const PORT = 5228
const MAX_RETRY_TIMEOUT = 15

declare interface MCSClient {
  on(event: 'connect', listener: () => void): this
  on(event: 'disconnect', listener: () => void): this
  on(event: 'message', listener: (message: FCMMessage) => void): this
  on(event: string, listener: Function): this
}

class MCSClient extends EventEmitter {
  private retryCount: number

  private retryTimeout: ReturnType<typeof setTimeout>

  private socket: tls.TLSSocket

  private parser: MCSParser

  constructor(private checkinClient: CheckinClient, private dataStore: MCSDataStore, private options: MCSClientOptions = {}) {
    super()
    this.retryCount = 0
    this.onSocketConnect = this.onSocketConnect.bind(this)
    this.onSocketClose = this.onSocketClose.bind(this)
    this.onSocketError = this.onSocketError.bind(this)
    this.onMessage = this.onMessage.bind(this)
    this.onParserError = this.onParserError.bind(this)
  }

  async startListening() {
    // TODO: Implement heartbeat
    // https://github.com/chromium/chromium/blob/8ff502b4d8b0b85fd4cda215cce617ea4a3c29a6/google_apis/gcm/engine/heartbeat_manager.cc

    await this._connect()
    // can happen if the socket immediately closes after being created
    if (!this.socket) {
      return
    }
    // can happen if the socket immediately closes after being created
    if (!this.socket) {
      return
    }
    this.parser = new MCSParser(this.socket)
    this.parser.on('message', this.onMessage)
    this.parser.on('error', this.onParserError)
  }

  async _connect() {
    this.socket = tls.connect(PORT, HOST, { servername: HOST })
    this.socket.setKeepAlive(true)
    this.socket.on('connect', this.onSocketConnect)
    this.socket.on('close', this.onSocketClose)
    this.socket.on('error', this.onSocketError)
    this.socket.write(await this.loginBuffer())
  }

  stopListening() {
    clearTimeout(this.retryTimeout)
    if (this.socket) {
      this.socket.removeListener('connect', this.onSocketConnect)
      this.socket.removeListener('close', this.onSocketClose)
      this.socket.removeListener('error', this.onSocketError)
      this.socket.destroy()
      this.socket = null
    }
    if (this.parser) {
      this.parser.removeListener('message', this.onMessage)
      this.parser.removeListener('error', this.onParserError)
      this.parser.destroy()
      this.parser = null
    }
  }

  private async loginBuffer() {
    const clientInfo = await this.checkinClient.clientInfo()
    const hexAndroidId = Long.fromString(clientInfo.androidId).toString(16)
    const loginRequest = new mcs_proto.LoginRequest({
      adaptiveHeartbeat: false,
      authService: mcs_proto.LoginRequest.AuthService.ANDROID_ID,
      authToken: clientInfo.securityToken,
      id: `chrome-${kChromeVersion}`,
      domain: 'mcs.android.com',
      deviceId: `android-${hexAndroidId}`,
      // Chromium`net::NetworkChangeNotifier::CONNECTION_ETHERNET
      networkType: 1,
      resource: clientInfo.androidId,
      user: clientInfo.androidId,
      useRmq2: true,
      setting: [{ name: 'new_vc', value: '1' }],
      // Id of the last notification received
      clientEvent: [],
      receivedPersistentId: [...await this.dataStore.allPersistentIds()],
    })

    const buffer = mcs_proto.LoginRequest.encodeDelimited(loginRequest).finish()

    return Buffer.concat([
      Buffer.from([kMCSVersion, typeToTag(mcs_proto.LoginRequest)]),
      buffer,
    ])
  }

  private onSocketConnect() {
    this.retryCount = 0
    this.emit('connect')
  }

  private onSocketClose() {
    this.emit('disconnect')
    this.retry()
  }

  private onSocketError(error: Error) {
    // ignore, the close handler takes care of retry
    console.error(error)
  }

  private onParserError(error: Error) {
    console.error(error)
    this.retry()
  }

  private retry() {
    this.stopListening()
    const timeout = Math.min(++this.retryCount, MAX_RETRY_TIMEOUT) * 1000
    this.retryTimeout = setTimeout(this.startListening.bind(this), timeout)
  }

  private async onMessage(object) {
    if (object instanceof mcs_proto.LoginResponse) {
      // clear persistent ids, as we just sent them to the server while logging
      // in
      await this.dataStore.clearPersistentIds()
    } else if (object instanceof mcs_proto.DataMessageStanza) {
      await this.onDataMessage(object)
    } else {
      console.log('received message', object)
    }
  }

  private async onDataMessage(msg: mcs_proto.DataMessageStanza) {
    if (await this.dataStore.hasPersistentId(msg.persistentId)) {
      return
    }
    // Maintain persistentIds updated with the very last received value
    await this.dataStore.addPersistentId(msg.persistentId)
    // Send message
    this.emit('message', msg)
  }
}

export default MCSClient
