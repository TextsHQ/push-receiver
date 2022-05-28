import Long from 'long'
import { promisify } from 'util'
import crypto from 'crypto'
import { setTimeout } from 'timers/promises'
import request from 'request-promise'

import constants from './constants'
import { checkin_proto } from './protos/checkin'
import type { AppInfo, ClientInfo, RegisterOptions, RegisterResult } from './types'

const { kChromeVersion } = constants

const REGISTER_URL = 'https://android.clients.google.com/c2dm/register3'
const CHECKIN_URL = 'https://android.clients.google.com/checkin'
const ERR_PREFIX = 'Error='
const TOK_PREFIX = 'token='

const randomBytes = promisify(crypto.randomBytes)

// takes in client info (or null), returns refreshed client info
export async function checkIn(lastClientInfo: ClientInfo | null) {
  const { androidId = null, securityToken = null } = lastClientInfo || {}
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
  const body = await request({
    url: CHECKIN_URL,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-protobuf',
    },
    body: buffer,
    encoding: null,
  })
  const message = checkin_proto.AndroidCheckinResponse.decode(body)
  return {
    androidId: message.androidId.toString(),
    securityToken: message.securityToken.toString(),
  }
}

async function createInstanceId() {
  // 8 random bytes, but first nibble is 0x7
  const instanceIdBuf = await randomBytes(8)
  instanceIdBuf[0] &= 0x0f
  instanceIdBuf[0] |= 0x70
  return instanceIdBuf.toString('base64url')
}

async function _register(
  { androidId, securityToken }: ClientInfo,
  authorizedEntity: string,
  shouldDelete: boolean,
  options: RegisterOptions
): Promise<RegisterResult> {
  const appId = options.app?.appId || crypto.randomUUID()

  const reqOptions = {
    url: REGISTER_URL,
    method: 'POST',
    headers: {
      Authorization: `AidLogin ${androidId}:${securityToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    form: {
      scope: 'GCM',
      'X-scope': 'GCM',
      sender: authorizedEntity,
      gmsv: kChromeVersion.split('.')[0], // major chrome version
      app: 'org.chromium.linux',
      'X-subtype': appId,
      device: androidId,
    } as Record<string, string>,
  }

  let expiry: Date = null
  if (shouldDelete) {
    reqOptions.form.delete = 'true'
  }
  if (options.expiry) {
    reqOptions.form.ttl = ((options.expiry.getTime() - Date.now()) / 1000).toString()
    expiry = options.expiry
  }

  let instanceId: string
  let response: string
  const MAX_ATTEMPTS = 5
  for (let attempt = 0; attempt < MAX_ATTEMPTS; ++attempt) {
    instanceId = options.app?.instanceId || await createInstanceId();
    reqOptions.form.appid = instanceId
    response = await request(reqOptions)
    const errIdx = response.indexOf(ERR_PREFIX)
    if (errIdx === -1) break
    const err = response.substring(errIdx + ERR_PREFIX.length)
    if (attempt === MAX_ATTEMPTS - 1) {
      throw new Error(`GCM registration failed: ${err}`)
    } else {
      console.warn(`Retry ${attempt + 1}; ${shouldDelete ? 'Unregister' : 'Register'} request failed with: ${err}`)
      await setTimeout(1000)
    }
  }

  const tokIdx = response.indexOf(TOK_PREFIX)
  if (tokIdx === -1) throw new Error('GCM registration did not return a token')
  const token = response.substring(tokIdx + TOK_PREFIX.length)
  return { token, app: { appId, instanceId }, expiry }
}

export async function register(
  clientInfo: ClientInfo,
  authorizedEntity: string,
  options: RegisterOptions = {}
): Promise<RegisterResult> {
  return _register(clientInfo, authorizedEntity, false, options)
}

export async function unregister(
  clientInfo: ClientInfo,
  authorizedEntity: string,
  app: AppInfo
) {
  await _register(clientInfo, authorizedEntity, true, { app })
}
