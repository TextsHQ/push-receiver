import { promisify } from 'util'
import crypto from 'crypto'
import { setTimeout } from 'timers/promises'

import constants from './constants'
import type { AppInfo, GCMRegistrarOptions, RegisterOptions, RegisterResult } from './types'
import type CheckinClient from './checkin-client'

const { kChromeVersion } = constants

const REGISTER_URL = 'https://android.clients.google.com/c2dm/register3'
const ERR_PREFIX = 'Error='
const TOK_PREFIX = 'token='

const randomBytes = promisify(crypto.randomBytes)

async function createInstanceId() {
  // 8 random bytes, but first nibble is 0x7
  const instanceIdBuf = await randomBytes(8)
  instanceIdBuf[0] &= 0x0f
  instanceIdBuf[0] |= 0x70
  return instanceIdBuf.toString('base64url')
}

export default class GCMRegistrar {
  constructor(private checkinClient: CheckinClient, private options: GCMRegistrarOptions = {}) {}

  private async _register(
    authorizedEntity: string,
    shouldDelete: boolean,
    options: RegisterOptions,
  ): Promise<RegisterResult> {
    const { androidId, securityToken } = await this.checkinClient.clientInfo()

    const appId = options.app?.appId || crypto.randomUUID()

    const form: Record<string, string> = {
      scope: 'GCM',
      'X-scope': 'GCM',
      sender: authorizedEntity,
      gmsv: kChromeVersion.split('.')[0], // major chrome version
      app: 'org.chromium.linux',
      'X-subtype': appId,
      device: androidId,
    }

    const fetchOptions: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `AidLogin ${androidId}:${securityToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    }

    let expiry: Date = null
    if (shouldDelete) {
      form.delete = 'true'
    }
    if (options.expiry) {
      form.ttl = ((options.expiry.getTime() - Date.now()) / 1000).toString()
      expiry = options.expiry
    }

    let instanceId: string
    let response: string
    const MAX_ATTEMPTS = 5
    for (let attempt = 0; attempt < MAX_ATTEMPTS; ++attempt) {
      instanceId = options.app?.instanceId || await createInstanceId()
      form.appid = instanceId
      response = await fetch(REGISTER_URL, fetchOptions).then(res => res.text())
      const errIdx = response.indexOf(ERR_PREFIX)
      if (errIdx === -1) break
      const err = response.substring(errIdx + ERR_PREFIX.length)
      if (err === 'TOO_MANY_REGISTRATIONS' || attempt === MAX_ATTEMPTS - 1) {
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

  async register(
    authorizedEntity: string,
    options: RegisterOptions = {},
  ) {
    return this._register(authorizedEntity, false, options)
  }

  async unregister(
    authorizedEntity: string,
    app: AppInfo,
  ) {
    await this._register(authorizedEntity, true, { app })
  }
}
