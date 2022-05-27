import EventEmitter from 'events'
import { BufferReader } from 'protobufjs'
import type tls from 'tls'

import constants from './constants'
import { mcs_proto } from './protos/mcs'

const {
  MCS_VERSION_TAG_AND_SIZE,
  MCS_TAG_AND_SIZE,
  MCS_SIZE,
  MCS_PROTO_BYTES,

  kVersionPacketLen,
  kTagPacketLen,
  kSizePacketLenMin,
  kMCSVersion,

  kHeartbeatPingTag,
  kHeartbeatAckTag,
  kLoginRequestTag,
  kLoginResponseTag,
  kCloseTag,
  kIqStanzaTag,
  kDataMessageStanzaTag,
  kStreamErrorStanzaTag,
} = constants

const DEBUG = process.env.DEBUG ? console.log : () => {}

// Parser parses wire data from gcm.
// This takes the role of WaitForData in the chromium connection handler.
//
// The main differences from the chromium implementation are:
// - Did not use a max packet length (kDefaultDataPacketLimit), instead we just
//   buffer data in this._data
// - Error handling around protobufs
// - Setting timeouts while waiting for data
//
// ref: https://cs.chromium.org/chromium/src/google_apis/gcm/engine/connection_handler_impl.cc?rcl=dc7c41bc0ee5fee0ed269495dde6b8c40df43e40&l=178
export default class Parser extends EventEmitter {
  _socket: tls.TLSSocket

  _state: number

  _data: Buffer

  _sizePacketSoFar: number

  _messageTag: number

  _messageSize: number

  _handshakeComplete

  _isWaitingForData

  constructor(socket: tls.TLSSocket) {
    super()
    this._socket = socket
    this._state = MCS_VERSION_TAG_AND_SIZE
    this._data = Buffer.alloc(0)
    this._sizePacketSoFar = 0
    this._messageTag = 0
    this._messageSize = 0
    this._handshakeComplete = false
    this._isWaitingForData = true
    this._onData = this._onData.bind(this)
    this._socket.on('data', this._onData)
  }

  destroy() {
    this._isWaitingForData = false
    this._socket.removeListener('data', this._onData)
  }

  _emitError(error: Error) {
    this.destroy()
    this.emit('error', error)
  }

  _onData(buffer: Buffer) {
    DEBUG(`Got data: ${buffer.length}`)
    this._data = Buffer.concat([this._data, buffer])
    if (this._isWaitingForData) {
      this._isWaitingForData = false
      this._waitForData()
    }
  }

  _waitForData() {
    DEBUG(`waitForData state: ${this._state}`)

    let minBytesNeeded = 0

    switch (this._state) {
      case MCS_VERSION_TAG_AND_SIZE:
        minBytesNeeded = kVersionPacketLen + kTagPacketLen + kSizePacketLenMin
        break
      case MCS_TAG_AND_SIZE:
        minBytesNeeded = kTagPacketLen + kSizePacketLenMin
        break
      case MCS_SIZE:
        minBytesNeeded = this._sizePacketSoFar + 1
        break
      case MCS_PROTO_BYTES:
        minBytesNeeded = this._messageSize
        break
      default:
        this._emitError(new Error(`Unexpected state: ${this._state}`))
        return
    }

    if (this._data.length < minBytesNeeded) {
      // TODO(ibash) set a timeout and check for socket disconnect
      DEBUG(
        `Socket read finished prematurely. Waiting for ${minBytesNeeded
          - this._data.length} more bytes`,
      )
      this._isWaitingForData = true
      return
    }

    DEBUG(`Processing MCS data: state == ${this._state}`)

    switch (this._state) {
      case MCS_VERSION_TAG_AND_SIZE:
        this._onGotVersion()
        break
      case MCS_TAG_AND_SIZE:
        this._onGotMessageTag()
        break
      case MCS_SIZE:
        this._onGotMessageSize()
        break
      case MCS_PROTO_BYTES:
        this._onGotMessageBytes()
        break
      default:
        this._emitError(new Error(`Unexpected state: ${this._state}`))
    }
  }

