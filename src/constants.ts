export default {
  // # of bytes a MCS version packet consumes.
  kVersionPacketLen: 1,
  // # of bytes a tag packet consumes.
  kTagPacketLen: 1,
  // Max # of bytes a length packet consumes. A Varint32 can consume up to 5 bytes
  // (the msb in each byte is reserved for denoting whether more bytes follow).
  // Although the protocol only allows for 4KiB payloads currently, and the socket
  // stream buffer is only of size 8KiB, it's possible for certain applications to
  // have larger message sizes. When payload is larger than 4KiB, an temporary
  // in-memory buffer is used instead of the normal in-place socket stream buffer.
  kSizePacketLenMin: 1,
  kSizePacketLenMax: 5,

  // The current MCS protocol version.
  kMCSVersion: 41,

  kMCSCategory: 'com.google.android.gsf.gtalkservice',
  kGCMFromField: 'gcm@android.com',
  kIdleNotification: 'IdleNotification',

  kChromeVersion: '101.0.4951.64',

  // 2 days
  kDefaultCheckinInterval: 2 * 24 * 60 * 60,
  // 12 hours
  kMinimumCheckinInterval: 12 * 60 * 60,

  // 10 minutes
  kDefaultHeartbeatInterval: 10 * 60,

  kMaxUnackedIds: 10,
}
