import path from 'path'
import protobuf from 'protobufjs'
import Long from 'long'
import { promisify } from 'util'
import { randomBytes } from 'crypto'
import uuidv4 from 'uuid/v4'
import { setTimeout as waitFor } from 'timers/promises'

import constants from './constants'
import request from './utils/request'
import { toBase64 } from './utils/base64'

const { kChromeVersion, kDefaultTTL } = constants

// Hack to fix PHONE_REGISTRATION_ERROR #17 when bundled with webpack
// https://github.com/dcodeIO/protobuf.js#browserify-integration
protobuf.util.Long = Long
protobuf.configure()

const REGISTER_URL = 'https://android.clients.google.com/c2dm/register3'
const CHECKIN_URL = 'https://android.clients.google.com/checkin'

let root
let AndroidCheckinResponse

async function createInstanceId() {
  // 8 random bytes, but first nibble is 0x7
  const instanceIdBuf = await promisify(randomBytes)(8)
  instanceIdBuf[0] &= 0x0f
  instanceIdBuf[0] |= 0x70
  return toBase64(instanceIdBuf)
}

function createAppId(type) {
  if (type === 'android') {
    return `com.texts.push-app.${uuidv4()}`
  } if (type === 'web') {
    return `wp:texts.com#${uuidv4().slice(0, -3)}-V2`
  }
  throw new Error('unknown token type')
}

async function loadProtoFile() {
  if (root) {
    return
  }
  root = await protobuf.load(path.join(__dirname, 'protos/checkin.proto'))
  return root
}

function getCheckinRequest(androidId, securityToken) {
  const AndroidCheckinRequest = root.lookupType(
    'checkin_proto.AndroidCheckinRequest',
  )
  AndroidCheckinResponse = root.lookupType(
    'checkin_proto.AndroidCheckinResponse',
  )
  const payload = {
    userSerialNumber: 0,
    checkin: {
      type: 3,
      chromeBuild: {
        platform: 2,
        chromeVersion: kChromeVersion,
        channel: 1,
      },
    },
    version: 3,
    id: androidId ? Long.fromString(androidId) : undefined,
    securityToken: securityToken
      ? Long.fromString(securityToken, true)
      : undefined,
  }
  const errMsg = AndroidCheckinRequest.verify(payload)
  if (errMsg) throw Error(errMsg)
  const message = AndroidCheckinRequest.create(payload)
  return AndroidCheckinRequest.encode(message).finish()
}

// takes in client info (or null), returns refreshed client info
export async function checkIn(lastClientInfo) {
  const { androidId = null, securityToken = null } = lastClientInfo || {}
  await loadProtoFile()
  const buffer = getCheckinRequest(androidId, securityToken)
  const body = await request({
    url: CHECKIN_URL,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-protobuf',
    },
    body: buffer,
    encoding: null,
  })
  const message = AndroidCheckinResponse.decode(body)
  const object = AndroidCheckinResponse.toObject(message, {
    longs: String,
    enums: String,
    bytes: String,
  })
  return {
    androidId: object.androidId,
    securityToken: object.securityToken,
  }
}

export async function register(
  { androidId, securityToken },
  type,
  authorizedEntity,
  options,
) {
  const appId = typeof options.appId === 'string' ? options.appId : createAppId(type)
  const ttl = typeof options.ttl === 'number' ? options.ttl : kDefaultTTL
  const expiry = ttl === 0 ? null : new Date(Date.now() + ttl * 1000)

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
      appid: '',
      gmsv: kChromeVersion.split('.')[0], // major chrome version
      app: 'com.texts.push',
      'X-subtype': appId,
      device: androidId,
      ...(ttl === 0 ? {} : {
        ttl: ttl.toString(),
      }),
    },
  }

  let instanceId
  let response = null
  const MAX_ATTEMPTS = 5
  for (let attempt = 0; attempt < MAX_ATTEMPTS; ++attempt) {
    instanceId = typeof options.instanceId === 'string' ? options.instanceId : await createInstanceId()
    reqOptions.form.appid = instanceId
    const _response = await request(reqOptions)
    if (_response.includes('Error')) {
      console.warn(`Register request has failed with ${_response}`)
      if (attempt !== MAX_ATTEMPTS - 1) {
        console.warn(`Retry... ${attempt + 1}`)
        await waitFor(1000)
      }
    } else {
      response = _response
      break
    }
  }

  const token = response.split('token=')[1]
  return {
    token: type === 'android' ? token : `https://fcm.googleapis.com/fcm/send/${token}`,
    appId,
    instanceId,
    expiry,
  }
}
