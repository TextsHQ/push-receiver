import Long from 'long'

import constants from './constants'
import { checkin_proto } from './protos/checkin'
import type { CheckinClientOptions, ClientInfo, CheckinDataStore } from './types'

const {
  kChromeVersion,
  kMinimumCheckinInterval,
  kDefaultCheckinInterval,
} = constants

const CHECKIN_URL = 'https://android.clients.google.com/checkin'

export default class CheckinClient {
  private interval: number

  private initPromise: Promise<void>

  private latestClientInfo: ClientInfo | null = null

  constructor(private dataStore: CheckinDataStore, options: CheckinClientOptions = {}) {
    this.interval = typeof options.checkInInterval === 'number'
      ? Math.max(options.checkInInterval, kMinimumCheckinInterval)
      : kDefaultCheckinInterval

    this.initPromise = this.init()
  }

  private async init() {
    const checkInHandle = setInterval(() => {
      this.doCheckin()
    }, this.interval * 1000)
    checkInHandle.unref()
    await this.doCheckin()
  }

  private async doCheckin() {
    const { androidId = null, securityToken = null } = this.dataStore.clientInfo || {}
    const payload = new checkin_proto.AndroidCheckinRequest({
      userSerialNumber: 0,
      checkin: {
        type: checkin_proto.DeviceType.DEVICE_CHROME_BROWSER,
        chromeBuild: {
          platform: checkin_proto.ChromeBuildProto.Platform.PLATFORM_LINUX,
          chromeVersion: kChromeVersion,
          channel: checkin_proto.ChromeBuildProto.Channel.CHANNEL_STABLE,
        },
      },
      version: 3,
      id: androidId ? Long.fromString(androidId) : undefined,
      securityToken: securityToken
        ? Long.fromString(securityToken, true)
        : undefined,
    })
    const buffer = checkin_proto.AndroidCheckinRequest.encode(payload).finish()

    const body = await fetch(CHECKIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf',
      },
      body: buffer,
    }).then(res => res.arrayBuffer())
    const message = checkin_proto.AndroidCheckinResponse.decode(Buffer.from(body))

    this.latestClientInfo = {
      androidId: message.androidId.toString(),
      securityToken: message.securityToken.toString(),
    }
    this.dataStore.clientInfo = this.latestClientInfo
  }

  async clientInfo(): Promise<ClientInfo> {
    await this.initPromise
    return this.latestClientInfo
  }
}
