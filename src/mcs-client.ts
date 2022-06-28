/* eslint-disable class-methods-use-this */

import EventEmitter from 'events'
import Long from 'long'
import tls from 'tls'
import { promisify } from 'util'

import { mcs_proto } from './protos/mcs'
import MCSParser from './mcs-parser'
import constants from './constants'
import { typeToTag } from './mcs-tags'
import type { MCSDataStore, MCSClientOptions, FCMMessage } from './types'
import type CheckinClient from './checkin-client'

const {
  kMCSVersion,
  kChromeVersion,
  kMCSCategory,
  kGCMFromField,
  kIdleNotification,
  kMaxUnackedIds,
  kDefaultHeartbeatInterval,
} = constants

enum IqExtension {
  SELECTIVE_ACK = 12,
  STREAM_ACK = 13,
}

const HOST = 'mtalk.google.com'
const PORT = 5228
const MAX_RETRY_TIMEOUT = 15
const IS_DEV = process.env.NODE_ENV !== 'production'

declare interface MCSClient {
  on(event: 'connect', listener: () => void): this
  on(event: 'disconnect', listener: () => void): this
  on(event: 'message', listener: (message: FCMMessage) => void): this
  on(event: string, listener: Function): this
}

class MCSClient extends EventEmitter {
  private retryCount: number

  // note that the actual chromium impl has a lot more state:
  // stream_id_in_, stream_id_out_, etc, and uses a much more complex
  // acknowledgement process involving a two-way ack. Since our connection
  // is much more reliable than a spotty mobile network, we simplify things
  // a ton and just maintain a single stream ID. For the real impl (which puts
  // the "reliable" in "reliable message queue"), see
  // https://github.com/chromium/chromium/blob/571b7db2fc1b5e49acbab88daf813a24a64b1b14/google_apis/gcm/engine/mcs_client.cc
  private streamId: number

  private retryTimeout: ReturnType<typeof setTimeout>

  private heartbeatTimeout: ReturnType<typeof setTimeout>

  private waitingForAck: boolean

  private socket: tls.TLSSocket

  private parser: MCSParser

  constructor(private checkinClient: CheckinClient, private dataStore: MCSDataStore, private options: MCSClientOptions = {}) {
    super()
    this.retryCount = 0
    this.streamId = 0
    this.waitingForAck = false
    this.onSocketConnect = this.onSocketConnect.bind(this)
    this.onSocketClose = this.onSocketClose.bind(this)
    this.onSocketError = this.onSocketError.bind(this)
    this.onMessage = this.onMessage.bind(this)
    this.onParserError = this.onParserError.bind(this)
  }

  startListening() {
    this.connect()
    // can happen if the socket immediately closes after being created
    if (!this.socket) return

    this.parser = new MCSParser(this.socket)
    this.parser.on('message', this.onMessage)
    this.parser.on('error', this.onParserError)
  }

  private connect() {
    this.socket = tls.connect(PORT, HOST, { servername: HOST })
    this.socket.setKeepAlive(true)
    this.socket.on('connect', this.onSocketConnect)
    this.socket.on('close', this.onSocketClose)
    this.socket.on('error', this.onSocketError)

    this.write(Buffer.from([kMCSVersion]))

    this.streamId = 0

    this.waitingForAck = false

    this.sendLoginRequest()
  }

  stopListening() {
    if (this.retryTimeout) clearTimeout(this.retryTimeout)
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout)
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

  private buildBuffer(message: any) {
    const tag = typeToTag(message.constructor)
    if (typeof tag !== 'number') throw new Error(`Message has unknown type: ${message.constructor.name}`)
    return Buffer.concat([
      Buffer.from([tag]),
      (message.constructor as any).encodeDelimited(message).finish(),
    ])
  }

  private async write(buffer: Buffer) {
    await promisify(this.socket.write.bind(this.socket))(buffer)
  }

  private async sendMessage(message: any) {
    // eslint-disable-next-line no-param-reassign
    message.lastStreamIdReceived = this.streamId
    console.log('sending message', IS_DEV ? message : message.constructor?.name)
    await this.write(this.buildBuffer(message))
  }

  private async sendLoginRequest() {
    const { androidId, securityToken } = await this.checkinClient.clientInfo()
    const hexAndroidId = Long.fromString(androidId).toString(16)
    await this.sendMessage(new mcs_proto.LoginRequest({
      adaptiveHeartbeat: false,
      authService: mcs_proto.LoginRequest.AuthService.ANDROID_ID,
      authToken: securityToken,
      id: `chrome-${kChromeVersion}`,
      domain: 'mcs.android.com',
      deviceId: `android-${hexAndroidId}`,
      // Chromium`net::NetworkChangeNotifier::CONNECTION_ETHERNET
      networkType: 1,
      resource: androidId,
      user: androidId,
      // reliable message queue
      useRmq2: true,
      setting: [{ name: 'new_vc', value: '1' }],
      clientEvent: [],
      receivedPersistentId: [...await this.dataStore.allPersistentIds()],
    }))
  }