  _onGotVersion() {
    const version = this._data.readInt8(0)
    this._data = this._data.slice(1)
    DEBUG(`VERSION IS ${version}`)

    if (version < kMCSVersion && version !== 38) {
      this._emitError(new Error(`Got wrong version: ${version}`))
      return
    }

    // Process the LoginResponse message tag.
    this._onGotMessageTag()
  }

  _onGotMessageTag() {
    this._messageTag = this._data.readInt8(0)
    this._data = this._data.slice(1)
    DEBUG(`RECEIVED PROTO OF TYPE ${this._messageTag}`)

    this._onGotMessageSize()
  }

  _onGotMessageSize() {
    let incompleteSizePacket = false
    const reader = new BufferReader(this._data)

    try {
      this._messageSize = reader.int32()
    } catch (error) {
      if (error.message.startsWith('index out of range:')) {
        incompleteSizePacket = true
      } else {
        this._emitError(error)
        return
      }
    }

    // TODO(ibash) in chromium code there is an extra check here of:
    // if prev_byte_count >= kSizePacketLenMax then something else went wrong
    // NOTE(ibash) I could only test this case by manually cutting the buffer
    // above to be mid-packet like: new BufferReader(this._data.slice(0, 1))
    if (incompleteSizePacket) {
      this._sizePacketSoFar = reader.pos
      this._state = MCS_SIZE
      this._waitForData()
      return
    }

    this._data = this._data.slice(reader.pos)

    DEBUG(`Proto size: ${this._messageSize}`)
    this._sizePacketSoFar = 0

    if (this._messageSize > 0) {
      this._state = MCS_PROTO_BYTES
      this._waitForData()
    } else {
      this._onGotMessageBytes()
    }
  }

  _onGotMessageBytes() {
    const protobuf = this._buildProtobufFromTag(this._messageTag)
    if (!protobuf) {
      this._emitError(new Error('Unknown tag'))
      return
    }

    // Messages with no content are valid; just use the default protobuf for
    // that tag.
    if (this._messageSize === 0) {
      this.emit('message', { tag: this._messageTag, object: {} })
      this._getNextMessage()
      return
    }

    if (this._data.length < this._messageSize) {
      // Continue reading data.
      DEBUG(
        `Continuing data read. Buffer size is ${this._data.length}, expecting ${
          this._messageSize
        }`,
      )
      this._state = MCS_PROTO_BYTES
      this._waitForData()
      return
    }

    const buffer = this._data.slice(0, this._messageSize)
    this._data = this._data.slice(this._messageSize)
    const message = protobuf.decode(buffer)
    const object = protobuf.toObject(message, {
      longs: String,
      enums: String,
      bytes: Buffer,
    })

    this.emit('message', { tag: this._messageTag, object })

    if (this._messageTag === kLoginResponseTag) {
      if (this._handshakeComplete) {
        console.error('Unexpected login response')
      } else {
        this._handshakeComplete = true
        DEBUG('GCM Handshake complete.')
      }
    }

    this._getNextMessage()
  }

  _getNextMessage() {
    this._messageTag = 0
    this._messageSize = 0
    this._state = MCS_TAG_AND_SIZE
    this._waitForData()
  }

  _buildProtobufFromTag(tag: number) {
    switch (tag) {
      case kHeartbeatPingTag:
        return mcs_proto.HeartbeatPing
      case kHeartbeatAckTag:
        return mcs_proto.HeartbeatAck
      case kLoginRequestTag:
        return mcs_proto.LoginRequest
      case kLoginResponseTag:
        return mcs_proto.LoginResponse
      case kCloseTag:
        return mcs_proto.Close
      case kIqStanzaTag:
        return mcs_proto.IqStanza
      case kDataMessageStanzaTag:
        return mcs_proto.DataMessageStanza
      case kStreamErrorStanzaTag:
        return mcs_proto.StreamErrorStanza
      default:
        return null
    }
  }
}