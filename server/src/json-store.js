import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '..', 'data'));

export class JsonStore {
  #file;
  #data;

  constructor(name) {
    mkdirSync(DATA_DIR, { recursive: true });
    this.#file = path.join(DATA_DIR, `${name}.json`);
    this.#data = this.#read();
  }

  #read() {
    try {
      return JSON.parse(readFileSync(this.#file, 'utf8'));
    } catch {
      return {};
    }
  }

  #write() {
    const tmp = this.#file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
    renameSync(tmp, this.#file);
  }

  get(key) {
    return this.#data[key] ?? null;
  }

  getAll() {
    return this.#data;
  }

  set(key, value) {
    this.#data[key] = value;
    this.#write();
  }

  delete(key) {
    delete this.#data[key];
    this.#write();
  }

  has(key) {
    return key in this.#data;
  }

  reload() {
    this.#data = this.#read();
  }
}

export class JsonArrayStore {
  #file;
  #data;

  constructor(name) {
    mkdirSync(DATA_DIR, { recursive: true });
    this.#file = path.join(DATA_DIR, `${name}.json`);
    this.#data = this.#read();
  }

  #read() {
    try {
      return JSON.parse(readFileSync(this.#file, 'utf8'));
    } catch {
      return [];
    }
  }

  #write() {
    const tmp = this.#file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
    renameSync(tmp, this.#file);
  }

  getAll() {
    return this.#data;
  }

  getById(id) {
    return this.#data.find((item) => item.id === id) ?? null;
  }

  filter(predicate) {
    return this.#data.filter(predicate);
  }

  add(item) {
    const maxId = this.#data.reduce((max, item) => Math.max(max, item.id || 0), 0);
    const newItem = { ...item, id: maxId + 1 };
    this.#data.push(newItem);
    this.#write();
    return newItem;
  }

  update(predicate, updates) {
    const idx = this.#data.findIndex(predicate);
    if (idx === -1) return null;
    this.#data[idx] = { ...this.#data[idx], ...updates };
    this.#write();
    return this.#data[idx];
  }

  delete(predicate) {
    const idx = this.#data.findIndex(predicate);
    if (idx === -1) return false;
    this.#data.splice(idx, 1);
    this.#write();
    return true;
  }

  reload() {
    this.#data = this.#read();
  }
}