  private async sendHeartbeatPing() {
    await this.sendMessage(new mcs_proto.HeartbeatPing({}))
  }

  private async sendStreamAck() {
    await this.sendMessage(new mcs_proto.IqStanza({
      type: mcs_proto.IqStanza.IqType.SET,
      id: '',
      extension: {
        id: IqExtension.STREAM_ACK,
        data: new Uint8Array(),
      },
    }))
  }

  private onSocketConnect() {
    this.retryCount = 0
    this.emit('connect')
  }

  private onSocketClose() {
    this.emit('disconnect')
    this.resetConnection('socket closed')
  }

  private onSocketError(error: Error) {
    // ignore, the close handler takes care of retry
    console.error(error)
  }

  private onParserError(error: Error) {
    console.error(error)
    this.resetConnection('parser error')
  }

  private resetConnection(reason: string) {
    console.log('resetting connection', reason)
    this.stopListening()
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout)
    const timeout = Math.min(++this.retryCount, MAX_RETRY_TIMEOUT) * 1000
    this.retryTimeout = setTimeout(this.startListening.bind(this), timeout)
  }

  private heartbeatTriggered() {
    if (this.waitingForAck) {
      this.resetConnection('heartbeat failed')
      return
    }
    this.sendHeartbeatPing()
    this.waitingForAck = true
    this.resetHeartbeatTimer()
  }

  private onHeartbeatAcked() {
    this.waitingForAck = false
    this.resetHeartbeatTimer()
  }

  private resetHeartbeatTimer() {
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout)
    this.heartbeatTimeout = setTimeout(this.heartbeatTriggered.bind(this), kDefaultHeartbeatInterval * 1000)
  }

  private async onMessage(object: any
  | mcs_proto.LoginResponse
  | mcs_proto.DataMessageStanza
  | mcs_proto.HeartbeatPing
  | mcs_proto.HeartbeatAck
  | mcs_proto.Close
  | mcs_proto.IqStanza) {
    console.log('received message', IS_DEV ? object : object.constructor?.name)

    ++this.streamId

    // TODO: given the likely large volume of notifs we'll be processing, maybe
    // we should debounce the decision to ack, or make it entirely time-based?

    // clearPersistentIds and addPersistentId have to be the first `await`s
    // because that ensures that if onMessage(a) is called before onMessage(b)
    // then the appropriate clear/add action for `a` will occur before that of `b`
    if (this.streamId % kMaxUnackedIds === 0) {
      await this.dataStore.clearPersistentIds()
      await this.sendStreamAck()
    } else if (object.persistentId) {
      // Maintain persistentIds updated with the very last received value
      await this.dataStore.addPersistentId(object.persistentId)
    }

    // every message acts as a heartbeat ack, since all we want to know is
    // that the connection isn't dead
    this.onHeartbeatAcked()

    if (object instanceof mcs_proto.LoginResponse) {
      this.streamId = 1
      // clear persistent ids, as we just sent them to the server while logging
      // in
      await this.dataStore.clearPersistentIds()
    } else if (object instanceof mcs_proto.DataMessageStanza) {
      await this.onDataMessage(object)
    } else if (object instanceof mcs_proto.HeartbeatPing) {
      await this.sendMessage(new mcs_proto.HeartbeatAck())
    } else if (object instanceof mcs_proto.HeartbeatAck) {
      // we've already called onHeartbeatAcked, do nothing special here
    } else if (object instanceof mcs_proto.Close) {
      this.resetConnection('mcs requested close')
    } else if (object instanceof mcs_proto.IqStanza) {
      switch (object.extension.id) {
        case IqExtension.SELECTIVE_ACK:
          this.handleSelectiveAck(mcs_proto.SelectiveAck.decode(object.extension.data).id)
          break
        case IqExtension.STREAM_ACK:
          // we always process the last stream id, do nothing extra
          break
        default:
          console.log('invalid iq extension', object.extension.id)
          break
      }
    } else {
      console.log('unhandled message', object.constructor.name)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleSelectiveAck(persistentIds: string[]) {
    // Do nothing for now, we don't do (persistent) outgoing messages
  }

  private async onDataMessage(msg: mcs_proto.DataMessageStanza) {
    if (msg.category === kMCSCategory) {
      this.handleMCSDataMessage(msg)
      return
    }
    this.emit('message', msg)
  }

  private async handleMCSDataMessage(msg: mcs_proto.DataMessageStanza) {
    if (!msg.appData.find(data => data.key === kIdleNotification)) {
      console.log('Unhandled MCS message (not an IdleNotification)', msg)
      return
    }
    const dataMessage = new mcs_proto.DataMessageStanza({
      from: kGCMFromField,
      category: kMCSCategory,
      sent: Date.now() / 1000,
      ttl: 0,
      appData: [{ key: kIdleNotification, value: 'false' }],
    })
    await this.sendMessage(dataMessage)
  }
}

export default MCSClient
