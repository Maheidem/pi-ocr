/** pi-extension-builder JsonStore v0.1.0 — canonical source and vendored primitive. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface JsonStoreOptions<T extends object> {
  path: string;
  defaults: T;
  normalize(value: unknown, defaults: T): T;
}

/** Small synchronous JSON repository for user preferences. */
export class JsonStore<T extends object> {
  readonly path: string;
  private readonly defaultsValue: T;
  private readonly normalizeValue: JsonStoreOptions<T>["normalize"];

  constructor(options: JsonStoreOptions<T>) {
    this.path = options.path;
    this.defaultsValue = this.clone(options.defaults);
    this.normalizeValue = options.normalize;
  }

  defaults(): T {
    return this.clone(this.defaultsValue);
  }

  load(): T {
    if (!existsSync(this.path)) {
      const value = this.defaults();
      this.save(value);
      return value;
    }

    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      const value = this.normalizeValue(raw, this.defaults());
      if (JSON.stringify(raw) !== JSON.stringify(value)) this.save(value);
      return this.clone(value);
    } catch {
      this.preserveCorruptFile();
      const value = this.defaults();
      this.save(value);
      return value;
    }
  }

  save(value: T): T {
    const normalized = this.normalizeValue(value, this.defaults());
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporary, this.path);
    } catch (error) {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        // Best-effort cleanup; preserve the original error.
      }
      throw error;
    }
    return this.clone(normalized);
  }

  reset(): T {
    return this.save(this.defaults());
  }

  private preserveCorruptFile(): void {
    if (!existsSync(this.path)) return;
    const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
    try {
      renameSync(this.path, `${this.path}.corrupt-${stamp}`);
    } catch {
      // If preservation fails, save() will atomically replace the bad file.
    }
  }

  private clone(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
