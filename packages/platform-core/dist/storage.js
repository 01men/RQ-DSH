import { copyFile, mkdir, readdir, readFile, rename, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
class CollectionImpl {
  records = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  uniques = [];
  name;
  persist;
  constructor(name, persist) {
    this.name = name;
    this.persist = persist;
  }
  uniqueOn(label, keyOf) {
    if (this.uniques.some((unique) => unique.label === label)) return;
    this.uniques.push({ label, keyOf });
  }
  /** 校验唯一约束：返回既有冲突记录（不含自身）。 */
  conflictOf(record, selfId) {
    for (const unique of this.uniques) {
      const key = unique.keyOf(record);
      if (key === "" || key === void 0) continue;
      for (const other of this.records.values()) {
        if (selfId !== void 0 && other.id === selfId) continue;
        if (unique.keyOf(other) === key) return { label: unique.label, existing: other };
      }
    }
    return void 0;
  }
  all() {
    return [...this.records.values()];
  }
  get(id) {
    return this.records.get(id);
  }
  find(pred) {
    return this.all().filter(pred);
  }
  findOne(pred) {
    for (const record of this.records.values()) {
      if (pred(record)) return record;
    }
    return void 0;
  }
  insert(data) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const record = { createdAt: now, updatedAt: now, ...data, updatedAt: now };
    if (this.records.has(record.id)) throw new Error(`[storage] \u96C6\u5408 ${this.name} \u4E2D\u5DF2\u5B58\u5728 id=${record.id}`);
    const conflict = this.conflictOf(record);
    if (conflict) throw new Error(`[storage] \u552F\u4E00\u7EA6\u675F\u51B2\u7A81\uFF08${conflict.label}\uFF09\uFF1A\u4E0E\u65E2\u6709\u8BB0\u5F55 ${conflict.existing.id} \u91CD\u590D`);
    this.records.set(record.id, record);
    this.emit({ kind: "insert", record });
    this.persist(this.name);
    return structuredClone(record);
  }
  update(id, patch) {
    const current = this.records.get(id);
    if (!current) throw new Error(`[storage] \u96C6\u5408 ${this.name} \u4E2D\u4E0D\u5B58\u5728 id=${id}`);
    const next = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
    const conflict = this.conflictOf(next, id);
    if (conflict) throw new Error(`[storage] \u552F\u4E00\u7EA6\u675F\u51B2\u7A81\uFF08${conflict.label}\uFF09\uFF1A\u4E0E\u65E2\u6709\u8BB0\u5F55 ${conflict.existing.id} \u91CD\u590D`);
    this.records.set(id, next);
    this.emit({ kind: "update", record: next });
    this.persist(this.name);
    return structuredClone(next);
  }
  remove(id) {
    const existed = this.records.delete(id);
    if (existed) {
      this.emit({ kind: "remove", record: { id } });
      this.persist(this.name);
    }
    return existed;
  }
  replaceAll(records) {
    this.records.clear();
    for (const record of records) this.records.set(record.id, record);
    this.persist(this.name);
    this.emit({ kind: "replace", record: {} });
  }
  /** 恢复磁盘数据（仅启动期调用）。 */
  loadFrom(records) {
    this.records.clear();
    for (const record of records) this.records.set(record.id, record);
  }
  count() {
    return this.records.size;
  }
  onChange(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(change) {
    for (const cb of this.listeners) {
      try {
        cb(change);
      } catch (error) {
        console.error(`[storage] ${this.name} \u53D8\u66F4\u76D1\u542C\u5668\u5F02\u5E38`, error);
      }
    }
  }
}
class StorageService extends Service {
  static provide = "opsStorage";
  collections = /* @__PURE__ */ new Map();
  durableNames = /* @__PURE__ */ new Set();
  dirty = /* @__PURE__ */ new Set();
  flushTimer;
  /** 落盘串行链（并发 flushNow 排队执行，避免同名 tmp 竞争）。 */
  flushChain = Promise.resolve();
  tmpSeq = 0;
  /** 恢复期发现的损坏文件（坏 JSON 已备份为 *.corrupt，启动日志有痕）。 */
  corruptFiles = [];
  /** 数据目录（密钥等平台级文件的存放处）。 */
  dataDirPath;
  constructor(ctx, config = {}) {
    super(ctx, "opsStorage");
    this.dataDirPath = config.dataDir ?? join(process.cwd(), "data");
    ctx.effect(() => () => {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      void this.flushNow();
    });
    this.installSignalFlush();
  }
  /**
   * 信号落盘钩子（form B 数据安全）：form A 的 main.ts 自带 SIGTERM/SIGINT → flushNow，
   * 但挂载进 dsh 宿主后（loader 装配）没有等价钩子——防抖窗口内的写会在进程被
   * SIGTERM（launchd kickstart / pkill）时丢失，且 SQLite（即时写）与 JSON 集合
   * （防抖写）不同步会造成「半套数据」启动态。基础层自装一次（跨形态生效）；
   * 双注册无害（form A main.ts 的处理器并存：flushChain 串行 + exit 幂等）。
   */
  installSignalFlush() {
    const proc = process;
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const guard = `__rqStorageFlushInstalled_${signal}`;
      if (proc[guard] === true) continue;
      proc[guard] = true;
      process.on(signal, () => {
        void this.flushNow().finally(() => process.exit(0));
      });
    }
  }
  async start() {
    await mkdir(this.dataDirPath, { recursive: true });
  }
  collection(name, options = {}) {
    if (options.durability === "durable") this.durableNames.add(name);
    const existing = this.collections.get(name);
    if (existing) return existing;
    const created = new CollectionImpl(name, (n) => this.onPersist(n));
    this.collections.set(name, created);
    return created;
  }
  onPersist(name) {
    if (this.durableNames.has(name)) {
      this.dirty.add(name);
      void this.flushNow();
      return;
    }
    this.markDirty(name);
  }
  /** 启动期从磁盘恢复指定集合（幂等）。坏 JSON 备份为 *.corrupt 后从空集合开始（不再静默清空）。 */
  async restore(name) {
    await mkdir(this.dataDirPath, { recursive: true });
    const collection = this.collection(name);
    const file = join(this.dataDirPath, `${fileNameOf(name)}.json`);
    let records = [];
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        records = [];
      } else {
        records = parsed;
      }
    } catch (error) {
      const code = error.code;
      if (code === "ENOENT") {
        records = [];
      } else {
        const backup = `${file}.corrupt-${Date.now()}`;
        try {
          await copyFile(file, backup);
        } catch {
        }
        console.error(`[storage] \u96C6\u5408 ${name} \u6587\u4EF6\u635F\u574F\uFF08${error instanceof Error ? error.message : String(error)}\uFF09\uFF0C\u5DF2\u5907\u4EFD\u81F3 ${backup}\uFF0C\u4ECE\u7A7A\u96C6\u5408\u6062\u590D`);
        this.corruptFiles.push(backup);
        records = [];
      }
    }
    ;
    collection.loadFrom(records);
    return collection;
  }
  /** 扫描数据目录并恢复全部集合（业务插件加载前调用一次）。 */
  async restoreAll() {
    await mkdir(this.dataDirPath, { recursive: true });
    const restored = [];
    let files = [];
    try {
      files = (await readdir(this.dataDirPath)).filter((file) => file.endsWith(".json"));
    } catch {
      return restored;
    }
    for (const file of files) {
      const name = decodeFileName(file.slice(0, -5));
      try {
        await this.restore(name);
        restored.push(name);
      } catch (error) {
        console.error(`[storage] \u6062\u590D\u96C6\u5408 ${name} \u5931\u8D25`, error);
      }
    }
    return restored;
  }
  /** 已恢复/创建的集合名列表（供平台信息展示）。 */
  names() {
    return [...this.collections.keys()];
  }
  markDirty(name) {
    this.dirty.add(name);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = void 0;
      void this.flushNow();
    }, 250);
  }
  /** 立即将脏集合落盘（原子写：tmp + fsync + rename；全程串行防并发写同名 tmp）。 */
  flushNow() {
    this.flushChain = this.flushChain.then(() => this.doFlush());
    return this.flushChain;
  }
  async doFlush() {
    for (; ; ) {
      const names = [...this.dirty];
      this.dirty.clear();
      if (names.length === 0) return;
      for (const name of names) {
        const collection = this.collections.get(name);
        if (!collection) continue;
        const file = join(this.dataDirPath, `${fileNameOf(name)}.json`);
        const tmp = `${file}.${process.pid}-${Date.now()}-${++this.tmpSeq}.tmp`;
        try {
          await mkdir(dirname(file), { recursive: true });
          const handle = await open(tmp, "w");
          try {
            await handle.writeFile(JSON.stringify(collection.all(), null, 2), "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(tmp, file);
        } catch (error) {
          console.error(`[storage] \u96C6\u5408 ${name} \u843D\u76D8\u5931\u8D25`, error);
        }
      }
    }
  }
  /**
   * 全量强持久化：把所有已注册集合写入并 fsync（HTTP 响应前调用，
   * 确保「返回 200 后进程被杀」不丢变更——评审崩溃恢复实验的修复点）。
   */
  async flushDurable() {
    for (const name of this.collections.keys()) this.dirty.add(name);
    await this.flushNow();
  }
}
function fileNameOf(name) {
  return name.replace(/[:*?"<>|]/g, "~");
}
function decodeFileName(name) {
  return name.replace(/~/g, ":");
}
export {
  StorageService
};
