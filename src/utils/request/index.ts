import request from 'request-promise'
import { setTimeout as waitFor } from 'timers/promises'

// In seconds
const MAX_RETRY_TIMEOUT = 15
// Step in seconds
const RETRY_STEP = 5

async function retry(retryCount = 0, ...args) {
  try {
    const result = await request(...args)
    return result
  } catch (e) {
    const timeout = Math.min(retryCount * RETRY_STEP, MAX_RETRY_TIMEOUT)
    console.error(`Request failed : ${e.message}`)
    console.error(`Retrying in ${timeout} seconds`)
    await waitFor(timeout * 1000)
    const result = await retry(retryCount + 1, ...args)
    return result
  }
}

export default function requestWithRety(...args) {
  return retry(0, ...args)
}
