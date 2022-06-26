import { readFile, writeFile } from 'fs/promises'
import type { ClientInfo, MCSDataStore, CheckinDataStore } from './types'

const symbol = Symbol('FileStore')

export default class FileStore implements MCSDataStore, CheckinDataStore {
  private data: {
    clientInfo: ClientInfo
    persistentIds: Set<string>
  }

  private isSaving = false

  private constructor(sym: symbol, readonly _path: string) {
    if (sym !== symbol) {
      throw new Error('FileStore must be created with FileStore.create')
    }
  }

  private async init() {
    try {
      const file = await readFile(this._path)
      const json = JSON.parse(file.toString())
      this.data = {
        clientInfo: json.clientInfo,
        persistentIds: new Set(json.persistentIds),
      }
    } catch (e) {
      this.data = {
        clientInfo: null,
        persistentIds: new Set(),
      }
    }
  }

  private async save() {
    const json = {
      clientInfo: this.data.clientInfo,
      persistentIds: [...this.data.persistentIds],
    }
    const str = JSON.stringify(json)
    await writeFile(this._path, str)
  }

  private setNeedsSave() {
    // TODO: debounce
    if (this.isSaving) return
    this.isSaving = true;
    (async () => {
      await this.save()
      this.isSaving = false
    })()
  }

  get clientInfo() {
    return this.data.clientInfo
  }

  set clientInfo(newValue) {
    this.data.clientInfo = newValue
    this.setNeedsSave()
  }

  allPersistentIds() {
    return this.data.persistentIds
  }

  clearPersistentIds() {
    this.data.persistentIds.clear()
    this.setNeedsSave()
  }

  hasPersistentId(id: string) {
    return this.data.persistentIds.has(id)
  }

  addPersistentId(id: string) {
    this.data.persistentIds.add(id)
    this.setNeedsSave()
  }

  static async create(path: string) {
    const store = new FileStore(symbol, path)
    await store.init()
    return store
  }
}
