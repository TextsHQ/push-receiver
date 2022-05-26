import { readFile, writeFile } from 'fs/promises'
import type { DataStore } from './types'

const symbol = Symbol('FileStore')

export default class FileStore implements DataStore {
  private _data: {
    clientInfo: any
    persistentIds: Set<string>
  }

  private constructor(sym: symbol, readonly _path: string) {
    if (sym !== symbol) {
      throw new Error('FileStore must be created with FileStore.create')
    }
  }

  async _init() {
    try {
      const file = await readFile(this._path)
      const json = JSON.parse(file.toString())
      this._data = {
        clientInfo: json.clientInfo,
        persistentIds: new Set(json.persistentIds),
      }
    } catch (e) {
      this._data = {
        clientInfo: null,
        persistentIds: new Set(),
      }
    }
  }

  async _save() {
    const json = {
      clientInfo: this._data.clientInfo,
      persistentIds: [...this._data.persistentIds],
    }
    const str = JSON.stringify(json)
    await writeFile(this._path, str)
  }

  _setNeedsSave() {
    // TODO: debounce
    this._save()
  }

  get clientInfo() {
    return this._data.clientInfo
  }

  set clientInfo(newValue) {
    this._data.clientInfo = newValue
    this._setNeedsSave()
  }

  allPersistentIds() {
    return [...this._data.persistentIds]
  }

  clearPersistentIds() {
    this._data.persistentIds.clear()
    this._setNeedsSave()
  }

  hasPersistentId(id) {
    return this._data.persistentIds.has(id)
  }

  addPersistentId(id) {
    this._data.persistentIds.add(id)
    this._setNeedsSave()
  }

  static async create(path) {
    const store = new FileStore(symbol, path)
    await store._init()
    return store
  }
}
